/**
 * Client for the vosko-dub-bridge WordPress plugin (runs, identities, OTP).
 */

import { requestJson } from './http.mjs';

const BASE = (process.env.VDB_BASE_URL || 'https://aiwithmase.ir/wp-json/vosko-dub/v1').replace(/\/$/, '');
const KEY = process.env.VDB_KEY || '';

function api(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  if (!KEY) throw new Error('VDB_KEY is not set');
  // The bridge is our own WordPress box: never spend residential proxy
  // bandwidth on it, and never hide the runner from our own logs.
  return requestJson(BASE + path, {
    method,
    body,
    timeoutMs,
    direct: true,
    headers: { 'x-vdb-key': KEY, accept: 'application/json' },
  });
}

export function configured() {
  return Boolean(KEY);
}

export function createRun({ videoUrl, sourceLang, targetLang, chunkTotal, meta }) {
  return api('/runs', {
    method: 'POST',
    body: {
      video_url: videoUrl,
      source_lang: sourceLang,
      target_lang: targetLang,
      chunk_total: chunkTotal,
      meta: meta || {},
    },
  });
}

export function updateRun(id, fields) {
  return api(`/runs/${id}`, { method: 'PATCH', body: fields });
}

export function mintIdentity(runId, chunkIndex) {
  return api(`/runs/${runId}/identities`, { method: 'POST', body: { chunk_index: chunkIndex } });
}

export function updateIdentity(id, fields) {
  return api(`/identities/${id}`, { method: 'PATCH', body: fields });
}

/**
 * Poll the mailbox until a verification code shows up.
 * @returns {Promise<{code:string,message_id:number,subject:string,sender:string,source:string}>}
 */
export async function waitForCode(email, { afterId = 0, waitSeconds = 50 } = {}) {
  const url = `/codes?email=${encodeURIComponent(email)}&after_id=${afterId}&wait=${waitSeconds}`;
  const data = await api(url, { timeoutMs: (waitSeconds + 20) * 1000 });
  if (!data || !data.code) {
    throw new Error(`no code returned for ${email}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

/** Baseline cursor before requesting a fresh code, so an old code is never reused. */
export async function currentCursor(email) {
  const data = await api(`/codes?email=${encodeURIComponent(email)}&limit=1&include_body=0`);
  return Number(data.cursor || 0);
}
