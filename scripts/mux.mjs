#!/usr/bin/env node
/**
 * Put an externally produced dub track onto a video.
 *
 * The original audio is dropped completely (`-map 0:v:0 -map 1:a:0`), the
 * picture is stream-copied (no quality loss, no re-encode) and the dub starts
 * at 00:00 with its own timing. `apad` keeps the last frames of the video from
 * being cut when the dub is a fraction of a second shorter.
 *
 *   node scripts/mux.mjs <video> <dubbed-audio> [out.mp4]
 *
 * Example:
 *   node scripts/mux.mjs input.mp4 dubbed-fa.mp3 final-fa.mp4
 */

import path from 'node:path';
import { sh, probeDuration } from './lib/media.mjs';

const [, , video, audio, outArg] = process.argv;
if (!video || !audio) {
  console.error('usage: node scripts/mux.mjs <video> <dubbed-audio> [out.mp4]');
  process.exit(2);
}

const out = outArg || path.join(path.dirname(audio), `${path.basename(video, path.extname(video))}-dubbed.mp4`);

console.log(`[mux] video  ${video}`);
console.log(`[mux] dub    ${audio}`);
await sh('ffmpeg', [
  '-y', '-v', 'error',
  '-i', video,
  '-i', audio,
  '-map', '0:v:0',
  '-map', '1:a:0',
  '-c:v', 'copy',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-ar', '48000',
  '-ac', '2',
  '-af', 'apad',
  '-shortest',
  '-movflags', '+faststart',
  out,
]);

const videoDuration = await probeDuration(video);
const outDuration = await probeDuration(out);
console.log(`[mux] wrote ${out} (${outDuration.toFixed(2)}s, source ${videoDuration.toFixed(2)}s)`);
