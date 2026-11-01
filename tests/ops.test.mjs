// Operations: floorplan/ops.json is what the owner's own tooling reports about the running system, a status, version
// and last runs per part, file, endpoint or target. The build checks it and puts it in graph.ops (refs that aren't
// on the map are left out with a warning, bad fields are warnings, a file older than a day is stale), never into
// MAP.md; in "git": "inputs" mode the folder ignores it; serve.mjs hands it out so the map can refresh it; the Ops
// switch on the map gives each box a status dot and lists the items. Without the file, nothing changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { SKILL, makeProject, shopApp, scanAndBuild, run, readGraph, readJson, writeJson, cleanup } from './helpers.mjs';

const FIXTURE = readJson(path.join(SKILL, '..', '..', 'tests', 'fixtures', 'ops.json'));
const opsFile = (root) => path.join(root, 'floorplan', 'ops.json');
const build = (root, ...args) => run('build.mjs', root, '--no-claude-md', ...args);
const buildOut = (root, ...args) => { try { return build(root, ...args); } catch (e) { return String(e.stdout) + String(e.stderr); } };
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
/** The fixture with a fresh "asOf", so the sample is never stale by the calendar. */
const fresh = (extra = {}) => ({ ...FIXTURE, asOf: hoursAgo(1), ...extra });

let root, graph, output;
before(() => { root = shopApp(); writeJson(opsFile(root), fresh()); output = scanAndBuild(root); graph = readGraph(root); });
after(() => cleanup(root));

test('a valid file lands in graph.ops: every item with its box, status, version, runs, error, note and metrics, plus the counts', () => {
  assert.equal(graph.ops.source, 'tools/ops-export.sh');
  assert.equal(graph.ops.stale, false);
  assert.ok(!Number.isNaN(Date.parse(graph.ops.asOf)));
  assert.deepEqual(graph.ops.counts, { ok: 1, warn: 1, down: 1, unknown: 1 });
  assert.deepEqual(graph.ops.items.map((it) => [it.id, it.status]), [['n:api', 'ok'], ['f:shop-api/routes/orders.js', 'warn'], ['r:1', 'down'], ['n:web', 'unknown']]);
  assert.equal(graph.routes[1].p, '/api/notes', 'an endpoint by "METHOD /path"');
  const api = graph.ops.items[0];
  assert.equal(api.ref, 'api');
  assert.equal(api.version, 'v2026.11.01');
  assert.equal(api.lastRun, '2026-11-01T03:40:00+01:00');
  assert.equal(api.lastOk, '2026-11-01T03:40:00+01:00');
  assert.equal(api.lastError, undefined, 'an empty field is left out');
  assert.equal(api.note, 'Cron every 5 min');
  assert.deepEqual(api.metrics, { 'runs today': 12, queue: 0 });
  assert.equal(graph.ops.items[2].lastError, '503 from the notes service');
  assert.equal(graph.ops.items[3].status, 'unknown', 'no status means unknown');
  assert.match(output, /OPS {2}4 items: 1 ok · 1 warn · 1 down · 1 unknown \(as of \d{4}-/);
  assert.doesNotMatch(output, /warning\(s\)/);
});

test('a ref that is not on the map is a warning and the item is left out; a bad status or field is a warning, never an error', () => {
  const r = shopApp();
  try {
    writeJson(opsFile(r), fresh({ items: [
      { ref: 'api', status: 'running', version: 7, lastRun: 'yesterday', note: 'first line\nsecond line' },
      { ref: 'billing', status: 'ok' },
      { ref: 'shop-api/nothing.js' },
      { ref: 'GET /nowhere' },
      { status: 'ok' },
      'not an object',
      { ref: 'web', metrics: 'lots' },
    ] }));
    const out = scanAndBuild(r);
    const g = readGraph(r);
    assert.deepEqual(g.ops.items.map((it) => [it.id, it.status]), [['n:api', 'unknown'], ['n:web', 'unknown']]);
    assert.equal(g.ops.items[0].version, '7', 'a number is text');
    assert.equal(g.ops.items[0].note, 'first line', 'one line each');
    assert.equal(g.ops.items[1].metrics, undefined);
    assert.match(out, /ops\.json: 4 ref\(s\) aren't on the map and were left out \(use a node id, a file path, "METHOD \/path" or a target id with a box\): billing, shop-api\/nothing\.js, GET \/nowhere, ops\.json items\[4\] \(no ref\)/);
    assert.match(out, /ops\.json items\[0\]\.status "running" is not one of ok, warn, down, unknown; shown as unknown/);
    assert.match(out, /ops\.json items\[0\]\.lastRun "yesterday" is not a date \(ISO 8601\)/);
    assert.match(out, /ops\.json items\[5\] must be an object with a "ref"/);
    assert.match(out, /ops\.json items\[6\]\.metrics must be an object/);
    assert.match(out, /OPS {2}2 items: 0 ok · 0 warn · 0 down · 2 unknown/);
    assert.ok(fs.existsSync(path.join(r, 'floorplan', 'index.html')), 'the build went through');
    // a file that is not JSON, or not an object, is a warning too
    fs.writeFileSync(opsFile(r), '{');
    assert.match(build(r), /ops\.json is not valid JSON/);
    writeJson(opsFile(r), [1, 2]);
    const out2 = build(r);
    assert.match(out2, /ops\.json must be an object/);
    assert.match(out2, /OPS {2}none \(nothing in ops\.json is on the map\)/);
    assert.equal(readGraph(r).ops, undefined);
  } finally { cleanup(r); }
});

test('a missing "asOf" is a warning, and the file\'s own time stands in', () => {
  const r = shopApp();
  try {
    const { asOf, ...noTime } = FIXTURE;
    writeJson(opsFile(r), noTime);
    const out = scanAndBuild(r);
    assert.match(out, /ops\.json needs "asOf", the time it was written \(ISO 8601\); using the file's modification time/);
    const g = readGraph(r);
    assert.ok(Math.abs(Date.parse(g.ops.asOf) - Date.now()) < 60000, 'the modification time, just now');
    assert.equal(g.ops.stale, false);
    writeJson(opsFile(r), { ...FIXTURE, asOf: 'last night' });
    assert.match(build(r), /ops\.json "asOf" "last night" is not a date \(ISO 8601, like 2026-11-01T04:00:00\+01:00\); using the file's modification time/);
  } finally { cleanup(r); }
});

test('a file older than a day is stale: a warning, "stale: true" in graph.ops and the OPS line says so', () => {
  const r = shopApp();
  try {
    const old = hoursAgo(30);
    writeJson(opsFile(r), fresh({ asOf: old }));
    const out = scanAndBuild(r);
    assert.match(out, new RegExp(`ops\\.json is stale: as of ${old.replace(/[.+]/g, '\\$&')}, more than 24 hours ago\\. Check that the script that writes it still runs\\.`));
    assert.match(out, new RegExp(`OPS {2}stale: as of ${old.replace(/[.+]/g, '\\$&')} \\(more than 24 hours ago\\) · 4 items: 1 ok · 1 warn · 1 down · 1 unknown`));
    assert.equal(readGraph(r).ops.stale, true);
    writeJson(opsFile(r), fresh({ asOf: hoursAgo(23) }));
    assert.doesNotMatch(build(r), /stale/);
    assert.equal(readGraph(r).ops.stale, false);
  } finally { cleanup(r); }
});

test('a target id from targets.json marks the target\'s box; a target without a box is left out with the others', () => {
  const files = {
    'shop-api/package.json': JSON.stringify({ name: 'shop-api', type: 'module', dependencies: { pg: '^8.12.0' } }),
    'shop-api/db.js': "import pg from 'pg';\nexport const pool = new pg.Pool();\n",
    'shop-api/config.js': 'export const PORT = 3000;\n',
  };
  const arch = { project: { name: 'Shop' }, nodes: [
    { id: 'api', label: 'Server', kind: 'service', summary: 'The shop server.', paths: ['shop-api/**'] },
    { id: 'db', label: 'Database', kind: 'external', summary: 'Where orders are kept.', packages: ['pg'] },
  ] };
  const r = makeProject(files, { repos: ['shop-api'], arch });
  try {
    writeJson(path.join(r, 'floorplan', 'targets.json'), { targets: [
      { id: 'orders', name: 'Orders', kind: 'database', external: 'db', writers: ['api'], policy: 'single-writer' },
      { id: 'settings', name: 'Settings file', kind: 'file', writers: ['shop-api/config.js'], policy: 'any' },
    ] });
    writeJson(opsFile(r), fresh({ items: [{ ref: 'orders', status: 'warn', note: 'Backup overdue' }, { ref: 'settings', status: 'ok' }, { ref: 'api', status: 'ok' }] }));
    const out = scanAndBuild(r);
    const g = readGraph(r);
    assert.deepEqual(g.ops.items.map((it) => [it.ref, it.id, it.status]), [['orders', 'n:db', 'warn'], ['api', 'n:api', 'ok']]);
    assert.match(out, /ops\.json: 1 ref\(s\) aren't on the map and were left out .*: settings/);
    // a node id wins over a target with the same id
    writeJson(path.join(r, 'floorplan', 'targets.json'), { targets: [{ id: 'api', name: 'The API', kind: 'service', external: 'db', writers: [], policy: 'any' }] });
    writeJson(opsFile(r), fresh({ items: [{ ref: 'api', status: 'down' }] }));
    build(r);
    assert.deepEqual(readGraph(r).ops.items.map((it) => it.id), ['n:api']);
  } finally { cleanup(r); }
});

test('MAP.md says nothing about operations: it would change with every run', () => {
  const md = fs.readFileSync(path.join(root, 'floorplan', 'MAP.md'), 'utf8');
  assert.doesNotMatch(md, /ops\.json|Operations|floorplan:ops|v2026\.11\.01|Cron every 5 min/);
  const r = shopApp();
  try {
    scanAndBuild(r);
    const without = fs.readFileSync(path.join(r, 'floorplan', 'MAP.md'), 'utf8');
    assert.equal(without, md, 'the same text with and without the file');
  } finally { cleanup(r); }
});

test('with "git": "inputs" the folder ignores ops.json, like recent-work.json; without the field it ignores itself as before', () => {
  const r = shopApp();
  try {
    const archFile = path.join(r, 'floorplan', 'architecture.json');
    writeJson(archFile, { ...readJson(archFile), git: 'inputs' });
    writeJson(opsFile(r), fresh());
    execFileSync('git', ['init', '-q', r]);
    scanAndBuild(r);
    const ignore = fs.readFileSync(path.join(r, 'floorplan', '.gitignore'), 'utf8');
    assert.match(ignore, /^\/ops\.json$/m);
    assert.match(ignore, /^\/recent-work\.json$/m);
    assert.match(execFileSync('git', ['-C', r, 'check-ignore', '--no-index', 'floorplan/ops.json'], { encoding: 'utf8' }), /floorplan\/ops\.json/);
    assert.doesNotMatch(execFileSync('git', ['-C', r, 'status', '--porcelain', '-uall', 'floorplan'], { encoding: 'utf8' }), /ops\.json/);
    const arch = readJson(archFile);
    delete arch.git;
    writeJson(archFile, arch);
    build(r);
    assert.equal(fs.readFileSync(path.join(r, 'floorplan', '.gitignore'), 'utf8'), '# Floorplan keeps its map out of git: this ignores everything in this folder, this file included.\n*\n');
  } finally { cleanup(r); }
});

test('an exported copy leaves operations out unless asked for, like recent work', () => {
  const copy = path.join(root, 'copy.html');
  const data = (file) => JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(fs.readFileSync(file, 'utf8'))[1]);
  execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', copy], { cwd: root, encoding: 'utf8' });
  assert.equal(data(copy).ops, undefined);
  const out = execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', copy, '--include', 'flows,ops'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /Includes: the map, flows and the tour, operations\./);
  assert.equal(data(copy).ops.items.length, 4);
  const page = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.ok(page.includes("{ id: 'ops', label: t('export.part.ops')"), 'the Export dialog offers it');
});

test('without ops.json the build is unchanged: no graph.ops, "OPS  none", nothing on the map', () => {
  const r = shopApp();
  try {
    const out = scanAndBuild(r);
    assert.equal(readGraph(r).ops, undefined);
    assert.match(out, /OPS {2}none \(no ops\.json\)/);
    const strip = (x) => JSON.stringify({ ...x, meta: { ...x.meta, generatedAt: null } });
    const g = readGraph(r);
    writeJson(opsFile(r), fresh({ items: [] }));
    assert.match(build(r), /OPS {2}none \(nothing in ops\.json is on the map\)/);
    assert.equal(strip(readGraph(r)), strip(g), 'an empty list changes nothing either');
  } finally { cleanup(r); }
});

// ---------- the map's server hands the file out ----------

test('serve.mjs serves ops.json from the map folder, so the map can fetch it again without a rebuild', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_NO_PROMPTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const base = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
      server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
      server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
    });
    const r = await fetch(base + '/ops.json');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal((await r.json()).items.length, 4);
    // the file as it is now, not as the build saw it
    writeJson(opsFile(root), fresh({ items: [{ ref: 'api', status: 'down', lastError: 'Rewritten by the cron' }] }));
    const again = await (await fetch(base + '/ops.json')).json();
    assert.equal(again.items[0].lastError, 'Rewritten by the cron');
    // only this folder's files, and only through this machine's own name
    assert.equal((await fetch(base + '/../shop-api/config.js')).status, 404);
    const status = await new Promise((resolve, reject) => { const u = new URL(base); http.get({ hostname: u.hostname, port: u.port, path: '/ops.json', headers: { host: `evil.example:${u.port}` } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
    assert.equal(status, 403);
    fs.unlinkSync(opsFile(root));
    assert.equal((await fetch(base + '/ops.json')).status, 404, 'gone from the folder, gone from the server');
  } finally {
    if (server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
    writeJson(opsFile(root), fresh());
  }
});

// ---------- the Ops switch and panel, run against a stand-in map ----------

const words = (lang) => ({ ...readJson(path.join(SKILL, 'assets', 'lang', 'en.json')), ...(lang === 'en' ? {} : readJson(path.join(SKILL, 'assets', 'lang', `${lang}.json`))) });
/** A stand-in for window.Floorplan, enough for ui/27-ops.js to run against a built graph. */
function standIn(g, lang = 'en', store = {}) {
  const w = words(lang);
  const t = (k, vars) => (w[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => (vars && x in vars ? String(vars[x]) : m));
  const tn = (k, n, vars) => t(w[`${k}.${n === 1 ? 'one' : 'other'}`] ? `${k}.${n === 1 ? 'one' : 'other'}` : `${k}.other`, { n, ...vars });
  const el = () => {
    const e = { children: [], style: { props: {}, setProperty(k, v) { e.style.props[k] = v; }, getPropertyValue: () => '' }, attrs: {}, classList: new Set(), appendChild: (c) => { e.children.push(c); c.remove = () => e.children.splice(e.children.indexOf(c), 1); return c; }, remove() {}, setAttribute: (k, v) => { e.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
    const put = Set.prototype.add.bind(e.classList), del = e.classList.delete.bind(e.classList);
    e.classList.add = (...c) => c.forEach((x) => put(x)); e.classList.remove = (...c) => c.forEach((x) => del(x));
    e.classList.toggle = (c, on) => { if (on ?? !e.classList.has(c)) put(c); else del(c); };
    return e;
  };
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const files = new Map(g.files.map((f) => [f.p, f]));
  const routes = g.routes || [];
  const info = (id) => id.startsWith('n:') ? { type: 'node', name: nodes.get(id.slice(2)).label, kind: nodes.get(id.slice(2)).kind }
    : id.startsWith('r:') ? { type: 'route', name: routes[+id.slice(2)].name, path: `${routes[+id.slice(2)].m} ${routes[+id.slice(2)].p}` }
    : { type: 'file', name: files.get(id.slice(2))?.name || id, kind: 'file', path: id.slice(2) };
  const exists = (id) => id.startsWith('n:') ? nodes.has(id.slice(2)) : id.startsWith('r:') ? !!routes[+id.slice(2)] : files.has(id.slice(2));
  const chain = (id) => {
    const out = [id];
    let n = id.startsWith('f:') ? files.get(id.slice(2))?.n : id.startsWith('r:') ? (out.push('f:' + routes[+id.slice(2)].f), files.get(routes[+id.slice(2)].f)?.n) : nodes.get(id.slice(2))?.parent;
    while (n) { out.push('n:' + n); n = nodes.get(n)?.parent; }
    return [...out, 'root'];
  };
  const out = { buttons: [], sections: { overview: [], item: [] }, tips: [], listeners: {}, panels: [], refreshed: 0, closed: 0 };
  const SC = {
    graph: g, lang, t, tn, h: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), exported: null,
    info, nodes, files, routes, exists, chain,
    icon: () => '<svg></svg>', iconI: () => '<svg></svg>', icons: {}, state: { chipEls: new Map(), edgeEls: new Map(), layout: { children: [] }, selected: null, container: 'root' },
    store: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } },
    addHeaderButton: (b) => { const e = el(); out.buttons.push({ ...b, el: e }); return e; },
    addPanelSection: (where, fn) => out.sections[where].push(fn),
    addTipSection: (fn) => out.tips.push(fn),
    showPanel: (html) => out.panels.push(html), closePanel: () => out.closed++, refreshPanel: () => out.refreshed++, on: (ev, fn) => (out.listeners[ev] ||= []).push(fn),
  };
  const document = { createElement: () => el(), createElementNS: () => el(), head: el(), querySelector: () => null, querySelectorAll: () => [] };
  return { SC, out, el, document, store };
}
function runUi(s) {
  vm.runInNewContext(fs.readFileSync(path.join(SKILL, 'assets', 'ui', '27-ops.js'), 'utf8'), { window: { Floorplan: s.SC }, document: s.document, setInterval() {}, Date, JSON });
  return s;
}
/** Puts a card on the stand-in map, as the viewer draws it, and returns its group. */
function chip(s, id) {
  const g = s.el();
  g.querySelector = (sel) => (sel === '.ops-dot' ? g.children.find((c) => /\bops-dot\b/.test(c.attrs.class || '')) || null : null);
  s.SC.state.chipEls.set(id, g);
  s.SC.state.layout.children.push({ id, x: 0, y: 0, width: 300, height: 128 });
  return g;
}
const dotOf = (g) => g.children.find((c) => /\bops-dot\b/.test(c.attrs.class || ''))?.attrs.class || null;

test('the Ops switch: a dot on every box with an item, the worst status for a part, and none when switched off', () => {
  const s = runUi(standIn(graph));
  assert.equal(s.out.buttons.length, 1);
  assert.equal(s.out.buttons[0].label, 'Ops');
  assert.equal(s.out.buttons[0].el.attrs['aria-pressed'], 'true', 'on by default');
  assert.equal(s.out.buttons[0].el.children.find((c) => c.className === 'badge')?.textContent, '2', 'down and warning items on the badge');
  const api = chip(s, 'n:api'), web = chip(s, 'n:web'), orders = chip(s, 'f:shop-api/routes/orders.js'), notes = chip(s, 'r:1'), other = chip(s, 'f:shop-api/auth.js'), conn = chip(s, 'x:in:n:web');
  const render = () => { for (const fn of s.out.listeners.render || []) fn({}); };
  render();
  assert.equal(dotOf(api), 'ops-dot ops-down', 'the server is ok itself, but an endpoint inside it is down');
  assert.equal(dotOf(web), 'ops-dot ops-unknown');
  assert.equal(dotOf(orders), 'ops-dot ops-warn');
  assert.equal(dotOf(notes), 'ops-dot ops-down');
  assert.equal(dotOf(other), null, 'a file without an item has no dot');
  assert.equal(dotOf(conn), null, 'connectors have none');
  assert.equal(api.children[0].attrs.transform, 'translate(288,0)', 'on the top right corner');
  s.out.buttons[0].onClick();
  assert.equal(s.store.ops, false, 'the choice is remembered');
  render();
  assert.equal(dotOf(api), null);
  assert.equal(s.out.tips[0]('n:api'), '', 'no hover lines either');
  s.out.buttons[0].onClick();
  assert.equal(s.out.panels.length, 1, 'switching on opens the list');
});

test('the hover lines: status, version, runs, error, note and metrics on a box, and what is inside a part', () => {
  const s = runUi(standIn(graph));
  const tip = s.out.tips[0];
  const api = tip('n:api');
  for (const x of ['ops-tip ops-ok', 'running', 'version v2026.11.01', 'last run', 'last ok', 'Cron every 5 min', '<b>runs today</b> 12', '<b>queue</b> 0', '2 inside, worst down', 'Router, Orders']) assert.ok(api.includes(x), `"${x}" is in the server's tooltip`);
  assert.ok(!api.includes('last error'), 'no error line without an error');
  const notes = tip('r:1');
  for (const x of ['ops-tip ops-down', 'down', 'last error: 503 from the notes service']) assert.ok(notes.includes(x), `"${x}" is in the endpoint's tooltip`);
  assert.equal(tip('m:shop-api/routes/orders.js'), tip('f:shop-api/routes/orders.js'), 'a file seen from inside is the same file');
  assert.equal(tip('f:shop-api/auth.js'), '');
});

test('the Operations panel lists every item worst first, each a link to its box, with the time, the source and a stale warning', () => {
  const s = runUi(standIn(graph));
  s.out.buttons[0].onClick(); s.out.buttons[0].onClick();
  const html = s.out.panels.at(-1);
  for (const x of ['Operations', '4 items', 'As of', 'Written by tools/ops-export.sh', 'Floorplan never writes this file', '1 down · 1 warning · 1 running · 1 unknown', 'data-ops-back']) assert.ok(html.includes(x), `"${x}" is in the panel`);
  const order = [...html.matchAll(/data-go="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['r:1', 'f:shop-api/routes/orders.js', 'n:api', 'n:web']);
  assert.ok(html.includes('last error: Timeout after 30 s'));
  assert.ok(!html.includes('Stale'), 'fresh data has no warning');
  assert.ok(!html.includes('every minute'), 'a static copy is not refreshed');
  // the codebase panel has a way in, and a selected box shows its own items and what is inside it
  const ov = s.out.sections.overview[0]();
  assert.ok(ov.html.includes('data-ops-open'));
  assert.ok(ov.html.includes('1 down · 1 warning · 1 running · 1 unknown'));
  const item = s.out.sections.item[0]('n:api');
  for (const x of ['Operations', 'ops-card ops-ok', 'Operations inside', 'data-go="r:1"', 'data-go="f:shop-api/routes/orders.js"', 'All items']) assert.ok(item.html.includes(x), `"${x}" is on the server's panel`);
  assert.equal(s.out.sections.item[0]('f:shop-api/auth.js'), '');
  // stale data: the warning in the panel and beside the time
  const old = runUi(standIn({ ...graph, ops: { ...graph.ops, asOf: hoursAgo(30) } }));
  old.out.buttons[0].onClick(); old.out.buttons[0].onClick();
  assert.ok(old.out.panels.at(-1).includes('<b>Stale</b> · This is more than a day old. Check that whatever writes ops.json still runs.'));
  assert.ok(old.out.sections.overview[0]().html.includes('· Stale'));
});

test('in German the switch says Betrieb and the panel läuft, Warnung, steht, unbekannt, Fassung and Veraltet', () => {
  build(root, '--lang', 'de');
  try {
    const s = runUi(standIn({ ...readGraph(root), ops: { ...graph.ops, asOf: hoursAgo(30) } }, 'de'));
    assert.equal(s.out.buttons[0].label, 'Betrieb');
    s.out.buttons[0].onClick(); s.out.buttons[0].onClick();
    const html = s.out.panels.at(-1);
    for (const x of ['Betrieb', '4 Einträge', 'Stand ', 'läuft', 'Warnung', 'steht', 'unbekannt', 'Fassung v2026.11.01', 'zuletzt gelaufen', 'letzter Fehler: 503', 'Veraltet', 'Geschrieben von tools/ops-export.sh']) assert.ok(html.includes(x), `"${x}" is in the German panel`);
    assert.ok(s.out.tips[0]('n:api').includes('zuletzt gut'));
  } finally { build(root); }
});

test('the built page carries the switch, the hover hook and the fetch from the map\'s own server, and no English outside the table', () => {
  const page = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.ok(page.includes('/* ui/27-ops.js */'));
  assert.ok(page.includes("id: 'btn-ops'"));
  assert.ok(page.includes('addTipSection(fn) { ext.tips.push(fn); }'));
  assert.ok(page.includes("fetch('/ops.json', { cache: 'no-store' })"));
  assert.match(page, /setInterval\(refresh, 60000\)/);
  for (const code of ['en', 'de']) {
    const table = readJson(path.join(SKILL, 'assets', 'lang', `${code}.json`));
    for (const k of ['ops.button', 'ops.title', 'ops.status.ok', 'ops.status.warn', 'ops.status.down', 'ops.status.unknown', 'ops.stale', 'ops.version', 'ops.lastRun', 'ops.lastOk', 'ops.lastError']) assert.ok(table[k], `${code}.json ${k}`);
  }
});

test('without graph.ops the extension adds nothing to the map', () => {
  const s = runUi(standIn({ ...graph, ops: undefined }));
  assert.equal(s.out.buttons.length, 0);
  assert.equal(s.out.sections.overview.length + s.out.sections.item.length + s.out.tips.length, 0);
  assert.equal((s.out.listeners.render || []).length, 0);
});
