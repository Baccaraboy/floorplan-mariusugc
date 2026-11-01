// Languages: every word the map shows comes from a table in assets/lang/ (en.json is the source), the build
// puts the chosen one in the page (--lang or architecture.json "lang", English by default), and nothing visible
// is written straight into viewer.html or ui/*.js any more. A new language is a new table with the same keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { SKILL, shopApp, run, scanAndBuild, readGraph, readJson, writeJson, cleanup } from './helpers.mjs';

const LANG_DIR = path.join(SKILL, 'assets', 'lang');
const table = (code) => readJson(path.join(LANG_DIR, `${code}.json`));
const en = table('en');
const others = fs.readdirSync(LANG_DIR).filter((n) => n.endsWith('.json') && n !== 'en.json').map((n) => n.slice(0, -5));
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...s.matchAll(/<\/?[a-z]+/g)].map((m) => m[0]).sort();

// ---------- the tables ----------

test('there is a German table, and every table has exactly the keys of en.json', () => {
  assert.ok(others.includes('de'));
  for (const code of others) {
    const t = table(code);
    assert.deepEqual(Object.keys(en).filter((k) => !(k in t)), [], `${code}.json is missing keys`);
    assert.deepEqual(Object.keys(t).filter((k) => !(k in en)), [], `${code}.json has keys en.json doesn't`);
    for (const [k, v] of Object.entries(t)) assert.equal(typeof v, 'string', `${code}.json ${k}`);
  }
});

test('every placeholder in English is in each translation, and no other', () => {
  for (const code of others) {
    const t = table(code);
    for (const k of Object.keys(en)) assert.deepEqual(placeholders(t[k]), placeholders(en[k]), `${code}.json ${k}: ${t[k]}`);
  }
});

test('translations keep the same markup as English', () => {
  for (const code of others) {
    const t = table(code);
    for (const k of Object.keys(en)) assert.deepEqual(tags(t[k]), tags(en[k]), `${code}.json ${k}`);
  }
});

test('every counted text has an "other" form, and the glossary has a term, an explanation and words to match', () => {
  for (const k of Object.keys(en).filter((x) => /\.(one|two|few|many|zero)$/.test(x))) assert.ok(k.replace(/\.\w+$/, '.other') in en, `${k} has no .other`);
  const terms = Object.keys(en).filter((k) => /^glossary\.[\w-]+\.term$/.test(k)).map((k) => k.slice(0, -5));
  assert.ok(terms.length >= 40, 'the glossary is in the table');
  for (const code of ['en', ...others]) {
    const t = table(code);
    for (const g of terms) for (const part of ['term', 'text', 'match']) assert.ok(t[`${g}.${part}`]?.trim(), `${code}.json ${g}.${part}`);
  }
});

test('German explains the words in German, with the term the code uses in brackets where it differs', () => {
  const de = table('de');
  assert.equal(de['glossary.endpoint.term'], 'Endpunkt (endpoint)');
  assert.equal(de['glossary.database.term'], 'Datenbank (database)');
  assert.match(de['glossary.endpoint.text'], /Anfrage/);
  assert.ok(de['glossary.endpoint.match'].split('|').includes('Endpunkt'));
  assert.ok(de['glossary.endpoint.match'].split('|').includes('endpoint'), 'English words in German descriptions are explained too');
});

// ---------- the code uses the table ----------

const VIEWER = path.join(SKILL, 'assets', 'viewer.html');
const UI = fs.readdirSync(path.join(SKILL, 'assets', 'ui')).filter((n) => n.endsWith('.js')).sort().map((n) => path.join(SKILL, 'assets', 'ui', n));
// MAP.md, the map as text, takes its headings and labels from the same table, in the build
const MAP_MD = path.join(SKILL, 'scripts', 'lib', 'mapmd.mjs');
const sources = () => [VIEWER, ...UI, MAP_MD].map((f) => ({ file: path.relative(SKILL, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));
// keys built at run time from a prefix (kind.service, conn.plain.http, systems.apps.label, glossary.api.term, …)
const DYNAMIC = ['kind.', 'conn.plain.', 'conn.tech.', 'systems.', 'glossary.', 'lang.'];

test('every key the page and MAP.md use is in en.json, and every key in en.json is used', () => {
  const used = new Set();
  for (const { file, text } of sources()) {
    const calls = [...text.matchAll(/\b(?:t|tn)\(\s*'([\w.-]+)'/g), ...text.matchAll(/\{\{t:([\w.-]+)\}\}/g)].map((m) => m[1]);
    for (const k of calls) assert.ok(k in en || `${k}.other` in en, `${file} uses "${k}", which en.json doesn't have`);
    // any quoted key counts as used (keys picked by a condition, like t(PLAN ? 'health.review' : 'health.check'))
    for (const m of text.matchAll(/'([\w.-]+)'/g)) if (m[1] in en) used.add(m[1]);
    for (const k of calls) { used.add(k); used.add(`${k}.one`); used.add(`${k}.other`); }
  }
  for (const k of ['app.title', 'unassigned.label', 'unassigned.summary']) used.add(k); // build.mjs
  const unused = Object.keys(en).filter((k) => !used.has(k) && !DYNAMIC.some((p) => k.startsWith(p)));
  assert.deepEqual(unused, [], 'keys in en.json that nothing uses');
});

// A small JS tokenizer: every string and template literal, with ${…} parts left out, and the code just before it.
const EXPR = '\u0001';
function literals(src) {
  const out = [];
  let i = 0, line = 1, code = '';
  const KW = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)\s*$/;
  const regexAllowed = () => { const c = code.replace(/\s+$/, ''); return !c || /[(,=:[!&|?{};~+\-*%<>^]$/.test(c) || KW.test(c); };
  const push = (at, text) => { out.push({ line: at, text, before: code.slice(-60) }); code += /^[\w-]{1,24}$/.test(text) ? `'${text}'` : 'S'; };
  const readString = (q) => { const at = line; let s = ''; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; } if (src[i] === '\n') line++; s += src[i++]; } i++; push(at, s); };
  const readTemplate = () => {
    const at = line; let s = ''; i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; s += EXPR; readCode('}'); i++; continue; }
      if (src[i] === '\n') line++;
      s += src[i++];
    }
    i++; push(at, s);
  };
  const readRegex = () => {
    let inClass = false; i++;
    while (i < src.length) { const c = src[i]; if (c === '\\') { i += 2; continue; } if (c === '[') inClass = true; else if (c === ']') inClass = false; else if ((c === '/' && !inClass) || c === '\n') break; i++; }
    i++; while (/[a-z]/.test(src[i] || '')) i++;
    code += 'R';
  };
  function readCode(end) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], d = src[i + 1];
      if (end && c === end && depth === 0) return;
      if (c === '\n') { line++; code += c; i++; continue; }
      if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); line += (src.slice(i, j).match(/\n/g) || []).length; i = j + 2; continue; }
      if (c === '"' || c === "'") { readString(c); continue; }
      if (c === '`') { readTemplate(); continue; }
      if (c === '/' && regexAllowed()) { readRegex(); continue; }
      if (c === '{') depth++; else if (c === '}') depth--;
      code += c; i++;
    }
  }
  readCode(null);
  return out;
}

const WORD = /[A-Za-z]{2,}/;
const CSS = /\{[^{}]*:[^{}]*\}/;
/** Literals that look like words someone reads: text between tags, attributes people read, text written straight into the page, or prose. */
function visibleText(src) {
  const hits = [];
  for (const l of literals(src)) {
    const flat = l.text.split(EXPR).join(' ');
    const html = l.text.replace(/<code>[\s\S]*?<\/code>/g, '');
    let found = false;
    for (const m of html.matchAll(/>([^<>]*)</g)) if (WORD.test(m[1].split(EXPR).join(' ').replace(/&\w+;/g, ' '))) found = true;
    for (const m of html.matchAll(/\b(?:title|placeholder|aria-label|alt)="([^"]*)"/g)) if (WORD.test(m[1].split(EXPR).join(''))) found = true;
    const sink = /(\.textContent|\.innerText|\.title|\.placeholder)\s*=\s*$|setAttribute\('(?:aria-label|title|placeholder|alt)',\s*$|\b(?:toast|say)\(\s*$|\b(?:label|title|hint|kicker|kind|note|question|word|group|message)\s*:\s*$/.test(l.before);
    if (sink && WORD.test(flat) && !/^[\w.-]+$/.test(l.text) && !CSS.test(flat)) found = true;
    const prose = flat.trim();
    if (!/[<>]/.test(prose) && !CSS.test(prose) && (/^[A-Z][a-z’']+\b.*\s\S/.test(prose) || /^[A-Z][a-z]{2,}[.…]?$/.test(prose))) found = true;
    if (found) hits.push(l.text.split(EXPR).join('${…}'));
  }
  return hits;
}

// Words that are allowed to stay in the code, and why.
const ALLOWED = {
  'Claude': 'product name (the agent that answers)',
  'Claude Code': 'product name',
  'Codex': 'product name',
  'Floorplan': 'product name, in "Made with Floorplan"',
  'Enter': 'a key name the code compares with, not shown',
  'Escape': 'a key name the code compares with, not shown',
  'Backspace': 'a key name the code compares with, not shown',
  'Failed to fetch': 'the browser\'s own error message, compared with, not shown',
  'Search the map by words. Returns up to 15 items {id, type, name, description, path}. kind optionally limits results to module, file, endpoint or symbol.': 'a tool description for Claude in the Claude app, not shown',
  'Details of one map item by id: its description, parent module, children/files, endpoints, exports, and what it depends on and is used by (with ids).': 'a tool description for Claude in the Claude app, not shown',
  'Shortest chain of imports/HTTP calls from anything inside one item to anything inside another. Returns hops with ids.': 'a tool description for Claude in the Claude app, not shown',
};

test('no visible words are written straight into viewer.html, ui/*.js or MAP.md\'s writer: they go through t()', () => {
  const left = [];
  for (const { file, text } of sources()) {
    const scripts = file.endsWith('.html') ? [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]) : [text];
    for (const s of scripts) for (const hit of visibleText(s)) if (!(hit in ALLOWED)) left.push(`${file}: ${hit.slice(0, 100)}`);
  }
  assert.deepEqual(left, [], 'put these in assets/lang/en.json (and every other table) and use t(), or add them to ALLOWED with the reason');
  // the scanner itself finds what it should
  assert.equal(visibleText("b.textContent = 'Show details';").length, 1);
  assert.equal(visibleText('x.innerHTML = `<div class="lh">Show connections</div>`;').length, 1);
  assert.equal(visibleText('x.innerHTML = `<div class="more">+${n} more</div>`;').length, 1);
  assert.equal(visibleText("x.innerHTML = `<div>${t('legend.title')}</div>`; const k = 'legend.title';").length, 0);
});

test('the markup of viewer.html takes its words from the table too', () => {
  const html = fs.readFileSync(VIEWER, 'utf8').replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const texts = [...html.matchAll(/>([^<>]*)</g)].map((m) => m[1].trim()).filter((s) => WORD.test(s) && !/^(\{\{t:[\w.-]+\}\}|__FLOORPLAN_\w+__)$/.test(s));
  assert.deepEqual(texts, ['esc'], 'only the label on the Esc key cap is written in');
  const attrs = [...html.matchAll(/\b(title|placeholder|aria-label|alt)="([^"]*)"/g)].filter((m) => !/^\{\{t:[\w.-]+\}\}$/.test(m[2]) && m[2] !== 'Floorplan').map((m) => m[0]);
  assert.deepEqual(attrs, []);
  assert.match(fs.readFileSync(VIEWER, 'utf8'), /<html lang="__FLOORPLAN_HTML_LANG__">/);
});

// ---------- building in a language ----------

/** What a built page shows: its markup without scripts and styles, its language table, and its <html lang>. */
function shown(file) {
  const html = fs.readFileSync(file, 'utf8');
  const words = JSON.parse(/<script>window\.FLOORPLAN_LANG = (.*?);<\/script>/s.exec(html)[1]);
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  return { html, words, markup, all: markup + '\n' + Object.values(words.strings).join('\n'), lang: /<html lang="([^"]+)">/.exec(html)[1] };
}
const ENGLISH = ['Search files, routes, modules', 'Recent work', 'Start here', 'Show connections', 'Show technical detail', 'Ask anything about', 'No description yet', 'Fit to screen', 'Health check', 'Connection types'];
const GERMAN = ['Suche', 'Zuletzt gearbeitet', 'Rundgang', 'Dateien, Routen, Module suchen', 'Verbindungen zeigen', 'Technische Details zeigen', 'Frag etwas zu', 'Noch keine Beschreibung', 'Code-Check', 'Verbindungsarten'];

let root;
before(() => { root = shopApp(); scanAndBuild(root); });
after(() => cleanup(root));

test('without a language the map is English, as before: the English words, and exactly the English table', () => {
  const page = shown(path.join(root, 'floorplan', 'index.html'));
  assert.equal(page.lang, 'en');
  assert.equal(page.words.lang, 'en');
  assert.deepEqual(page.words.strings, en);
  for (const s of ENGLISH) assert.ok(page.all.includes(s), `"${s}" is on the English map`);
  assert.match(page.html, /<title>Shop map<\/title>/);
  assert.ok(!/\{\{t:/.test(page.html), 'every marker in the markup was filled in');
  assert.equal(readGraph(root).meta.lang, 'en');
});

test('--lang de builds the map in German, and no English word is left among the samples', () => {
  const out = run('build.mjs', root, '--no-claude-md', '--lang', 'de');
  assert.match(out, /LANGUAGE {2}Deutsch \(de\)/);
  const page = shown(path.join(root, 'floorplan', 'index.html'));
  assert.equal(page.lang, 'de');
  assert.equal(page.words.lang, 'de');
  for (const s of GERMAN) assert.ok(page.all.includes(s), `"${s}" is on the German map`);
  for (const s of ENGLISH) assert.ok(!page.all.includes(s), `"${s}" is still on the German map`);
  assert.match(page.html, /<title>Shop – Karte<\/title>/);
  assert.equal(readGraph(root).meta.lang, 'de');
  // and back: the flag lasts one build
  run('build.mjs', root, '--no-claude-md');
  assert.equal(shown(path.join(root, 'floorplan', 'index.html')).lang, 'en');
});

test('"lang": "de" in architecture.json makes it last, refresh included', () => {
  const r = shopApp();
  try {
    const archFile = path.join(r, 'floorplan', 'architecture.json');
    writeJson(archFile, { ...readJson(archFile), lang: 'de' });
    scanAndBuild(r);
    assert.equal(shown(path.join(r, 'floorplan', 'index.html')).lang, 'de');
    run('refresh.mjs', r);
    const page = shown(path.join(r, 'floorplan', 'index.html'));
    assert.equal(page.lang, 'de');
    assert.ok(page.all.includes('Zuletzt gearbeitet'));
  } finally { cleanup(r); }
});

test('a language without a table is an error that names the ones there are', () => {
  let out = '';
  try { run('build.mjs', root, '--no-claude-md', '--lang', 'fr'); } catch (e) { out = String(e.stdout); }
  assert.match(out, /--lang "fr" must be one of en, de/);
  const r = shopApp();
  try {
    const archFile = path.join(r, 'floorplan', 'architecture.json');
    writeJson(archFile, { ...readJson(archFile), lang: 'German' });
    run('scan.mjs', r);
    try { run('build.mjs', r, '--no-claude-md'); out = ''; } catch (e) { out = String(e.stdout); }
    assert.match(out, /lang "German" must be one of en, de/);
  } finally { cleanup(r); }
});

test('the worksheets tell the AI to write in the map\'s language, and say nothing about it for English', () => {
  const r = shopApp();
  try {
    run('scan.mjs', r);
    run('build.mjs', r, '--no-claude-md');
    assert.doesNotMatch(run('describe.mjs', r), /Language:/);
    assert.doesNotMatch(run('recent.mjs', r), /Language:/);
    run('build.mjs', r, '--no-claude-md', '--lang', 'de');
    assert.match(run('describe.mjs', r), /Language: German \("lang": "de" in architecture\.json\)\. Write every name, description, title, note and summary in German/);
    const sheet = fs.readdirSync(path.join(r, 'floorplan', '.cache', 'worksheets'))[0];
    assert.match(fs.readFileSync(path.join(r, 'floorplan', '.cache', 'worksheets', sheet), 'utf8'), /^Language: German/m);
    assert.match(run('recent.mjs', r), /Language: German/);
  } finally { cleanup(r); }
});

test('questions, requested flows and blueprint changes are answered in the map\'s language', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(SKILL, 'assets', 'graph-query.js'), 'utf8'), ctx);
  const G = (lang) => ({ project: { name: 'Shop' }, meta: lang ? { lang } : {} });
  for (const fn of ['floorplanAskInstructions', 'floorplanFlowInstructions', 'floorplanChangeInstructions']) {
    assert.match(ctx[fn](G('de'), 'cli'), /The map is in German: write every title, description, note, answer and follow-up in German\./, fn);
    assert.equal(ctx[fn](G('en'), 'cli'), ctx[fn](G(), 'cli'), `${fn}: English is unchanged`);
    assert.doesNotMatch(ctx[fn](G('en'), 'cli'), /The map is in/, fn);
  }
});

test('the glossary finds German words whole, also next to umlauts, and English terms in German text', () => {
  const src = fs.readFileSync(path.join(SKILL, 'assets', 'ui', '10-glossary.js'), 'utf8');
  const from = src.indexOf('const exact = new Map()'), to = src.indexOf('\n', src.indexOf('const termOf'));
  const de = table('de');
  const ids = Object.keys(de).filter((k) => /^glossary\.[\w-]+\.term$/.test(k)).map((k) => k.slice(0, -5));
  const TERMS = ids.map((g) => [de[`${g}.term`], de[`${g}.text`], ...de[`${g}.match`].split('|')]);
  const { RE, termOf } = vm.runInNewContext(`${src.slice(from, to)}; ({ RE, termOf })`, { TERMS });
  const found = (text) => [...text.matchAll(RE)].map((m) => TERMS[termOf(m[0])][0]);
  assert.deepEqual(found('Speichert jede Bestellung in der Datenbank.'), ['Datenbank (database)']);
  assert.deepEqual(found('Eine Datenbankänderung und eine Datenbanktabelle'), ['Datensatz (record)'], 'no match inside a longer word');
  assert.deepEqual(found('Der Webhook ruft den Endpunkt auf.'), ['Webhook', 'Endpunkt (endpoint)']);
  assert.deepEqual(found('Uses the database'), ['Datenbank (database)']);
});

test('the map server still finds the map data in a page that carries a language table', () => {
  run('build.mjs', root, '--no-claude-md', '--lang', 'de');
  const out = execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', path.join(root, 'copy.html')], { cwd: root, encoding: 'utf8' });
  assert.match(out, /Exported the map to/);
  const copy = shown(path.join(root, 'copy.html'));
  assert.equal(copy.lang, 'de');
  assert.ok(JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(copy.html)[1]).meta.exported);
});
