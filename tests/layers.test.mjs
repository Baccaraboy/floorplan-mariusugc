// Layers: floorplan/layers.json sorts every file into the system the owner could publish, the setup of this one
// installation, and the owner's content, by patterns in the order of the list; a part takes the layer more than half
// of its files have, else "mixed". The map gets a Layers switch, and Health a Publishability group: ids, folders and
// contact details of this installation in system code, words from a private list that stays outside the repo (shown
// only by their first letter), and system code that imports content. Without the file, nothing changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { SKILL, makeProject, shopApp, scanAndBuild, run, readGraph, readJson, writeJson, cleanup } from './helpers.mjs';

// made-up values, put together at run time so nothing id- or key-like is committed
const UUID = ['0c1f7e2a', '58b4', '4d3e', '9a61', '3f5e2b7c8d90'].join('-');
const HEX = ['b81f4e0c', '2a9d47e3', 'b6c15f8a', '2e9d03c7'].join('');
const STRIPE_KEY = ['sk', 'test', 'Zq8Lr2Vx7Nc4Bt9Hw3Kd6Fm1'].join('_');
const TOKEN = ['1Qx7Kp', 'Z3vR9m', 'W2bN5t', 'Y8cL4f', 'H6jD0s', 'Ga'].join('');
const CALENDAR_ID = ['c5j9o2', 'r2m1k3', 'l8h4g6', 'f7d0s9', 'a1'].join('');
// the private words: an invented person and an invented building firm
const WORDS = ['Wendrich', 'Halvorsen Bau'];

/** A small shop whose repo mixes the system, this installation's setup and the owner's content. */
function layeredShop() {
  const files = {
    'shop/package.json': JSON.stringify({ name: 'shop', type: 'module' }),
    'shop/src/server.js': [
      `import { pages } from './notion.js';`,
      `import settings from '../config/settings.js';`,
      `import customers from '../content/customers.json';`,
      `export const start = () => pages(settings, customers);`,
    ].join('\n'),
    'shop/src/notion.js': [
      `// Reads the order pages from Notion.`,
      `const ORDERS_DB = '${UUID}';`,
      `const NIL = '00000000-0000-0000-0000-000000000000';`,
      `export const pages = () => fetch('https://api.notion.com/v1/databases/' + ORDERS_DB + NIL.slice(0, 0));`,
    ].join('\n'),
    'shop/src/calendar.js': [
      `export const CALENDAR = '${HEX}';`,
      `export const COMMIT = '9fceb02d0ae598e95dc970b74767f19372d61af8';`,
      `export const SHEET = '${TOKEN}';`,
      `export const BANNER = 'spring-sale-2026-banner-v2';`,
    ].join('\n'),
    'shop/src/pay.js': `export const KEY = '${STRIPE_KEY}';\n`,
    'shop/src/mail.js': [
      `// Replies go to hello@quietbakery.io`,
      `export const SUPPORT = 'someone@example.com';`,
      `export const PHONE = '+49 30 4821937';`,
      `export const SENDER = 'noreply@quietbakery.io';`,
      `export const SHARED = '${CALENDAR_ID}@group.calendar.google.com';`,
    ].join('\n'),
    'shop/src/backup.js': [
      `export const TARGET = '/volume1/shop/backups';`,
      `export const LOGS = '/home/jdoe/shop/logs';`,
      `export const CI = '/home/runner/work/shop';`,
      `export const route = '/home/settings';`,
    ].join('\n'),
    'shop/src/thanks.js': `// Thanks to Wendrich for the first order.\nexport const fetchWendrichOrders = () => [];\nexport const unwendrich = 1;\n`,
    'shop/src/settings.local.js': `export const local = true;\n`,
    'shop/config/settings.js': [
      `// Setup for Halvorsen Bau: this installation's calendar, folder and address`,
      `export default { calendar: '${HEX}', folder: '/Users/jdoe/shop', mail: 'office@quietbakery.io' };`,
    ].join('\n'),
    'shop/config/customers/list.js': `export const list = [];\n`,
    'shop/content/customers.json': JSON.stringify([{ name: 'Wendrich' }]),
    'shop/content/import.js': `import { start } from '../src/server.js';\n// Wendrich and Halvorsen Bau\nexport const run = () => start();\n`,
    'shop/lib/a.js': `export const a = 1;\n`,
    'shop/lib/b.js': `export const b = 2;\n`,
    'shop/lib/data/c.js': `export const c = 3;\n`,
    'shop/lib/data/d.js': `export const d = 4;\n`,
    'shop/tests/server.test.js': `import customers from '../content/customers.json';\nconst ID = '${UUID}';\n// Wendrich\nexport default [customers, ID];\n`,
    'shop/docs/setup.md': `# Setup\n\nThe orders live in https://www.notion.so/Orders-${HEX}\n`,
  };
  const arch = {
    project: { name: 'Shop', summary: 'A sample shop.' },
    nodes: [
      { id: 'app', label: 'Shop app', kind: 'service', summary: 'The shop.', paths: ['shop/src/**'] },
      { id: 'setup', label: 'Setup', kind: 'config', summary: 'This installation.', paths: ['shop/config/**'] },
      { id: 'content', label: 'Content', kind: 'data', summary: 'The owner’s data.', paths: ['shop/content/**'] },
      { id: 'lib', label: 'Helpers', kind: 'library', summary: 'Helpers and their data.', paths: ['shop/lib/**'] },
      { id: 'tests', label: 'Tests', kind: 'test', summary: 'Tests.', paths: ['shop/tests/**'] },
      { id: 'notion', label: 'Notion', kind: 'external', summary: 'Pages.', hosts: ['api.notion.com'] },
    ],
  };
  return makeProject(files, { repos: ['shop'], arch });
}

let wordsDir, wordsFile;
const layersOf = (extra = {}) => ({
  layers: [
    { id: 'config', name: { en: 'Setup', de: 'Einrichtung' }, description: 'This installation.', patterns: ['shop/config/**', '**/*.local.js'] },
    { id: 'content', patterns: ['shop/content/**', 'shop/lib/data/**', 'shop/config/customers/**'] },
  ],
  default: 'system',
  privateWords: wordsFile,
  ...extra,
});
const layersFile = (root) => path.join(root, 'floorplan', 'layers.json');
const build = (root, ...args) => run('build.mjs', root, '--no-claude-md', ...args);
const buildOut = (root, ...args) => { try { return build(root, ...args); } catch (e) { return String(e.stdout) + String(e.stderr); } };
const fileLayer = (g, p) => g.files.find((f) => f.p === p)?.layer;
const node = (g, id) => g.nodes.find((n) => n.id === id);
const publish = (g, kind, layer = 'system') => g.health.issues.find((i) => i.group === 'publish' && i.kind === kind && i.layer === layer);
const places = (issue) => (issue?.locations || []).map((l) => `${l.file}:${l.line}`);

let root, graph, output;
before(() => {
  wordsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-words-'));
  wordsFile = path.join(wordsDir, 'private-words.txt');
  fs.writeFileSync(wordsFile, ['# names that must not be published', ...WORDS, 'X', ''].join('\n'));
  root = layeredShop();
  writeJson(layersFile(root), layersOf());
  output = scanAndBuild(root);
  graph = readGraph(root);
});
after(() => { cleanup(root); cleanup(wordsDir); });

// ---------- which file is in which layer ----------

test('each file takes the layer of the first pattern it matches, in the order of the list, else the default', () => {
  assert.equal(fileLayer(graph, 'shop/src/server.js'), 'system', 'no pattern: the default');
  assert.equal(fileLayer(graph, 'shop/config/settings.js'), 'config');
  assert.equal(fileLayer(graph, 'shop/src/settings.local.js'), 'config', 'the second pattern of a layer counts as much as the first');
  assert.equal(fileLayer(graph, 'shop/content/import.js'), 'content');
  assert.equal(fileLayer(graph, 'shop/config/customers/list.js'), 'config', 'config is listed first, so its pattern wins over content’s');
  // the list as the map shows it: in the file's order, with the default added, names in the map's language
  assert.deepEqual(graph.layers.list.map((l) => [l.id, l.name, l.files]), [['config', 'Setup', 3], ['content', undefined, 3], ['system', undefined, 10]]);
  assert.equal(graph.layers.list[0].description, 'This installation.');
  assert.deepEqual(graph.layers.list[0].patterns, ['shop/config/**', '**/*.local.js']);
  assert.equal(graph.layers.default, 'system');
  assert.match(output, /LAYERS {2}config 3 · content 3 · system 10 files on the map \(1 part mixed\)/);
  // with content first, the same file goes to content
  const r = layeredShop();
  try {
    const l = layersOf();
    writeJson(layersFile(r), { ...l, layers: [l.layers[1], l.layers[0]] });
    scanAndBuild(r);
    assert.equal(fileLayer(readGraph(r), 'shop/config/customers/list.js'), 'content');
  } finally { cleanup(r); }
});

test('a part takes the layer more than half of its files have, else it is mixed', () => {
  assert.equal(node(graph, 'app').layer, 'system');
  assert.deepEqual(node(graph, 'app').layers, { system: 7, config: 1 });
  assert.equal(node(graph, 'setup').layer, 'config');
  assert.equal(node(graph, 'content').layer, 'content');
  assert.equal(node(graph, 'lib').layer, 'mixed', 'two system files and two content files: neither has more than half');
  assert.deepEqual(node(graph, 'lib').layers, { system: 2, content: 2 });
  assert.equal(graph.layers.mixed, 1);
  assert.equal(node(graph, 'notion').layer, undefined, 'an outside service has no files, so no layer');
});

test('names follow the map\'s language, like the rest of it', () => {
  build(root, '--lang', 'de');
  try { assert.equal(readGraph(root).layers.list[0].name, 'Einrichtung'); } finally { build(root); }
});

// ---------- Publishability: the five checks ----------

test('ids of one installation in system code are a medium finding; the same in setup, tests, hashes, nil ids and slugs are not', () => {
  const issue = publish(graph, 'hardcoded-identifier');
  assert.ok(issue, JSON.stringify(graph.health.issues.map((i) => i.id)));
  assert.equal(issue.severity, 'medium');
  assert.equal(issue.group, 'publish');
  // a UUID, a 32-character hex id (also in a link in the docs), a generated-looking code, and a shared calendar's id;
  // not the nil UUID, a git commit, the slug "spring-sale-2026-banner-v2", the test's id or the setup's
  assert.deepEqual(places(issue), ['shop/docs/setup.md:3', 'shop/src/calendar.js:1', 'shop/src/calendar.js:3', 'shop/src/mail.js:5', 'shop/src/notion.js:2']);
  assert.match(issue.notes['f:shop/src/calendar.js'], /line 1: a 32-character id · line 3: a 32-character id/);
  assert.match(issue.detail, /an identifier of one installation sits in system code/i);
  assert.match(issue.detail, /move (it|them) to configuration/i);
  assert.match(issue.fix, /shop\/src\/notion\.js:2: a UUID-style id/);
  assert.match(issue.fix, /Do not print, echo or repeat any of these values/);
  // never the id itself
  const text = JSON.stringify(graph.health);
  for (const id of [UUID, HEX, TOKEN, CALENDAR_ID]) assert.ok(!text.includes(id), 'no id in the findings');
  // the Stripe key is the secret check's: found there, and not reported again as an id
  assert.ok(graph.health.issues.some((i) => i.kind === 'secret' && i.locations.some((l) => l.file === 'shop/src/pay.js')));
  assert.ok(!places(issue).some((p) => p.startsWith('shop/src/pay.js')));
  assert.equal(publish(graph, 'hardcoded-identifier', 'config'), undefined, 'ids are what a setup is for');
});

test('words from the private list are found in system and setup files, whole words in any case, and shown only by their first letter', () => {
  const sys = publish(graph, 'private-word', 'system'), setup = publish(graph, 'private-word', 'config');
  assert.ok(sys && setup);
  assert.equal(sys.severity, 'medium');
  assert.equal(setup.severity, 'medium');
  // "Wendrich" in a comment and in camelCase, and in a test (made-up names belong there); not inside "unwendrich"
  assert.deepEqual(places(sys), ['shop/src/thanks.js:1', 'shop/src/thanks.js:2', 'shop/tests/server.test.js:3']);
  assert.deepEqual(places(setup), ['shop/config/settings.js:1']);
  // content is the owner's own data: names are expected there
  assert.ok(![...places(sys), ...places(setup)].some((p) => p.startsWith('shop/content/')));
  // the first letter and a star for every other character
  assert.equal(sys.notes['f:shop/src/thanks.js'], 'line 1: W******* · line 2: W*******');
  assert.match(setup.detail, /H\*{12}/);
  assert.match(sys.fix, /Never write any of these words/);
});

test('the check never writes a private word: not in the findings, the layers, the scan\'s findings or what the build prints', () => {
  // (the map still shows the code's own names, like the export fetchWendrichOrders, as it always has)
  const g = readGraph(root), scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  const written = JSON.stringify([g.health, g.layers, scan.files.map((f) => f.issues || [])]) + output;
  for (const w of WORDS) for (const part of w.split(' ')) assert.ok(!written.toLowerCase().includes(part.toLowerCase()), `"${part[0]}…" is written by the check`);
  // the list stays where it is, and its path isn't copied into the map either
  assert.ok(!JSON.stringify(g).includes('private-words'));
  assert.ok(!fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8').includes('private-words'));
});

test('contact details in system code are a minor finding; example addresses, noreply, ids that look like addresses and the setup are left alone', () => {
  const issue = publish(graph, 'contact-data');
  assert.ok(issue);
  assert.equal(issue.severity, 'low');
  assert.deepEqual(places(issue), ['shop/src/mail.js:1', 'shop/src/mail.js:3']);
  assert.match(issue.detail, /contains an email address and a phone number/);
  assert.equal(issue.notes['f:shop/src/mail.js'], 'line 1: an email address · line 3: a phone number');
  assert.ok(!JSON.stringify(issue).includes('quietbakery'), 'no address in the finding');
  assert.equal(publish(graph, 'contact-data', 'config'), undefined);
});

test('absolute paths of one computer in system code are a minor finding; CI folders, routes and the setup are not', () => {
  const issue = publish(graph, 'machine-path');
  assert.ok(issue);
  assert.equal(issue.severity, 'low');
  assert.deepEqual(places(issue), ['shop/src/backup.js:1', 'shop/src/backup.js:2']);
  assert.match(issue.notes['f:shop/src/backup.js'], /line 1: a folder on one NAS \(\/volume1\/…\) · line 2: a home folder on one Linux machine \(\/home\/…\)/);
  assert.ok(!JSON.stringify(issue).includes('jdoe'), 'no user name in the finding');
});

test('system code that imports content is a medium finding; importing the setup, content importing the system and tests are not', () => {
  const issue = publish(graph, 'layer-mixing');
  assert.ok(issue);
  assert.equal(issue.severity, 'medium');
  assert.deepEqual(places(issue), ['shop/src/server.js:3']);
  assert.match(issue.detail, /system depends on content: the system will not run without this owner's content/i);
  assert.match(issue.fix, /shop\/src\/server\.js:3: imports shop\/content\/customers\.json/);
  // the scan records the line of each import for this
  const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  assert.equal(scan.edges.find((e) => e.from === 'shop/src/server.js' && e.to === 'shop/content/customers.json').line, 3);
});

test('Publishability is a group of its own: counted apart, by layer, and never pushing a Health finding off the list', () => {
  const pub = graph.health.issues.filter((i) => i.group === 'publish');
  assert.equal(pub.length, 6);
  const count = (layer) => pub.filter((i) => i.layer === layer).reduce((s, i) => s + i.locations.length, 0);
  assert.deepEqual(graph.health.publish, { system: count('system'), config: count('config'), words: 'checked' });
  assert.equal(graph.health.publish.config, 1);
  assert.match(output, new RegExp(`PUBLISHABILITY {2}${count('system')} findings in system, 1 in config\\n`));
  // the usual summary counts only the usual checks, and they all come first
  const usual = graph.health.issues.filter((i) => i.group !== 'publish');
  for (const sev of ['high', 'medium', 'low']) assert.equal(graph.health.summary[sev], usual.filter((i) => i.severity === sev).length);
  assert.ok(graph.health.issues.findIndex((i) => i.group === 'publish') === usual.length);
  assert.doesNotMatch(output.split('PUBLISHABILITY')[0], /identifier of one installation/, 'the HEALTH lines list only the usual checks');
});

test('a missing word list is a note in the build, and the other checks still run', () => {
  const r = layeredShop();
  try {
    writeJson(layersFile(r), layersOf({ privateWords: path.join(wordsDir, 'not-there.txt') }));
    const out = scanAndBuild(r);
    assert.match(out, /layers\.json privateWords: there is no file at .*not-there\.txt, so the private-word check was skipped/);
    assert.match(out, /private words not checked \(no word list at the path in layers\.json\)/);
    const g = readGraph(r);
    assert.equal(g.health.publish.words, 'missing');
    assert.equal(g.health.issues.filter((i) => i.kind === 'private-word').length, 0);
    assert.ok(publish(g, 'hardcoded-identifier'));
    // no list named at all: said too
    writeJson(layersFile(r), layersOf({ privateWords: undefined }));
    assert.match(build(r), /private words not checked \(no "privateWords" in layers\.json\)/);
    assert.equal(readGraph(r).health.publish.words, 'unset');
  } finally { cleanup(r); }
});

test('a word list inside the repo that git doesn\'t ignore is a warning, and the list itself isn\'t searched', () => {
  const r = layeredShop();
  try {
    fs.copyFileSync(wordsFile, path.join(r, 'shop', 'private-words.txt'));
    writeJson(layersFile(r), layersOf({ privateWords: 'shop/private-words.txt' }));
    const out = scanAndBuild(r);
    assert.match(out, /privateWords points inside the project \(shop\/private-words\.txt\), and git doesn't ignore it/);
    const g = readGraph(r);
    assert.ok(!g.health.issues.some((i) => (i.locations || []).some((l) => l.file === 'shop/private-words.txt')));
    assert.ok(publish(g, 'private-word'), 'the check still runs');
  } finally { cleanup(r); }
});

test('mistakes in layers.json are errors that name the field and suggest the likely value', () => {
  const r = layeredShop();
  try {
    run('scan.mjs', r);
    writeJson(layersFile(r), {
      layers: [{ id: 'sytem', patterns: ['shop/src/**'] }, { id: 'config', patterns: 'shop/config/**' }, { id: 'config', patterns: [] }, { patterns: [] }, 'content'],
      default: 'contnet', privateWord: 'x.txt',
    });
    const out = buildOut(r);
    assert.match(out, /error\(s\) in floorplan\/architecture\.json or layers\.json/);
    assert.match(out, /layers\.json: unknown field "privateWord" — did you mean "privateWords"\?/);
    assert.match(out, /layers\.json layers\[0\] \("sytem"\)\.id "sytem" must be one of system, config, content — did you mean "system"\?/);
    assert.match(out, /layers\.json layers\[1\] \("config"\)\.patterns must be a list of globs/);
    assert.match(out, /layers\.json layers\[2\] \("config"\)\.id duplicates an earlier layer/);
    assert.match(out, /layers\.json layers\[3\]\.id is required, one of system, config, content/);
    assert.match(out, /layers\.json layers\[4\] must be an object/);
    assert.match(out, /layers\.json default "contnet" must be one of system, config, content — did you mean "content"\?/);
    fs.writeFileSync(layersFile(r), '{');
    assert.match(buildOut(r), /layers\.json is not valid JSON/);
    writeJson(layersFile(r), { layers: [] });
    assert.match(buildOut(r), /layers\.json "layers" must be a list of layers/);
    // a pattern that matches nothing is a warning, not an error
    writeJson(layersFile(r), { layers: [{ id: 'content', patterns: ['shop/nothing/**'] }] });
    assert.match(build(r), /layers\.json layers\[0\] \("content"\)\.patterns\[0\] "shop\/nothing\/\*\*" matches no file/);
  } finally { cleanup(r); }
});

test('without layers.json the build is unchanged: no layers on the map, no Publishability, nothing in the output', () => {
  const r = shopApp();
  try {
    const out = scanAndBuild(r);
    const g = readGraph(r);
    assert.equal(g.layers, undefined);
    assert.ok(g.files.every((f) => !('layer' in f)) && g.nodes.every((n) => !('layer' in n) && !('layers' in n)));
    assert.equal(g.health.publish, undefined);
    assert.equal(g.health.issues.filter((i) => i.group === 'publish').length, 0);
    assert.doesNotMatch(out, /LAYERS|PUBLISHABILITY/);
  } finally { cleanup(r); }
});

// ---------- the map ----------

const words = (lang) => ({ ...readJson(path.join(SKILL, 'assets', 'lang', 'en.json')), ...(lang === 'en' ? {} : readJson(path.join(SKILL, 'assets', 'lang', `${lang}.json`))) });
/** A stand-in for window.Floorplan, enough for a ui/ extension to run against a built graph. */
function standIn(g, lang = 'en', store = {}) {
  const w = words(lang);
  const t = (k, vars) => (w[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => (vars && x in vars ? String(vars[x]) : m));
  const tn = (k, n, vars) => t(w[`${k}.${n === 1 ? 'one' : 'other'}`] ? `${k}.${n === 1 ? 'one' : 'other'}` : `${k}.other`, { n, ...vars });
  const el = () => {
    const e = { children: [], style: { setProperty() {}, getPropertyValue: () => '' }, attrs: {}, classList: new Set(), appendChild: (c) => { e.children.push(c); return c; }, remove() {}, setAttribute: (k, v) => { e.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
    // like a DOMTokenList: add and remove take several names
    const put = Set.prototype.add.bind(e.classList), del = e.classList.delete.bind(e.classList);
    e.classList.add = (...c) => c.forEach((x) => put(x)); e.classList.remove = (...c) => c.forEach((x) => del(x));
    e.classList.toggle = (c, on) => { if (on ?? !e.classList.has(c)) put(c); else del(c); };
    return e;
  };
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const files = new Map(g.files.map((f) => [f.p, f]));
  const info = (id) => id.startsWith('n:') ? { type: 'node', name: nodes.get(id.slice(2)).label, kind: nodes.get(id.slice(2)).kind, n: nodes.get(id.slice(2)) } : { type: 'file', name: files.get(id.slice(2))?.name || id, kind: 'file', path: id.slice(2), f: files.get(id.slice(2)) };
  const chain = (id) => { const out = [id]; let n = id.startsWith('f:') ? files.get(id.slice(2))?.n : nodes.get(id.slice(2))?.parent; while (n) { out.push('n:' + n); n = nodes.get(n)?.parent; } return [...out, 'root']; };
  const out = { buttons: [], sections: { overview: [], item: [] }, listeners: {}, panels: [], refreshed: 0 };
  const SC = {
    graph: g, lang, t, tn, h: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), exported: null, agent: { name: 'Claude', app: 'Claude Code' },
    info, nodes, files, routes: g.routes, exists: (id) => id.startsWith('n:') ? nodes.has(id.slice(2)) : files.has(id.slice(2)), chain,
    icon: () => '<svg></svg>', iconI: () => '<svg></svg>', icons: {}, technical: () => false, state: { chipEls: new Map(), edgeEls: new Map(), layout: { children: [] } },
    store: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } },
    // like the viewer's: a header button holds its icon as svg.i, which Health swaps for a check mark when all is calm
    addHeaderButton: (b) => { const e = el(), icon = el(); e.querySelector = (sel) => (sel === 'svg.i' ? icon : null); out.buttons.push({ ...b, el: e }); return e; },
    addPanelSection: (where, fn) => out.sections[where].push(fn),
    showPanel: (html) => out.panels.push(html), closePanel() {}, refreshPanel: () => out.refreshed++, showBoard: (b) => { out.board = b; }, on: (ev, fn) => (out.listeners[ev] ||= []).push(fn),
    toast() {}, modal() {}, copy() {}, canChange: () => false,
  };
  const document = { createElement: () => el(), createElementNS: () => el(), head: el(), querySelector: () => null, querySelectorAll: () => [] };
  return { SC, out, el, document, store };
}
function runUi(file, s) {
  s.win = { Floorplan: s.SC };
  vm.runInNewContext(fs.readFileSync(path.join(SKILL, 'assets', 'ui', file), 'utf8'), { window: s.win, document: s.document });
  return s;
}
/** Puts a card on the stand-in map for an item, as the viewer draws it, and returns its group and card. */
function chip(s, id) {
  const card = s.el(), g = s.el();
  // like the page: a tag put on the box can be found by its class again, and removed
  g.appendChild = (c) => { g.children.push(c); c.remove = () => g.children.splice(g.children.indexOf(c), 1); return c; };
  g.querySelector = (sel) => (sel === '.card' ? card : sel === '.ly-tag' ? g.children.find((c) => /\bly-tag\b/.test(c.attrs.class || '')) || null : null);
  s.SC.state.chipEls.set(id, g);
  s.SC.state.layout.children.push({ id, x: 0, y: 0, width: 300, height: 128 });
  return { g, card };
}

test('the Layers switch colours every box by its layer, with a tag, and the panel has a legend that shows one layer only', () => {
  const s = runUi('37-layers.js', standIn(graph));
  assert.equal(s.out.buttons.length, 1);
  assert.equal(s.out.buttons[0].label, 'Layers');
  const app = chip(s, 'n:app'), lib = chip(s, 'n:lib'), conf = chip(s, 'f:shop/config/settings.js'), ext = chip(s, 'n:notion');
  const render = () => { for (const fn of s.out.listeners.render || []) fn({}); };
  render();
  assert.ok(![...app.card.classList].some((c) => c.startsWith('ly')), 'off until switched on');
  s.out.buttons[0].onClick();
  assert.equal(s.store.layers, true, 'the choice is remembered');
  assert.equal(s.out.buttons[0].el.attrs['aria-pressed'], 'true');
  render();
  assert.ok(app.card.classList.has('ly-system'));
  assert.ok(lib.card.classList.has('ly-mixed'));
  assert.ok(conf.card.classList.has('ly-config'));
  assert.ok(![...ext.card.classList].some((c) => c.startsWith('ly-')), 'an outside service has no layer');
  assert.equal(app.g.children.length, 1, 'a tag on the box');
  // the legend: each layer with its name and files, and mixed parts
  const ov = s.out.sections.overview.map((fn) => fn()).find(Boolean);
  for (const x of ['Layers', 'Setup', 'Content', 'System', 'Mixed', '3 files', '10 files', '1 part', 'data-ly="config"']) assert.ok(ov.html.includes(x), `"${x}" is in the legend`);
  // show only one layer (what a legend row does): the others fade, and a part with some of it stays
  s.win.FloorplanLayers.only('config');
  render();
  assert.ok(!app.g.classList.has('ly-out'), 'the app part has a setup file, so it stays');
  assert.ok(lib.g.classList.has('ly-out'), 'the helpers have no setup file');
  assert.ok(!conf.g.classList.has('ly-out'));
  assert.ok(ext.g.classList.has('ly-out'));
  assert.match(s.out.sections.overview.map((fn) => fn()).find(Boolean).html, /Show all layers/);
  s.win.FloorplanLayers.only('config');
  render();
  assert.ok(!lib.g.classList.has('ly-out'), 'the same row again shows every layer');
  // the details panel names the layer of a file and of a part
  const item = (id) => s.out.sections.item.map((fn) => fn(id)).find(Boolean)?.html || '';
  assert.match(item('f:shop/config/settings.js'), /Setup/);
  assert.match(item('n:lib'), /Mixed/);
  assert.match(item('n:lib'), /2 System/);
  assert.equal(item('n:notion'), '');
});

test('in German the switch says Schichten, and the layers Einrichtung, Inhalt and Gemischt', () => {
  build(root, '--lang', 'de');
  try {
    const s = runUi('37-layers.js', standIn(readGraph(root), 'de', { layers: true }));
    assert.equal(s.out.buttons[0].label, 'Schichten');
    const ov = s.out.sections.overview.map((fn) => fn()).find(Boolean).html;
    for (const x of ['Schichten', 'Einrichtung', 'Inhalt', 'Gemischt']) assert.ok(ov.includes(x), `"${x}" is in the German legend`);
  } finally { build(root); }
});

test('without layers the switch adds nothing to the map', () => {
  const s = runUi('37-layers.js', standIn({ ...graph, layers: undefined }));
  assert.equal(s.out.buttons.length, 0);
  assert.equal(s.out.sections.overview.length + s.out.sections.item.length, 0);
});

test('the Health panel shows Publishability as its own group, with the count by layer, and leaves it out of the headline', () => {
  const s = runUi('20-health.js', standIn(graph));
  const btn = s.out.buttons[0];
  s.out.buttons[0].onClick();
  const html = s.out.panels.at(-1);
  assert.ok(html.includes('Publishability'));
  const n = graph.health.publish.system;
  assert.ok(html.includes(`${n} findings in System, 1 in Setup`), 'the summary, with the layers’ names');
  assert.ok(html.includes('An identifier of one installation sits in system code'));
  // the headline and the badge count only the usual checks
  const urgent = graph.health.issues.filter((i) => i.group !== 'publish' && i.severity !== 'low').length;
  assert.equal(btn.el.children.find((c) => c.className === 'badge')?.textContent, String(urgent));
  const ov = s.out.sections.overview.map((fn) => fn()).find(Boolean).html;
  assert.ok(ov.includes('Publishability') && ov.includes(`${n} findings in System, 1 in Setup`));
});

test('a Publishability finding marked "not a problem" leaves its count by layer, never the usual summary, and goes to the end of the list', () => {
  const r = layeredShop();
  try {
    writeJson(layersFile(r), layersOf());
    scanAndBuild(r);
    const first = readGraph(r).health;
    const issue = publish({ health: first }, 'hardcoded-identifier');
    assert.equal(issue.finds, issue.locations.length, 'each finding says how many places it counts');
    assert.equal(first.publish.system, first.issues.filter((i) => i.group === 'publish' && i.layer === 'system').reduce((s, i) => s + i.finds, 0));
    writeJson(path.join(r, 'floorplan', 'health-dismissed.json'), { dismissed: [{ id: issue.id, severity: issue.severity, locations: places(issue), reason: 'a fixed id of a public service' }] });
    const out = build(r);
    const g = readGraph(r);
    assert.deepEqual(g.health.summary, first.summary, 'the usual checks count as before');
    assert.deepEqual(g.health.publish, { ...first.publish, system: first.publish.system - issue.finds });
    assert.equal(g.health.issues.length, first.issues.length, 'it stays listed');
    assert.match(out, new RegExp(`PUBLISHABILITY {2}${first.publish.system - issue.finds} findings in system, 1 in config\\n`));
    assert.ok(!out.includes(`] ${issue.title}`), 'the build report leaves it out');
    // the panel: out of its group and the group's count, at the end with its reason; the badge counts the usual checks
    const s = runUi('20-health.js', standIn(g));
    s.out.buttons[0].onClick();
    const html = s.out.panels.at(-1);
    const marked = html.indexOf('Marked as not a problem <span class="c">1</span>');
    assert.ok(marked > html.indexOf('Publishability'), 'the marked ones come last');
    assert.ok(html.indexOf(issue.title) > marked, 'and it is among them');
    assert.ok(html.includes(`${first.publish.system - issue.finds} findings in System, 1 in Setup`));
    assert.ok(html.includes('Marked as not a problem: a fixed id of a public service') && html.includes('Show again'));
    const urgent = g.health.issues.filter((i) => i.group !== 'publish' && i.severity !== 'low').length;
    assert.equal(s.out.buttons[0].el.children.find((c) => c.className === 'badge')?.textContent, String(urgent));
  } finally { cleanup(r); }
});

test('an exported copy keeps the layers; Publishability goes along only with Health', () => {
  const serve = path.join(root, 'floorplan', 'serve.mjs');
  const exportTo = (file, ...args) => { execFileSync(process.execPath, [serve, '--export', file, ...args], { cwd: root, encoding: 'utf8' }); return JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(fs.readFileSync(file, 'utf8'))[1]); };
  const plain = exportTo(path.join(root, 'plain.html'));
  assert.deepEqual(plain.layers, graph.layers);
  assert.equal(plain.files.find((f) => f.p === 'shop/config/settings.js').layer, 'config');
  assert.equal(plain.health, undefined);
  const withHealth = exportTo(path.join(root, 'health.html'), '--include', 'health');
  assert.deepEqual(withHealth.health.publish, graph.health.publish);
});
