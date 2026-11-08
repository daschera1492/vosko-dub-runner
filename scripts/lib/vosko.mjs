/**
 * vosko.ai API client: auth, credits, projects, OSS upload, translation polling.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { requestJson, sleep, retry } from './http.mjs';
import { mixSegmentAudio } from './media.mjs';

const API = (process.env.VOSKO_API || 'https://api.vosko.ai').replace(/\/$/, '');
const USER = '/user_center/api/v1';
const BILLING = '/billing_center/api/v1';
const VIDEO = '/video_translation/api/v1';

/**
 * Target languages handled by the "ultra" voice-clone pipeline. Anything else
 * must use "standard" — this is exactly how the live site picks the pipeline
 * (see the core-language list in its Nuxt bundle). Persian, for example, is a
 * Global language: sending it to ultra is what produced meaningless Persian.
 */
export const ULTRA_LANGUAGES = new Set([
  'Mandarin Chinese',
  'English',
  'Japanese',
  'Korean',
  'Spanish',
  'German',
  'French',
  'Portuguese',
  'Thai',
  'Indonesian',
  'Vietnamese',
  'Malay',
  'Filipino',
  'Italian',
  'Russian',
  'Dutch',
  'Polish',
  'Turkish',
  'Swedish',
]);

/** "auto" mirrors the site; VOSKO_PIPELINE can force a value for diagnostics. */
export function pipelineTypeFor(target) {
  const override = (process.env.VOSKO_PIPELINE || 'auto').toLowerCase();
  if (override === 'ultra' || override === 'standard') return override;
  const targets = String(target || '')
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
  return targets.length && targets.every((row) => ULTRA_LANGUAGES.has(row)) ? 'ultra' : 'standard';
}

/** The site switches a project to "long" above 6 minutes (single file only). */
export function videoTypeFor(duration) {
  return Number(duration) > 360 ? 'long' : 'short';
}

const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
};

/** The API wraps everything as {code,msg,data}; code 0 means success. */
async function call(pathname, { method = 'GET', body, token, timeoutMs = 60000 } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const json = await requestJson(API + pathname, { method, body, headers, timeoutMs });
  if (json && json.code !== 0) {
    const err = new Error(`${method} ${pathname} -> code ${json.code}: ${json.msg || 'unknown'}`);
    err.code = json.code;
    err.payload = json;
    throw err;
  }
  return json.data;
}

export function sendLoginCode(email) {
  return call(`${USER}/user/email/code`, {
    method: 'POST',
    body: { email, scene: 'login', language: 'en' },
  });
}

export async function loginWithCode(email, code) {
  const data = await call(`${USER}/user/login/email`, {
    method: 'POST',
    body: {
      email,
      code,
      channel: 'web',
      language: 'en',
      timezone: 'UTC',
      country_code: 'US',
    },
  });
  const token = data?.token;
  if (!token) throw new Error('login succeeded but no token in response');
  return { token, user: data.user || null };
}

export function userInfo(token) {
  return call(`${USER}/user/info`, { token });
}

export function credits(token) {
  return call(`${BILLING}/credits/account?product_id=1`, { token });
}

/** 200 free credits on a fresh account; harmless when already claimed. */
export async function claimGift(token) {
  try {
    return await call(`${BILLING}/credit/registration-gift?product_id=1`, { method: 'POST', token });
  } catch (err) {
    if (String(err.message).includes('already')) return { granted: false, already: true };
    throw err;
  }
}

export function createProject(token, { name, source, target, duration }) {
  return call(`${VIDEO}/projects`, {
    method: 'POST',
    token,
    body: {
      scene: 'Short Drama Video',
      project_name: name,
      original_language: source || 'Auto',
      target_language: target,
      subtitle_eraser: false,
      video_dubbing: true,
      auto_translate: false,
      tts_provider: 'mock',
      video_type: videoTypeFor(duration),
      pipeline_type: pipelineTypeFor(target),
    },
  });
}

export function getProject(token, projectId) {
  return call(`${VIDEO}/projects/${projectId}`, { token });
}

export function getItem(token, projectId, itemId) {
  return call(`${VIDEO}/projects/${projectId}/items/${itemId}`, { token });
}

/**
 * Standard-pipeline per-segment voice generation. The editor calls this for
 * every subtitle whose text changed (or whose audio is missing).
 */
export function submitSegmentTts(token, projectId, itemId, { voiceId, text, voiceIdType, startTime }) {
  return call(`${VIDEO}/projects/${projectId}/items/${itemId}/tts`, {
    method: 'POST',
    token,
    body: {
      voice_id: voiceId,
      text,
      voice_id_type: voiceIdType,
      start_time: startTime,
    },
  });
}

export function segmentTtsResult(token, taskId) {
  return call(`${VIDEO}/projects/items/tts/result`, { method: 'POST', token, body: { task_id: taskId } });
}

/** Poll one segment TTS task until it yields an audio URL. */
export async function waitForSegmentTts(token, taskId, { timeoutMs = 6 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await segmentTtsResult(token, taskId);
    const status = Number(data?.status);
    if (status === 3) {
      const audio = data?.result?.audio_url || '';
      if (!audio) throw new Error(`segment tts ${taskId} finished without audio_url`);
      return { audio, result: data.result };
    }
    if (status === 4 || status === -1 || status === -2) {
      throw new Error(`segment tts ${taskId} failed: ${data?.msg || status}`);
    }
    await sleep(2000);
  }
  throw new Error(`segment tts ${taskId} timed out`);
}

/** Start positions/audio of the translated subtitle segments (standard pipeline). */
export function segmentStart(seg) {
  return Number(seg?.translated_start_time_modified ?? seg?.translated_start_time ?? seg?.start_time) || 0;
}

export function segmentAudio(seg) {
  return seg?._pending_translated_audio_url || seg?.translated_audio_url || '';
}

export function getOssCredential(token, projectId) {
  return call(`${VIDEO}/projects/${projectId}/oss-sts`, { token });
}

function ossPut(credential, objectKey, filePath, contentType) {
  const host = `${credential.bucket}.${new URL(credential.endpoint).host}`;
  const date = new Date().toUTCString();
  const resource = `/${credential.bucket}/${objectKey}`;
  const toSign = ['PUT', '', contentType, date, `x-oss-security-token:${credential.security_token}`, resource].join('\n');
  const signature = crypto.createHmac('sha1', credential.access_key_secret).update(toSign).digest('base64');
  const url = `https://${host}/` + encodeURI(objectKey).replace(/%2F/g, '/');

  return fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `OSS ${credential.access_key_id}:${signature}`,
      'content-type': contentType,
      date,
      'x-oss-security-token': credential.security_token,
    },
    body: fs.readFileSync(filePath),
    signal: AbortSignal.timeout(600000),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`OSS upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.headers.get('x-oss-request-id');
  });
}

export function createItems(token, projectId, filenames) {
  return call(`${VIDEO}/projects/${projectId}/items/batch`, {
    method: 'POST',
    token,
    body: { filenames },
  });
}

export function listItems(token, projectId) {
  return call(`${VIDEO}/projects/${projectId}/items?page=1&page_size=100`, { token });
}

export function attachItem(token, projectId, item) {
  return call(`${VIDEO}/projects/${projectId}/items/batch`, {
    method: 'PUT',
    token,
    body: { items: [item] },
  });
}

export function updateProject(token, projectId, fields) {
  return call(`${VIDEO}/projects/${projectId}`, { method: 'PUT', token, body: fields });
}

export function startTranslation(token, projectId) {
  return call(`${VIDEO}/projects/${projectId}/video-translate`, { method: 'POST', token });
}

/**
 * Upload a local media file and register it as a project item.
 * @returns {Promise<{itemId:number, objectKey:string, duration:number|null}>}
 */
export async function uploadMedia(token, projectId, filePath, { duration = null, name } = {}) {
  const sts = await getOssCredential(token, projectId);
  const credential = sts?.credential || sts;
  if (!credential?.bucket) throw new Error(`oss-sts returned no credential: ${JSON.stringify(sts).slice(0, 200)}`);
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();
  const prefix = String(credential.object_key || '').replace(/\/$/, '');
  const objectKey = `${prefix}/${base}`;
  const contentType = MIME[ext] || 'application/octet-stream';
  const size = fs.statSync(filePath).size;
  const itemName = name || base.replace(/\.[^/.]+$/, '');

  console.log(`[vosko] uploading ${base} (${(size / 1024 / 1024).toFixed(2)} MiB)`);
  await ossPut(credential, objectKey, filePath, contentType);

  const created = await createItems(token, projectId, [itemName]);
  const okRow = (created?.succeeded || [])[0];
  if (!okRow) throw new Error(`item creation failed: ${JSON.stringify(created)}`);

  await attachItem(token, projectId, {
    item_id: okRow.item_id,
    original_video_url: objectKey,
    original_subtitle_url: '',
    original_video_size: size,
    original_video_duration: duration,
    status: 1,
  });

  return { itemId: okRow.item_id, objectKey, duration };
}

/**
 * Poll until the item carries dubbed audio. Returns the newest item row.
 */
export async function waitForResult(token, projectId, { timeoutMs = 30 * 60 * 1000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSignature = '';
  let lastSnapshot = null;

  while (Date.now() < deadline) {
    const project = await getProject(token, projectId);
    const items = await listItems(token, projectId);
    const rows = items?.list || [];
    const snapshot = {
      status: project?.status,
      items: rows.map((r) => ({
        id: r.item_id,
        status: r.status,
        error: r.error_msg || '',
        audio: translatedAudioUrl(r),
      })),
    };
    const signature = JSON.stringify(snapshot);
    if (signature !== lastSignature) {
      console.log(`[vosko] project ${projectId} status=${snapshot.status} items=${JSON.stringify(snapshot.items)}`);
      lastSignature = signature;
    }
    lastSnapshot = { project, rows };

    const failed = rows.find((r) => (r.error_msg || '').trim() !== '');
    if (failed) throw new Error(`item ${failed.item_id} failed: ${failed.error_msg}`);

    const ready = rows.find((r) => translatedAudioUrl(r));
    if (ready) return { project, item: ready };

    // Standard pipeline: translation finishes as per-subtitle segments
    // (editable_contents) and the audio is assembled from them afterwards.
    const translated = rows.find(
      (r) => Number(r.status) >= 4 && Array.isArray(r.editable_contents) && r.editable_contents.length,
    );
    if (translated) return { project, item: translated };

    if (onTick) onTick(snapshot);

    if (project?.status === 3 && rows.length && rows.every((r) => Number(r.status) < 4)) {
      throw new Error(`project finished without dubbed audio: ${JSON.stringify(snapshot)}`);
    }

    await sleep(10000);
  }

  throw new Error(`timeout waiting for project ${projectId}: ${JSON.stringify(lastSnapshot?.project?.status)}`);
}

/** The dubbed full-audio file for an item (signed URL, ~24h). */
export function translatedAudioUrl(item) {
  const chunks = item?.editable_chunk_info?.chunks || [];
  for (const chunk of chunks) {
    if (chunk?.translated_audio_url) return chunk.translated_audio_url;
  }
  return '';
}

export async function download(url, destPath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

/**
 * Complete one chunk: new account -> project -> upload -> translate -> mp3.
 * The caller supplies the email from the bridge and the OTP.
 */
export async function dubOnAccount({ token, filePath, duration, projectName, source, target, workDir }) {
  const pipeline = pipelineTypeFor(target);
  const videoType = videoTypeFor(duration);
  const project = await createProject(token, { name: projectName, source, target, duration });
  const projectId = project.project_id;
  console.log(`[vosko] project ${projectId} created (${source} -> ${target}, ${pipeline}, ${videoType})`);

  await uploadMedia(token, projectId, filePath, { duration });
  await updateProject(token, projectId, {
    project_name: projectName,
    original_language: source || 'Auto',
    target_language: target,
    subtitle_eraser: false,
    video_dubbing: true,
    auto_translate: false,
    tts_provider: 'mock',
    video_type: videoType,
    pipeline_type: pipeline,
  });
  await startTranslation(token, projectId);

  const { item } = await waitForResult(token, projectId, { timeoutMs: 45 * 60 * 1000 });
  const outPath = path.join(workDir, `chunk-${String(item.item_id)}.mp3`);

  let url = translatedAudioUrl(item);
  if (url) {
    const bytes = await download(url, outPath);
    console.log(`[vosko] dubbed audio saved (${(bytes / 1024).toFixed(0)} KiB)`);
    return { projectId, itemId: item.item_id, audioPath: outPath, audioUrl: url };
  }

  // Standard pipeline: the translated item carries one audio clip per subtitle
  // segment instead of a single merged track. Download them and lay them on a
  // silent timeline, exactly like the editor's playback does.
  console.log(`[vosko] standard pipeline: assembling per-segment audio for item ${item.item_id}`);
  url = await assembleStandardAudio(token, projectId, item, duration, workDir);
  const bytes = fs.statSync(outPath).size;
  console.log(`[vosko] dubbed audio assembled (${(bytes / 1024).toFixed(0)} KiB)`);

  return { projectId, itemId: item.item_id, audioPath: outPath, audioUrl: url };
}

/**
 * Build the full chunk track from the per-segment voice files of a standard
 * project. Segments without audio get their TTS generated on the spot through
 * the same endpoint the web editor uses.
 */
async function assembleStandardAudio(token, projectId, item, totalDuration, workDir) {
  let detail = item;
  if (!Array.isArray(detail?.editable_contents) || !detail.editable_contents.length) {
    detail = await getItem(token, projectId, item.item_id);
  }
  if (process.env.DEBUG_DUMP) {
    const dump = path.join(workDir, `item-${item.item_id}.json`);
    fs.writeFileSync(dump, JSON.stringify(detail, null, 2));
    console.log(`[vosko] debug dump -> ${dump}`);
  }

  const segments = Array.isArray(detail?.editable_contents) ? detail.editable_contents : [];
  if (!segments.length) throw new Error(`item ${item.item_id} has no dubbed audio and no subtitle segments`);

  const clips = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let audio = segmentAudio(seg);
    if (!audio) {
      if (!seg.voice_id || !String(seg.translated_text || '').trim()) {
        console.log(`[vosko] segment ${i + 1}/${segments.length} has no voice/text; skipping`);
        continue;
      }
      const task = await submitSegmentTts(token, projectId, item.item_id, {
        voiceId: seg.voice_id,
        text: seg.translated_text,
        voiceIdType: seg.voice_id_type,
        startTime: seg.start_time,
      });
      const taskId = task?.task_id;
      if (!taskId) throw new Error(`segment ${i + 1} tts returned no task_id: ${JSON.stringify(task).slice(0, 200)}`);
      const done = await waitForSegmentTts(token, taskId);
      audio = done.audio;
      console.log(`[vosko] segment ${i + 1}/${segments.length} tts ok`);
    }
    clips.push({ index: i, audio, offset: segmentStart(seg) });
  }

  if (!clips.length) throw new Error(`item ${item.item_id}: every subtitle segment is missing voice audio`);

  const local = [];
  for (const clip of clips) {
    const ext = path.extname(new URL(clip.audio).pathname) || '.mp3';
    const file = path.join(workDir, `seg-${item.item_id}-${String(clip.index).padStart(3, '0')}${ext}`);
    await download(clip.audio, file);
    local.push({ path: file, offset: Math.max(0, Math.min(totalDuration, clip.offset)) });
  }
  console.log(`[vosko] mixing ${local.length} segment(s) onto ${Number(totalDuration).toFixed(2)}s`);

  const outPath = path.join(workDir, `chunk-${String(item.item_id)}.mp3`);
  await mixSegmentAudio(local, Number(totalDuration), outPath);
  return outPath;
}

export { retry };
