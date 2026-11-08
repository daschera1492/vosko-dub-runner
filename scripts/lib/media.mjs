/**
 * ffmpeg/ffprobe helpers: chunking at silence boundaries, merging, remuxing.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function sh(cmd, args, { timeoutMs = 0, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 || allowFail) return resolve({ code, stdout, stderr });
      reject(new Error(`${cmd} exited ${code}: ${stderr.split('\n').slice(-8).join(' | ')}`));
    });
  });
}

export async function probeDuration(file) {
  const { stdout } = await sh('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const value = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`cannot read duration of ${file}`);
  return value;
}

/** Extract a mono 16 kHz WAV for Whisper. */
export async function extractForWhisper(input, outWav) {
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  await sh('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav]);
  return outWav;
}

/** Cut one span into a compact mono WAV the site accepts. */
export async function cutChunk(input, start, end, outWav) {
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  const length = Math.max(0.2, end - start);
  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-ss', start.toFixed(3),
    '-i', input,
    '-t', length.toFixed(3),
    '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
    outWav,
  ]);
  return outWav;
}

/**
 * Word timestamps from Whisper (Python CLI bridge).
 * @returns {Promise<Array<{start:number,end:number,word:string}>>}
 */
export async function whisperWords(wavPath, { model = 'base', language = 'Auto' } = {}) {
  const outJson = wavPath.replace(/\.wav$/i, '') + '.words.json';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, 'whisper_words.py');
  const py = process.env.PYTHON || 'python3';
  await sh(py, [script, model, wavPath, outJson, language], { timeoutMs: 60 * 60 * 1000 });
  const parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  return Array.isArray(parsed.words) ? parsed.words : [];
}

function planCuts(words, duration, maxSeconds, hardCap, minChunk = 8) {
  const gaps = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap >= 0.3) {
      gaps.push({ t: words[i].end + Math.min(0.2, gap / 2), gap });
    }
  }
  gaps.sort((a, b) => a.t - b.t);

  const cuts = [];
  let cursor = 0;
  let guard = 0;
  while (duration - cursor > maxSeconds && guard++ < 500) {
    const inside = gaps.filter((g) => g.t > cursor + minChunk && g.t <= cursor + maxSeconds);
    const overrun = gaps.filter((g) => g.t > cursor + maxSeconds && g.t <= cursor + hardCap);
    let cut;
    if (inside.length) cut = inside[inside.length - 1].t;
    else if (overrun.length) cut = overrun[0].t;
    else cut = cursor + maxSeconds;
    if (cut <= cursor + 0.5) break;
    cuts.push(cut);
    cursor = cut;
  }
  return cuts;
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Split media into <=hardCap chunks, cutting in silences whenever possible.
 * @returns {Promise<{duration:number,chunks:Array<{index:number,start:number,end:number,duration:number,path:string}>}>}
 */
export async function buildChunks(input, outDir, {
  maxSeconds = 52,
  hardCap = 58,
  padSeconds = 0.06,
  whisperModel = 'base',
  sourceLanguage = 'Auto',
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const duration = await probeDuration(input);
  console.log(`[chunk] source duration ${duration.toFixed(2)}s`);

  let cuts = [];
  if (duration > hardCap) {
    const wav = path.join(outDir, 'source-16k.wav');
    console.log('[chunk] extracting audio for Whisper');
    await extractForWhisper(input, wav);

    let words = [];
    try {
      console.log(`[chunk] Whisper (${whisperModel}) word timestamps`);
      words = await whisperWords(wav, { model: whisperModel, language: sourceLanguage });
      console.log(`[chunk] ${words.length} words, language=${sourceLanguage}`);
    } catch (err) {
      console.warn(`[chunk] Whisper failed (${err.message}); falling back to silencedetect`);
    }

    if (words.length >= 3) {
      cuts = planCuts(words, duration, maxSeconds, hardCap);
    } else {
      cuts = await silencedetectCuts(input, duration, maxSeconds, hardCap);
    }
    console.log(`[chunk] planned cuts: ${cuts.map((c) => c.toFixed(2)).join(', ') || '(none)'}`);
  }

  // Merge a too-short tail into the previous chunk.
  while (cuts.length) {
    const lastStart = cuts.length > 1 ? cuts[cuts.length - 2] : 0;
    if (duration - cuts[cuts.length - 1] < 3 && duration - lastStart <= hardCap) cuts.pop();
    else break;
  }

  const bounds = [0, ...cuts, duration];
  const chunks = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let start = Math.max(0, bounds[i] - (i === 0 ? 0 : padSeconds));
    let end = Math.min(duration, bounds[i + 1] + (i === bounds.length - 2 ? 0 : padSeconds));
    if (end - start > hardCap + 0.5) end = start + hardCap;
    const file = path.join(outDir, `chunk-${String(i).padStart(3, '0')}.wav`);
    await cutChunk(input, start, end, file);
    chunks.push({ index: i, start: round(start), end: round(end), duration: round(end - start), path: file });
    console.log(`[chunk] #${i} ${start.toFixed(2)}s - ${end.toFixed(2)}s (${(end - start).toFixed(2)}s)`);
  }
  return { duration, chunks };
}

/** Fallback: cut at the middle of detected silences. */
async function silencedetectCuts(input, duration, maxSeconds, hardCap) {
  const { stderr } = await sh('ffmpeg', [
    '-v', 'info', '-i', input, '-vn',
    '-af', 'silencedetect=noise=-35dB:d=0.3',
    '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
  ]);
  const silences = [];
  let current = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*([\d.]+)/);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (s) current = Number.parseFloat(s[1]);
    if (e && current !== null) {
      silences.push((current + Number.parseFloat(e[1])) / 2);
      current = null;
    }
  }
  const cuts = [];
  let cursor = 0;
  while (duration - cursor > maxSeconds) {
    const inside = silences.filter((t) => t > cursor + 8 && t <= cursor + maxSeconds);
    const overrun = silences.filter((t) => t > cursor + maxSeconds && t <= cursor + hardCap);
    const cut = inside.length ? inside[inside.length - 1] : overrun.length ? overrun[0] : cursor + maxSeconds;
    if (cut <= cursor + 0.5) break;
    cuts.push(cut);
    cursor = cut;
  }
  return cuts;
}

/**
 * Fit a dubbed chunk back onto its original span.
 *
 * The site re-times each chunk: it trims leading/trailing silence, so the MP3
 * is almost never exactly `seconds` long. If shorter we pad with silence; if
 * longer we speed it up slightly (pitch-preserving atempo) and only cut the
 * tail when the overflow is too large to stretch. This keeps every chunk
 * boundary aligned with the source timeline, which is what video muxing needs.
 */
export async function fitChunkAudio(input, outFile, seconds, { index = 0 } = {}) {
  const have = await probeDuration(input);
  const diff = have - seconds;
  if (Math.abs(diff) <= 0.05) return input;

  const filters = [];
  if (diff > 0) {
    const ratio = have / seconds;
    const tempo = Math.min(1.3, ratio);
    filters.push(`atempo=${tempo.toFixed(4)}`);
    if (ratio > 1.3) {
      console.warn(
        `[fit] chunk ${index}: dub is ${(diff).toFixed(2)}s longer than its span; ` +
          `speeding up ${(tempo * 100).toFixed(0)}% and trimming the tail`
      );
    } else {
      console.log(`[fit] chunk ${index}: speeding up ${(tempo * 100 - 100).toFixed(1)}% to fit ${seconds.toFixed(2)}s`);
    }
  } else {
    console.log(`[fit] chunk ${index}: padding ${(-diff).toFixed(2)}s of silence`);
  }

  filters.push(`apad=whole_dur=${seconds.toFixed(3)}`, `atrim=0:${seconds.toFixed(3)}`);

  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-i', input,
    '-af', filters.join(','),
    '-c:a', 'libmp3lame', '-q:a', '2',
    outFile,
  ]);
  return outFile;
}

/** Re-encode and concatenate dubbed MP3 chunks with tiny fades. */export async function concatDubbed(mp3Paths, outMp3) {
  fs.mkdirSync(path.dirname(outMp3), { recursive: true });
  const listFile = outMp3.replace(/\.mp3$/i, '') + '.txt';
  fs.writeFileSync(listFile, mp3Paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:a', 'libmp3lame', '-q:a', '2',
    outMp3,
  ]);
  return outMp3;
}

/** Mux the dubbed audio onto the original video (stream copy), else keep audio. */
export async function assembleFinal({ input, dubbedAudio, outFile, isVideo }) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (!isVideo) {
    await sh('ffmpeg', ['-y', '-v', 'error', '-i', dubbedAudio, '-c:a', 'libmp3lame', '-q:a', '2', outFile]);
    return outFile;
  }
  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-i', input,
    '-i', dubbedAudio,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    outFile,
  ]);
  return outFile;
}
