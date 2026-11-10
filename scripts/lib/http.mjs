/**
 * Minimal JSON HTTP helper with timeouts and readable errors.
 *
 * Requests are tunnelled through an HTTP CONNECT proxy only when one is set in
 * the current async context (`withProxy`). Everything else — OSS uploads, mp3
 * downloads, bridge calls — goes out directly, so residential proxy bandwidth
 * is not spent on media.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { AsyncLocalStorage } from 'node:async_hooks';

export class HttpError extends Error {
  constructor(message, { status, body, url, retryAfterMs } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
    // The API returns its own error code in the body (10001 bad parameters,
    // 20019/20020 bad or expired code, 20030 throttled, 20031 fingerprint
    // required) even when the HTTP status is a generic 400. Surface it so the
    // callers can branch on it without re-parsing the message.
    const code = Number(body?.code);
    if (Number.isFinite(code)) this.code = code;
  }
}

/**
 * Proxy context. Each worker runs its dub inside `withProxy(proxy, fn)`, so
 * concurrent workers keep separate exit IPs without threading a parameter
 * through every API function.
 */
const proxyContext = new AsyncLocalStorage();

export function withProxy(proxy, fn) {
  if (!proxy) return fn();
  return proxyContext.run(proxy, fn);
}

export function activeProxy() {
  return proxyContext.getStore() || null;
}

/** Dial the proxy, ask it for a CONNECT tunnel and hand back the raw socket. */
function openTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => fail(new Error(`proxy ${proxy.host}:${proxy.port} timed out`)));
    socket.once('error', fail);
    socket.once('connect', () => {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`, 'utf8').toString('base64');
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\n`
          + `Host: ${host}:${port}\r\n`
          + `Proxy-Authorization: Basic ${auth}\r\n`
          + 'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });

    let head = '';
    const onData = (chunk) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 32 * 1024) fail(new Error('proxy sent an oversized CONNECT reply'));
        return;
      }
      socket.removeListener('data', onData);
      socket.setTimeout(0);
      const statusLine = head.slice(0, head.indexOf('\r\n'));
      const status = Number(statusLine.split(' ')[1]);
      if (status !== 200) {
        fail(new Error(`proxy CONNECT ${host}:${port} failed: ${statusLine}`));
        return;
      }
      settled = true;
      const extra = Buffer.from(head.slice(end + 4), 'latin1');
      if (extra.length) socket.unshift(extra);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

/**
 * Agent that replaces the TCP connect with a proxy tunnel. The TLS handshake
 * still happens here (Node would otherwise dial the target directly).
 *
 * The base class has to match the target protocol: an https.Agent refuses to
 * serve an http:// URL (ERR_INVALID_PROTOCOL), which matters for local/test
 * API endpoints reached through the proxy.
 */
function tunnelAgentClass(Base) {
  return class TunnelAgent extends Base {
    constructor(proxy, { isTls, host, timeoutMs }) {
      super({ keepAlive: false });
      this.proxy = proxy;
      this.isTls = isTls;
      this.targetHost = host;
      this.timeoutMs = timeoutMs;
    }

    createConnection(options, callback) {
      let settled = false;
      const done = (err, socket) => {
        if (settled) {
          if (socket) socket.destroy();
          return;
        }
        settled = true;
        callback(err, socket);
      };

      const port = options.port || (this.isTls ? 443 : 80);
      openTunnel(this.proxy, this.targetHost, port, this.timeoutMs)
        .then((raw) => {
          if (!this.isTls) {
            done(null, raw);
            return;
          }
          const secure = tls.connect({ socket: raw, servername: this.targetHost, ALPNProtocols: ['http/1.1'] });
          secure.once('secureConnect', () => done(null, secure));
          secure.once('error', (err) => done(err));
        })
        .catch((err) => done(err));
    }
  };
}

const TunnelHttpAgent = tunnelAgentClass(http.Agent);
const TunnelHttpsAgent = tunnelAgentClass(https.Agent);

/** Same contract as fetch(), but the TCP connection goes through the proxy. */
function proxiedRequest(url, { method, headers, body, timeoutMs, proxy }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isTls = target.protocol === 'https:';
    const mod = isTls ? https : http;
    const agent = new (isTls ? TunnelHttpsAgent : TunnelHttpAgent)(proxy, { isTls, host: target.hostname, timeoutMs });

    // Always announce the payload length. Without it Node falls back to
    // `transfer-encoding: chunked`, and the vosko.ai gateway answers such POSTs
    // with `400 {"code":10001,"msg":"invalid parameters"}` (the same request via
    // fetch() or curl - which send content-length - is accepted).
    const finalHeaders = { ...headers };
    if (body !== undefined) {
      finalHeaders['content-length'] = String(Buffer.byteLength(body));
      delete finalHeaders['transfer-encoding'];
    }

    const req = mod.request(
      {
        method,
        headers: finalHeaders,
        agent,
        host: target.hostname,
        port: target.port || (isTls ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        servername: isTls ? target.hostname : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );

    req.on('error', (err) => reject(new HttpError(`${method} ${url} failed: ${err.message}`, { url })));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function retryAfterMs(headers) {
  const raw = headers?.['retry-after'];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 60000, direct = false } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const finalHeaders = { ...headers };
  if (payload !== undefined) finalHeaders['content-type'] = 'application/json';

  const proxy = direct ? null : activeProxy();

  let status;
  let responseHeaders;
  let text;

  if (proxy) {
    // fetch() always sends a user-agent; the raw client must match it so the
    // site sees the same client it has always seen, just from another IP.
    const proxiedHeaders = { 'user-agent': 'undici', ...finalHeaders };
    ({ status, headers: responseHeaders, text } = await proxiedRequest(url, {
      method,
      headers: proxiedHeaders,
      body: payload,
      timeoutMs,
      proxy,
    }));
  } else {
    const init = { method, headers: finalHeaders, signal: AbortSignal.timeout(timeoutMs) };
    if (payload !== undefined) init.body = payload;

    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new HttpError(`${method} ${url} failed: ${err.message}`, { url });
    }
    status = res.status;
    responseHeaders = res.headers;
    text = await res.text();
  }

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!(status >= 200 && status < 300)) {
    throw new HttpError(`${method} ${url} -> HTTP ${status}: ${String(text).slice(0, 400)}`, {
      status,
      body: json,
      url,
      retryAfterMs: retryAfterMs(responseHeaders),
    });
  }

  return json;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retry(fn, { attempts = 3, delayMs = 2000, label = 'task' } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastError = err;
      if (i === attempts) break;
      console.warn(`[retry] ${label} attempt ${i}/${attempts} failed: ${err.message}`);
      await sleep(delayMs * i);
    }
  }
  throw lastError;
}
