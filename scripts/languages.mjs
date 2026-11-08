#!/usr/bin/env node
/**
 * Fetch the live language lists straight from the vosko.ai web bundle.
 *
 * The site keeps two arrays of {key,value} pairs in its Nuxt chunks:
 *  - source list: includes {key:"Auto Detect",value:"Auto"} (ASR-supported set)
 *  - target list: the dubbing targets (94 entries today)
 * We crawl the page, follow its JS imports, and pick those arrays. Results are
 * written to data/languages.json and the dispatch workflow is re-rendered so the
 * dropdowns always match the live site.
 *
 * Usage:
 *   node scripts/languages.mjs                # fetch + save + render workflow
 *   node scripts/languages.mjs --render-only  # re-render from data/languages.json
 *   node scripts/languages.mjs --summary      # fetch, save, print markdown summary
 *   node scripts/languages.mjs --verify "Auto" "Persian (Farsi)"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'languages.json');
const TEMPLATE = path.join(ROOT, 'ci', 'dub.template.yml');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'dub.yml');

const PAGE = process.env.VOSKO_LANG_PAGE || 'https://www.vosko.ai/translation/projects/create';
const ORIGIN = new URL(PAGE).origin;
const MAX_FILES = 160;

const DISPLAY = {
  Auto: 'Auto Detect',
  Cantonese: 'Chinese (Cantonese)',
  'Mandarin Chinese': 'Chinese (Mandarin)',
};

// Same "popular" pinning the site uses, by API value.
const POPULAR = [
  'Mandarin Chinese', 'English', 'Japanese', 'Korean', 'Spanish', 'German',
  'French', 'Portuguese', 'Thai', 'Indonesian', 'Vietnamese', 'Malay',
  'Filipino', 'Italian', 'Russian', 'Dutch', 'Polish', 'Turkish', 'Swedish',
];

const SEED = ['English', 'French', 'Spanish', 'Arabic', 'Hindi', 'German', 'Japanese', 'Russian'];

const uniq = (list) => [...new Set(list)];
const display = (value) => DISPLAY[value] || value;

async function getText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; vosko-dub-runner/1.0)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function scriptUrls(html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(/["'(]([^"'()\s]+?\.js)["')]/g)) {
    const raw = m[1];
    if (!raw.includes('_nuxt/')) continue;
    try { out.push(new URL(raw, pageUrl).href); } catch { /* ignore */ }
  }
  return uniq(out);
}

function importUrls(js, baseUrl) {
  const out = [];
  for (const m of js.matchAll(/from\s*["'](\.\/[A-Za-z0-9_.\-]+\.js)["']/g)) {
    try { out.push(new URL(m[1], baseUrl).href); } catch { /* ignore */ }
  }
  return uniq(out);
}

/** Walk an array literal of {key:"…",value:"…"} objects. */
function parseArrays(js) {
  const arrays = [];
  const marker = /=\s*\[\{key:"/g;
  let hit;
  while ((hit = marker.exec(js))) {
    const start = js.indexOf('[', hit.index);
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < js.length; i++) {
      const ch = js[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;
    const block = js.slice(start, end + 1);
    const pairs = [];
    for (const m of block.matchAll(/\{key:"([^"]{1,60})",value:"([^"]{1,60})"\}/g)) {
      pairs.push({ key: m[1], value: m[2] });
    }
    if (pairs.length >= 20) arrays.push({ pairs, start });
  }
  return arrays;
}

function languageScore(pairs) {
  const values = new Set(pairs.map((p) => p.value));
  return SEED.filter((name) => values.has(name)).length;
}

/**
 * Both lists live in the same bundle: the source array (with `Auto`) is
 * immediately followed by the dubbing-target array. Prefer that neighbour so
 * unrelated language arrays in other chunks never win, then fall back.
 */
function pickLists(arrays) {
  const sources = arrays.filter((entry) => entry.pairs.some((p) => p.value === 'Auto'));
  const sourceEntry = sources.sort((a, b) => b.pairs.length - a.pairs.length)[0];
  if (!sourceEntry) throw new Error('source language array not found');

  const sourceValues = new Set(sourceEntry.pairs.map((p) => p.value));
  const usable = arrays
    .filter((entry) => !entry.pairs.some((p) => p.value === 'Auto'))
    .filter((entry) => entry.pairs.length >= 30 && languageScore(entry.pairs) >= 4);

  const nextInFile = usable
    .filter((entry) => entry.file === sourceEntry.file && entry.start > sourceEntry.start)
    .sort((a, b) => a.start - b.start);

  if (nextInFile.length) {
    return { source: sourceEntry.pairs, target: nextInFile[0].pairs };
  }

  const scored = usable
    .map((entry) => ({
      entry,
      overlap: entry.pairs.filter((p) => sourceValues.has(p.value)).length,
      sameFile: entry.file === sourceEntry.file ? 1 : 0,
    }))
    .sort((a, b) => b.sameFile - a.sameFile || b.overlap - a.overlap || b.entry.pairs.length - a.entry.pairs.length);

  if (!scored.length) throw new Error('target language array not found');
  return { source: sourceEntry.pairs, target: scored[0].entry.pairs };
}

function sortRows(rows, { autoFirst = false } = {}) {
  const pin = (value) => {
    const index = POPULAR.indexOf(value);
    return index === -1 ? POPULAR.length : index;
  };
  return [...rows].sort((a, b) => {
    if (autoFirst) {
      if (a.value === 'Auto') return -1;
      if (b.value === 'Auto') return 1;
    }
    const pa = pin(a.value);
    const pb = pin(b.value);
    if (pa !== pb) return pa - pb;
    return a.display.localeCompare(b.display, 'en');
  });
}

async function fetchLive() {
  const html = await getText(PAGE);
  const queue = scriptUrls(html, PAGE);
  if (!queue.length) throw new Error('no Nuxt scripts found on the page');

  const seen = new Set();
  const arrays = [];
  let fetched = 0;
  while (queue.length && seen.size < MAX_FILES) {
    const batch = queue.splice(0, 8);
    await Promise.all(batch.map(async (url) => {
      if (seen.has(url)) return;
      seen.add(url);
      let js;
      try { js = await getText(url); } catch { return; }
      fetched++;
      arrays.push(...parseArrays(js).map((entry) => ({ ...entry, file: url })));
      for (const next of importUrls(js, url)) if (!seen.has(next)) queue.push(next);
    }));
  }

  const { source, target } = pickLists(arrays);
  const dedupe = (pairs, { skipAuto } = {}) => {
    const map = new Map();
    for (const p of pairs) {
      if (skipAuto && p.value === 'Auto') continue;
      map.set(p.value, { display: display(p.value), value: p.value });
    }
    return [...map.values()];
  };

  return {
    fetched_at: new Date().toISOString(),
    source_page: PAGE,
    scripts_scanned: fetched,
    source: sortRows(dedupe(source), { autoFirst: true }),
    target: sortRows(dedupe(target, { skipAuto: true })),
  };
}

function renderWorkflow(data) {
  if (!fs.existsSync(TEMPLATE)) throw new Error(`missing template ${TEMPLATE}`);
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const lines = (rows) => rows.map((row) => `          - '${row.display.replace(/'/g, "''")}'`).join('\n');
  const rendered = template
    .replace('__SOURCE_OPTIONS__', lines(data.source))
    .replace('__TARGET_OPTIONS__', lines(data.target));
  fs.mkdirSync(path.dirname(WORKFLOW), { recursive: true });
  fs.writeFileSync(WORKFLOW, rendered);
  console.log(`[languages] rendered ${path.relative(ROOT, WORKFLOW)} (${data.source.length} source / ${data.target.length} target)`);
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`[languages] saved ${path.relative(ROOT, DATA_FILE)}: ${data.source.length} source, ${data.target.length} target`);
}

function resolve(data, kind, input) {
  const needle = String(input || '').trim().toLowerCase();
  const rows = kind === 'source' ? data.source : data.target;
  const row = rows.find((r) => r.value.toLowerCase() === needle || r.display.toLowerCase() === needle);
  return row || null;
}

function summary(data, heading = 'Live vosko.ai languages') {
  const source = data.source.map((r) => r.display).join(', ');
  const target = data.target.map((r) => r.display).join(', ');
  return [
    `## ${heading}`,
    '',
    `Fetched: ${data.fetched_at} from <${data.source_page}>`,
    '',
    `<details><summary>Source (${data.source.length})</summary>`,
    '',
    source,
    '',
    '</details>',
    '',
    `<details><summary>Target (${data.target.length})</summary>`,
    '',
    target,
    '',
    '</details>',
    '',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const has = (flag) => args.includes(flag);

  if (has('--render-only')) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    renderWorkflow(data);
    return;
  }

  let data;
  try {
    data = await fetchLive();
    save(data);
  } catch (err) {
    console.error(`[languages] live fetch failed: ${err.message}`);
    if (!fs.existsSync(DATA_FILE)) throw err;
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.error('[languages] using cached data/languages.json');
  }

  if (has('--render') || !has('--no-render')) renderWorkflow(data);

  if (has('--summary')) {
    const text = summary(data);
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }

  const verifyIndex = args.indexOf('--verify');
  if (verifyIndex !== -1) {
    const src = args[verifyIndex + 1];
    const tgt = args[verifyIndex + 2];
    const srcRow = resolve(data, 'source', src);
    const tgtRow = resolve(data, 'target', tgt);
    if (!srcRow) throw new Error(`source language "${src}" is not in the live list`);
    if (!tgtRow) throw new Error(`target language "${tgt}" is not in the live list`);
    console.log(`[languages] verified: source=${srcRow.value} target=${tgtRow.value}`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `source_value=${srcRow.value}\ntarget_value=${tgtRow.value}\n`);
    }
  }
}

export { fetchLive, resolve, summary, display };

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('languages.mjs')) {
  main().catch((err) => {
    console.error(`[languages] ERROR: ${err.message}`);
    process.exit(1);
  });
}
