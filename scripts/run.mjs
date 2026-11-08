#!/usr/bin/env node
/**
 * Orchestrator: input URL -> chunks -> one fresh vosko account per chunk ->
 * dubbed mp3 per chunk -> merge -> remux -> GitHub Release.
 *
 * Environment:
 *   INPUT_URL         direct video/audio URL (required)
 *   SOURCE_LANG       display name or API value (default Auto)
 *   TARGET_LANG       display name or API value (required)
 *   CHUNK_SECONDS     soft chunk length, default 52 (hard cap 58)
 *   WHISPER_MODEL     tiny|base|small (default base)
 *   WORK_DIR          scratch dir (default ./work)
 *   VDB_BASE_URL      bridge REST base
 *   VDB_KEY           bridge runner key
 *   GH_TOKEN + GITHUB_REPOSITORY   enable release publishing
 *   PUBLISH_RELEASE   "false" disables publishing
 *   OUTPUT_MODE       "audio" (default) = one merged MP3; "video" = mux onto original video
 *   PARALLEL_CHUNKS   how many chunks to dub at once (default 2, max 3)
 *   MAX_ACCOUNT_TRIES per-chunk account attempts (default 2)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchLive, resolve } from './languages.mjs';
import * as bridge from './lib/bridge.mjs';
import * as vosko from './lib/vosko.mjs';
import { buildChunks, concatDubbed, assembleFinal, probeDuration, sh, fitChunkAudio, silenceMp3 } from './lib/media.mjs';

const env = process.env;
const INPUT_URL = env.INPUT_URL || '';
const TARGET_INPUT = env.TARGET_LANG || '';
const SOURCE_INPUT = env.SOURCE_LANG || 'Auto';
const CHUNK_SECONDS = Math.min(56, Math.max(20, Number(env.CHUNK_SECONDS || 52))); // site cap is 60s
const WHISPER_MODEL = env.WHISPER_MODEL || 'base';
const WORK_DIR = path.resolve(env.WORK_DIR || 'work');
const OUT_DIR = path.join(WORK_DIR, 'out');
const STATE_FILE = path.join(WORK_DIR, 'state.json');
const MAX_ACCOUNT_TRIES = Math.max(1, Number(env.MAX_ACCOUNT_TRIES || 2));
const OUTPUT_MODE = (env.OUTPUT_MODE || 'audio').toLowerCase() === 'video' ? 'video' : 'audio';
const PARALLEL_CHUNKS = Math.max(1, Math.min(3, Number(env.PARALLEL_CHUNKS || 2)));
const STARTED = new Date();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function setOutput(key, value) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function appendSummary(markdown) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown + '\n');
}

async function loadLanguages() {
  try {
    const live = await fetchLive();
    const liveFile = path.join(process.cwd(), 'data', 'languages.live.json');
    try {
      fs.mkdirSync(path.dirname(liveFile), { recursive: true });
      fs.writeFileSync(liveFile, JSON.stringify(live, null, 2));
    } catch { /* read-only checkout is fine */ }
    return live;
  } catch (err) {
    log(`[lang] live fetch failed (${err.message}); using data/languages.json`);
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'languages.json'), 'utf8'));
  }
}

function localFileFor(url, dir) {
  const clean = url.split('?')[0].split('#')[0];
  const base = path.basename(clean) || 'input';
  const safe = base.replace(/[^A-Za-z0-9_.\-]/g, '_').slice(0, 80) || 'input';
  const withExt = path.extname(safe) ? safe : `${safe}.mp4`;
  return path.join(dir, withExt);
}

async function downloadInput(url, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(url)) return { file: path.resolve(url) };
  const dest = localFileFor(url, dir);
  log(`[input] downloading ${url}`);
  const res = spawnSync('curl', ['-L', '--fail', '--retry', '3', '--retry-delay', '3', '-o', dest, url], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`download failed with exit ${res.status}`);
  return { file: dest };
}

async function isVideoFile(file) {
  const { stdout } = await sh('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file,
  ]);
  return stdout.trim().includes('video');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { chunks: {} }; }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** New account from the bridge: email -> OTP -> JWT -> gift credits. */
async function openAccount(chunkIndex) {
  const identity = await bridge.mintIdentity(globalThis.RUN_ID, chunkIndex);
  const email = identity.email;
  log(`[account] chunk ${chunkIndex}: ${email}`);

  await vosko.sendLoginCode(email);
  const otp = await bridge.waitForCode(email, { waitSeconds: 50 });
  log(`[account] OTP ${otp.code} (message ${otp.message_id})`);

  const { token } = await vosko.loginWithCode(email, otp.code);
  await bridge.updateIdentity(identity.id, { status: 'logged_in' });

  let gift = null;
  try { gift = await vosko.claimGift(token); } catch (err) { log(`[account] gift: ${err.message}`); }
  log(`[account] logged in, gift=${JSON.stringify(gift)}`);

  return { identity, token, email };
}

/** Dub one chunk with retries across fresh accounts. */
async function dubChunk(chunk, { target, source, isVideo, state }) {
  const cached = state.chunks[chunk.index];
  if (cached?.audioPath && fs.existsSync(cached.audioPath)) {
    log(`[chunk ${chunk.index}] already done (resume): ${cached.audioPath}`);
    return cached;
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_ACCOUNT_TRIES; attempt++) {
    let account = null;
    try {
      account = await openAccount(chunk.index);
      const { token, identity } = account;
      const projectName = `vdb-${globalThis.RUN_ID}-${chunk.index}-${attempt}-${Date.now().toString(36).slice(-4)}`.slice(0, 60);

      const result = await vosko.dubOnAccount({
        token,
        filePath: chunk.path,
        duration: chunk.duration,
        projectName,
        source,
        target,
        workDir: OUT_DIR,
      });

      const balance = await vosko.credits(token).catch(() => null);
      const used = 200 - Number(balance?.balance ?? 200);
      await bridge.updateIdentity(identity.id, {
        status: 'done',
        project_id: result.projectId,
        item_id: result.itemId,
        credits_used: used > 0 ? used : 0,
      });

      const record = {
        index: chunk.index,
        start: chunk.start,
        end: chunk.end,
        duration: chunk.duration,
        audioPath: result.audioPath,
        projectId: result.projectId,
        itemId: result.itemId,
        identityId: identity.id,
        email: account.email,
        creditsUsed: used > 0 ? used : 0,
        status: 'done',
      };
      state.chunks[chunk.index] = record;
      saveState(state);
      return record;
    } catch (err) {
      lastError = err;
      log(`[chunk ${chunk.index}] attempt ${attempt} failed: ${err.message}`);
      if (account?.identity?.id) {
        await bridge.updateIdentity(account.identity.id, { status: 'failed', error: err.message.slice(0, 900) }).catch(() => {});
      }
      if (attempt < MAX_ACCOUNT_TRIES) await sleep(4000);
    }
  }
  throw lastError;
}

async function publishRelease({ file, runId, chunkCount, summaryMarkdown }) {
  if (env.PUBLISH_RELEASE === 'false') return '';
  if (!env.GH_TOKEN || !env.GITHUB_REPOSITORY) return '';

  const tag = `dub-${runId || Date.now()}`;
  const title = `Vosko dub ${tag}`;
  const notes = [
    `Source: ${INPUT_URL}`,
    `Language: ${SOURCE_INPUT} -> ${TARGET_INPUT}`,
    `Chunks: ${chunkCount}`,
    '',
    summaryMarkdown,
  ].join('\n');

  const args = ['release', 'create', tag, file, '--title', title, '--notes', notes, '--latest'];
  const res = spawnSync('gh', args, { stdio: 'inherit', env: { ...env, GH_TOKEN: env.GH_TOKEN } });
  if (res.status !== 0) throw new Error(`gh release create failed with exit ${res.status}`);
  return `https://github.com/${env.GITHUB_REPOSITORY}/releases/tag/${tag}`;
}

async function main() {
  if (!INPUT_URL) throw new Error('INPUT_URL is required');
  if (!TARGET_INPUT) throw new Error('TARGET_LANG is required');
  if (!bridge.configured()) throw new Error('VDB_KEY is required (vosko-dub-bridge runner key)');

  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const languages = await loadLanguages();
  const sourceRow = resolve(languages, 'source', SOURCE_INPUT);
  const targetRow = resolve(languages, 'target', TARGET_INPUT);
  if (!sourceRow) throw new Error(`unknown source language "${SOURCE_INPUT}"`);
  if (!targetRow) throw new Error(`unknown target language "${TARGET_INPUT}"`);
  const source = sourceRow.value;
  const target = targetRow.value;
  log(`[lang] ${sourceRow.display} (${source}) -> ${targetRow.display} (${target})`);

  const { file: inputFile } = await downloadInput(INPUT_URL, WORK_DIR);
  const duration = await probeDuration(inputFile);
  const isVideo = await isVideoFile(inputFile);
  log(`[input] ${path.basename(inputFile)} ${duration.toFixed(1)}s, ${isVideo ? 'video' : 'audio'}`);

  const { chunks } = await buildChunks(inputFile, path.join(WORK_DIR, 'chunks'), {
    maxSeconds: CHUNK_SECONDS,
    hardCap: 56,
    whisperModel: WHISPER_MODEL,
    sourceLanguage: source,
    video: isVideo,
  });
  log(`[chunk] ${chunks.length} chunk(s)`);

  const run = await bridge.createRun({
    videoUrl: INPUT_URL,
    sourceLang: source,
    targetLang: target,
    chunkTotal: chunks.length,
    meta: { duration, isVideo, outputMode: OUTPUT_MODE, chunkSeconds: CHUNK_SECONDS, whisperModel: WHISPER_MODEL },
  });
  globalThis.RUN_ID = run.id;
  await bridge.updateRun(run.id, { status: 'running' });
  log(`[bridge] run ${run.id} (${run.run_key})`);

  const state = loadState();
  const records = [];
  const failedChunks = [];
  const queue = [...chunks];
  const workers = Math.min(PARALLEL_CHUNKS, chunks.length);
  log(`[chunk] dubbing up to ${workers} chunk(s) at a time`);

  const runWorker = async () => {
    while (queue.length) {
      const chunk = queue.shift();
      try {
        const record = await dubChunk(chunk, { target, source, isVideo, state });
        records.push(record);
        await bridge.updateRun(run.id, { chunk_done: records.length }).catch(() => {});
        log(`[chunk ${chunk.index}] finished (${records.length}/${chunks.length})`);
      } catch (err) {
        failedChunks.push(chunk);
        log(`[chunk ${chunk.index}] FAILED: ${err.message}`);
        await bridge.updateRun(run.id, { status: 'partial', error: err.message.slice(0, 1500) }).catch(() => {});
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => runWorker()));

  if (!records.length) throw new Error('no chunk was dubbed successfully');

  const ordered = records.sort((a, b) => a.index - b.index);
  const byIndex = new Map(ordered.map((r) => [r.index, r]));

  // Walk every planned chunk in order. A failed chunk becomes silence of the
  // same length so the rest of the audio stays aligned with the video.
  const fitted = [];
  for (const chunk of chunks) {
    const r = byIndex.get(chunk.index);
    if (!r) {
      const out = path.join(OUT_DIR, `chunk-${String(chunk.index).padStart(3, '0')}-silence.mp3`);
      await silenceMp3(chunk.duration, out);
      log(`[merge] chunk ${chunk.index} failed; inserting ${chunk.duration.toFixed(2)}s of silence`);
      fitted.push({ ...chunk, audioPath: out, email: '', creditsUsed: 0, status: 'missing' });
      continue;
    }
    const out = path.join(OUT_DIR, `chunk-${String(r.index).padStart(3, '0')}-fit.mp3`);
    const audioPath = await fitChunkAudio(r.audioPath, out, r.duration, { index: r.index });
    fitted.push({ ...r, audioPath });
  }

  const dubMp3 = path.join(OUT_DIR, 'dubbed.mp3');
  log(`[merge] concatenating ${fitted.length} segment(s)`);
  await concatDubbed(fitted.map((r) => r.audioPath), dubMp3);

  const ext = OUTPUT_MODE === 'video' && isVideo ? 'mp4' : 'mp3';
  const stamp = STARTED.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const finalFile = path.join(OUT_DIR, `dubbed-${target.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${stamp}.${ext}`);
  log(`[merge] writing final ${ext}`);
  await assembleFinal({ input: inputFile, dubbedAudio: dubMp3, outFile: finalFile, isVideo: ext === 'mp4' });

  const chunkRows = fitted
    .map((r) => `| ${r.index + 1} | ${r.start.toFixed(1)}s | ${r.duration.toFixed(1)}s | ${r.status === 'missing' ? '—' : (r.creditsUsed || 0)} | ${r.email ? `\`${r.email}\`` : '(silence)'} |`)
    .join('\n');
  const summaryMarkdown = [
    '| # | start | length | credits | account |',
    '|---|---|---|---|---|',
    chunkRows,
  ].join('\n');

  let releaseUrl = '';
  try {
    releaseUrl = await publishRelease({ file: finalFile, runId: run.id, chunkCount: records.length, summaryMarkdown });
  } catch (err) {
    log(`[release] ${err.message}`);
  }

  await bridge.updateRun(run.id, {
    status: failedChunks.length ? 'partial' : 'completed',
    chunk_done: records.length,
    output_name: path.basename(finalFile),
    output_url: releaseUrl || '',
    error: failedChunks.length ? `${failedChunks.length} chunk(s) failed` : '',
  });

  const result = {
    runId: run.id,
    input: INPUT_URL,
    source,
    target,
    isVideo,
    outputMode: OUTPUT_MODE,
    chunks: fitted,
    outputFile: finalFile,
    releaseUrl,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2));

  setOutput('file', finalFile);
  setOutput('name', path.basename(finalFile));
  setOutput('run_id', String(run.id));
  setOutput('release_url', releaseUrl);

  const summary = [
    '## Vosko dub finished',
    '',
    `- Input: ${INPUT_URL}`,
    `- Language: ${sourceRow.display} → ${targetRow.display}`,
    `- Chunks: ${records.length}/${chunks.length}${failedChunks.length ? ` (${failedChunks.length} failed, silence inserted)` : ''}`,
    `- Release: ${releaseUrl || 'not published'}`,
    `- Bridge run: ${run.id}`,
    '',
    summaryMarkdown,
    '',
  ].join('\n');
  appendSummary(summary);
  log(`[done] ${finalFile}${releaseUrl ? ` -> ${releaseUrl}` : ''}`);
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack || err.message}`);
  if (globalThis.RUN_ID) {
    bridge.updateRun(globalThis.RUN_ID, { status: 'failed', error: String(err.message).slice(0, 1500) }).catch(() => {});
  }
  process.exit(1);
});
