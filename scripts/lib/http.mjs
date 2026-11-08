/**
 * Minimal JSON HTTP helper with timeouts and readable errors.
 */

export class HttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  init.signal = AbortSignal.timeout(timeoutMs);

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new HttpError(`${method} ${url} failed: ${err.message}`, { url });
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new HttpError(`${method} ${url} -> HTTP ${res.status}: ${text.slice(0, 400)}`, {
      status: res.status,
      body: json,
      url,
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
