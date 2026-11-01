// Who writes where: floorplan/targets.json lists the places an app writes to or reads from (a database, a service, a
// file, an API, a queue), which parts write and which only read, and whether a target allows one writer only. The
// build checks it, draws write and read connections to the target's box, puts a Targets panel on the map, marks a
// one-writer target with two writers in red with a Health finding, and points out calls the scan saw that the file
// doesn't list. Without the file, nothing changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { SKILL, makeProject, shopApp, scanAndBuild, run, readGraph, readJson, writeJson, cleanup } from './helpers.mjs';

/** The sample shop, plus a database, card payments and an email service it talks to. */
function shopWithServices() {
  const files = {
    'shop-api/package.json': JSON.stringify({ name: 'shop-api', type: 'module', dependencies: { express: '^4.19.0', pg: '^8.12.0' } }),
    'shop-api/server.js': "import express from 'express';\nimport { pool } from './db.js';\nconst app = express();\napp.listen(3000, () => pool.connect());\n",
    'shop-api/db.js': "import pg from 'pg';\nexport const pool = new pg.Pool();\n",
    'shop-api/config.js': 'export const PORT = 3000;\n',
    'shop-api/payments.js': "export const charge = (order) => fetch('https://api.stripe.com/v1/charges', { method: 'POST', body: JSON.stringify(order) });\n",
    'shop-api/mailer.js': "export const send = (mail) => fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', body: JSON.stringify(mail) });\n",
    'shop-api/tests/payments.test.js': "import pg from 'pg';\nexport const t = () => fetch('https://api.stripe.com/v1/charges', { method: 'POST' });\n",
    'shop-web/package.json': JSON.stringify({ name: 'shop-web', type: 'module' }),
    'shop-web/src/prices.js': "export const prices = () => fetch('https://api.stripe.com/v1/prices', { method: 'GET' }).then((r) => r.json());\n",
    'shop-web/src/receipt.js': "export const resend = (id) => fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', body: id });\n",
    'shop-web/src/App.jsx': "import { prices } from './prices.js';\nimport { resend } from './receipt.js';\nexport default function App() { return <button onClick={() => prices().then(() => resend(1))}>Buy</button>; }\n",
  };
  const arch = {
    project: { name: 'Shop', summary: 'A sample shop.' },
    nodes: [
      { id: 'api', label: 'Server', kind: 'service', summary: 'The shop server.', paths: ['shop-api/**'] },
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The shop website.', paths: ['shop-web/**'] },
      { id: 'db', label: 'Database', kind: 'external', summary: 'Where orders are kept.', packages: ['pg'] },
      { id: 'stripe', label: 'Stripe', kind: 'external', summary: 'Card payments.', hosts: ['api.stripe.com'] },
      { id: 'mail', label: 'Email service', kind: 'external', summary: 'Sends email.', hosts: ['api.sendgrid.com'] },
    ],
  };
  return makeProject(files, { repos: ['shop-api', 'shop-web'], arch });
}

const TARGETS = {
  targets: [
    { id: 'orders', name: { en: 'Orders', de: 'Bestellungen' }, kind: 'database', external: 'db', writers: ['api'], readers: ['web'], policy: 'single-writer', note: 'Only the server changes orders.' },
    { id: 'payments', name: 'Payments', kind: 'api', external: 'stripe', writers: ['shop-api/payments.js', 'shop-web/src/prices.js'], readers: [], policy: 'single-writer' },
    { id: 'outbox', name: 'Outgoing email', kind: 'service', external: 'mail', writers: ['shop-api/mailer.js'], policy: 'any' },
    { id: 'settings', name: 'Settings file', kind: 'file', writers: ['shop-api/config.js'], readers: ['shop-api/**/*.js'], policy: 'single-writer' },
  ],
};
const targetsFile = (root) => path.join(root, 'floorplan', 'targets.json');
const build = (root, ...args) => run('build.mjs', root, '--no-claude-md', ...args);
const buildOut = (root, ...args) => { try { return build(root, ...args); } catch (e) { return String(e.stdout) + String(e.stderr); } };
const target = (g, id) => g.targets.find((t) => t.id === id);
const linksOf = (g, k) => g.links.filter((l) => l.k === k).map((l) => `${l.a} > ${l.b}`).sort();

let root, graph, output;
before(() => { root = shopWithServices(); writeJson(targetsFile(root), TARGETS); output = scanAndBuild(root); graph = readGraph(root); });
after(() => cleanup(root));

test('the panel data: each target with its name, kind, rule, note, box on the map, writers and readers', () => {
  assert.deepEqual(graph.targets.map((t) => t.id), ['orders', 'payments', 'outbox', 'settings']);
  const orders = target(graph, 'orders');
  assert.equal(orders.name, 'Orders');
  assert.equal(orders.kind, 'database');
  assert.equal(orders.policy, 'single-writer');
  assert.equal(orders.note, 'Only the server changes orders.');
  assert.equal(orders.node, 'n:db');
  assert.deepEqual(orders.writers, [{ ref: 'api', items: ['n:api'] }]);
  assert.deepEqual(orders.readers, [{ ref: 'web', items: ['n:web'] }]);
  assert.equal(orders.conflict, false);
  // a target with no box on the map is still listed and checked
  const settings = target(graph, 'settings');
  assert.equal(settings.node, null);
  assert.deepEqual(settings.writers, [{ ref: 'shop-api/config.js', items: ['f:shop-api/config.js'] }]);
  // a glob that takes in every file of a part stands for that part
  assert.deepEqual(settings.readers, [{ ref: 'shop-api/**/*.js', items: ['n:api'] }]);
  assert.match(output, /TARGETS {2}4 \(1 with more than one writer\)/);
});

test('names follow the map\'s language, like the rest of it', () => {
  build(root, '--lang', 'de');
  assert.equal(target(readGraph(root), 'orders').name, 'Bestellungen');
  build(root);
});

test('connections go from each part to the target, as writes or reads', () => {
  assert.deepEqual(linksOf(graph, 'write'), ['f:shop-api/mailer.js > n:mail', 'f:shop-api/payments.js > n:stripe', 'f:shop-web/src/prices.js > n:stripe', 'n:api > n:db']);
  assert.deepEqual(linksOf(graph, 'read'), ['n:web > n:db']);
  const w = graph.links.find((l) => l.k === 'write' && l.b === 'n:db');
  assert.deepEqual(w.labels, ['Orders'], 'the connection carries the target\'s name');
  // the map draws them: two new kinds with their own colours in both themes, reads flowing back to the reader
  const html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.match(html, /const KINDS = \['import', 'http', 'call', 'rpc', 'event', 'queue', 'data', 'config', 'write', 'read'\];/);
  assert.match(html, /:root \{[^}]*--k-write: #[0-9a-f]{6}; --k-read: #[0-9a-f]{6};/);
  assert.match(html, /:root\[data-theme="light"\] \{[^}]*--k-write: #[0-9a-f]{6}; --k-read: #[0-9a-f]{6};/);
  assert.match(html, /\.edge\.k-read \.flow \{ animation-direction: reverse; \}/);
  // and the legend names them through the language table
  for (const code of ['en', 'de']) {
    const words = readJson(path.join(SKILL, 'assets', 'lang', `${code}.json`));
    for (const k of ['conn.plain.write', 'conn.plain.read', 'conn.tech.write', 'conn.tech.read']) assert.ok(words[k], `${code}.json ${k}`);
  }
});

test('a one-writer target with two writers is marked, and Health has a major finding with a fix', () => {
  const payments = target(graph, 'payments');
  assert.equal(payments.conflict, true);
  assert.equal(payments.writerCount, 2);
  assert.equal(target(graph, 'outbox').conflict, false, 'a target that allows any number of writers is never marked');
  const issue = graph.health.issues.find((i) => i.kind === 'single-writer');
  assert.ok(issue, JSON.stringify(graph.health.issues.map((i) => i.kind)));
  assert.equal(issue.severity, 'high');
  assert.equal(issue.title, 'Two writers for a single-writer target: Payments');
  assert.deepEqual(issue.items, ['f:shop-api/payments.js', 'f:shop-web/src/prices.js', 'n:stripe']);
  assert.match(issue.detail, /only one part may write to Payments/);
  assert.match(issue.fix, /shop-api\/payments\.js/);
  assert.match(issue.fix, /shop-web\/src\/prices\.js/);
  assert.match(issue.fix, /floorplan\/targets\.json/);
  assert.equal(graph.health.issues.filter((i) => i.kind === 'single-writer').length, 1, 'only the target that breaks its rule');
  assert.match(output, /\[high\] Two writers for a single-writer target: Payments/);
});

test('a writer inside another writer, or listed twice, is still one writer', () => {
  const r = shopWithServices();
  try {
    writeJson(targetsFile(r), { targets: [{ id: 'orders', name: 'Orders', kind: 'database', external: 'db', writers: ['api', 'shop-api/db.js', 'api'], policy: 'single-writer' }] });
    scanAndBuild(r);
    const g = readGraph(r);
    assert.equal(target(g, 'orders').writerCount, 1);
    assert.equal(target(g, 'orders').conflict, false);
    assert.equal(g.health.issues.filter((i) => i.kind === 'single-writer').length, 0);
  } finally { cleanup(r); }
});

test('a call the scan saw but targets.json doesn\'t list is a minor finding, with its direction from the method', () => {
  const outbox = target(graph, 'outbox');
  assert.deepEqual(outbox.undeclared, [{ part: 'n:web', dir: 'write', calls: [{ file: 'shop-web/src/receipt.js', line: 1, method: 'POST' }] }]);
  const issue = graph.health.issues.find((i) => i.kind === 'undeclared-target-call');
  assert.ok(issue);
  assert.equal(issue.severity, 'low');
  assert.equal(issue.title, 'Detected call from Website to Email service not declared as reader or writer');
  assert.deepEqual(issue.locations, [{ file: 'shop-web/src/receipt.js', line: 1 }]);
  assert.match(issue.fix, /"writers" or "readers"/);
  // calls covered by a writer or reader, and calls from tests, are left alone
  assert.deepEqual(target(graph, 'payments').undeclared, []);
  assert.deepEqual(target(graph, 'orders').undeclared, []);
  assert.equal(graph.health.issues.filter((i) => i.kind === 'undeclared-target-call').length, 1);
  // they don't count as writers either: the declaration stays the owner's
  assert.equal(outbox.writerCount, 1);
});

test('a GET reads, an unknown method or an imported package says so, and the scan records the method', () => {
  const r = shopWithServices();
  try {
    writeJson(targetsFile(r), { targets: [
      { id: 'orders', name: 'Orders', kind: 'database', external: 'db', writers: ['web'], policy: 'any' },
      { id: 'payments', name: 'Payments', kind: 'api', external: 'stripe', writers: ['shop-api/payments.js'], policy: 'single-writer' },
    ] });
    scanAndBuild(r);
    const g = readGraph(r);
    assert.deepEqual(target(g, 'payments').undeclared, [{ part: 'n:web', dir: 'read', calls: [{ file: 'shop-web/src/prices.js', line: 1, method: 'GET' }] }]);
    assert.deepEqual(target(g, 'orders').undeclared, [{ part: 'n:api', dir: 'unknown', calls: [{ file: 'shop-api/db.js', line: 1, method: null }] }]);
    const scan = readJson(path.join(r, 'floorplan', '.cache', 'scan.json'));
    assert.deepEqual(scan.hosts.filter((h) => h.from === 'shop-api/payments.js'), [{ from: 'shop-api/payments.js', host: 'api.stripe.com', line: 1, method: 'POST' }]);
  } finally { cleanup(r); }
});

test('mistakes in targets.json are errors that name the field and suggest the likely value', () => {
  const r = shopWithServices();
  try {
    run('scan.mjs', r);
    writeJson(targetsFile(r), { targets: [
      { id: 'orders', name: 'Orders', kind: 'databse', external: 'dbb', writers: ['apii', 'shop-api/nothing/**'], readers: 'web', policy: 'single_writer' },
      { id: 'orders', name: '', kind: 'file', writers: [], policy: 'any' },
      { name: 'No id', kind: 'other', writers: [], policy: 'any' },
    ] });
    const out = buildOut(r);
    assert.match(out, /error\(s\) in floorplan\/architecture\.json or targets\.json/);
    assert.match(out, /targets\.json targets\[0\] \("orders"\)\.kind "databse" must be one of database, service, file, api, queue, other — did you mean "database"\?/);
    assert.match(out, /targets\.json targets\[0\] \("orders"\)\.external "dbb" is not a node in architecture\.json — did you mean "db"\?/);
    assert.match(out, /targets\.json targets\[0\] \("orders"\)\.writers\[0\] "apii" is neither a part id nor a path or glob that matches a file on the map — did you mean "api"\?/);
    assert.match(out, /targets\.json targets\[0\] \("orders"\)\.writers\[1\] "shop-api\/nothing\/\*\*" is neither a part id nor a path or glob that matches a file on the map/);
    assert.match(out, /targets\.json targets\[0\] \("orders"\)\.readers must be a list/);
    assert.match(out, /targets\.json targets\[0\] \("orders"\)\.policy "single_writer" must be "single-writer" or "any" — did you mean "single-writer"\?/);
    assert.match(out, /targets\.json targets\[1\] \("orders"\)\.id duplicates an earlier target/);
    assert.match(out, /targets\.json targets\[1\] \("orders"\)\.name is empty/);
    assert.match(out, /targets\.json targets\[2\]\.id is required/);
    fs.writeFileSync(targetsFile(r), '[');
    assert.match(buildOut(r), /targets\.json is not valid JSON/);
    // a bare list works as well as { "targets": [...] }
    writeJson(targetsFile(r), [TARGETS.targets[2]]);
    build(r);
    assert.deepEqual(readGraph(r).targets.map((t) => t.id), ['outbox']);
  } finally { cleanup(r); }
});

test('after a refresh, a writer whose file moved is an error that names where it went', () => {
  const r = shopWithServices();
  try {
    writeJson(targetsFile(r), { targets: [TARGETS.targets[2]] });
    scanAndBuild(r);
    fs.renameSync(path.join(r, 'shop-api/mailer.js'), path.join(r, 'shop-api/email.js'));
    const out = run('refresh.mjs', r);
    assert.match(out, /targets\.json targets\[0\] \("outbox"\)\.writers\[0\] "shop-api\/mailer\.js" is neither a part id nor a path or glob that matches a file on the map — did you mean "shop-api\/email\.js"\? \(it moved there\)/);
    assert.deepEqual(readJson(targetsFile(r)).targets[0].writers, ['shop-api/mailer.js'], 'the refresh leaves targets.json as it was');
  } finally { cleanup(r); }
});

test('without targets.json the build is unchanged: no panel data, no write or read connections, no findings', () => {
  const r = shopApp();
  try {
    const out = scanAndBuild(r);
    const g = readGraph(r);
    assert.equal(g.targets, undefined);
    assert.equal(g.links.filter((l) => l.k === 'write' || l.k === 'read').length, 0);
    assert.equal(g.health.issues.filter((i) => /single-writer|undeclared-target-call/.test(i.kind)).length, 0);
    assert.doesNotMatch(out, /TARGETS/);
    const strip = (x) => JSON.stringify({ ...x, meta: { ...x.meta, generatedAt: null } });
    writeJson(targetsFile(r), { targets: [] });
    build(r);
    assert.equal(strip(readGraph(r)), strip(g), 'an empty list changes nothing either');
  } finally { cleanup(r); }
});

// ---------- the Targets panel, run against a pretend map ----------

/** Runs ui/35-targets.js against a stand-in for window.Floorplan and returns what it put on the page. */
function panel(g, lang = 'en') {
  const words = { ...readJson(path.join(SKILL, 'assets', 'lang', 'en.json')), ...(lang === 'en' ? {} : readJson(path.join(SKILL, 'assets', 'lang', `${lang}.json`))) };
  const t = (k, vars) => (words[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => (vars && x in vars ? String(vars[x]) : m));
  const tn = (k, n, vars) => t(words[`${k}.${n === 1 ? 'one' : 'other'}`] ? `${k}.${n === 1 ? 'one' : 'other'}` : `${k}.other`, { n, ...vars });
  const el = () => { const e = { children: [], style: { setProperty() {} }, classList: new Set(), appendChild: (c) => { e.children.push(c); return c; }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }; e.classList.add = e.classList.add.bind(e.classList); return e; };
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const files = new Map(g.files.map((f) => [f.p, f]));
  const info = (id) => id.startsWith('n:') ? { type: 'node', name: nodes.get(id.slice(2)).label, kind: nodes.get(id.slice(2)).kind } : { type: 'file', name: files.get(id.slice(2))?.name || id, kind: 'file', path: id.slice(2) };
  const out = { buttons: [], sections: { overview: [], item: [] }, listeners: {}, panels: [] };
  const SC = {
    graph: g, lang, t, tn, h: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), exported: null,
    info, exists: (id) => id.startsWith('n:') ? nodes.has(id.slice(2)) : files.has(id.slice(2)), chain: (id) => [id], colorOf: () => 'var(--n-file)',
    icon: () => '<svg></svg>', iconI: () => '<svg></svg>', icons: {}, state: { chipEls: new Map(), edgeEls: new Map() },
    addHeaderButton: (b) => { const e = el(); out.buttons.push({ ...b, el: e }); return e; },
    addPanelSection: (where, fn) => out.sections[where].push(fn),
    showPanel: (html) => out.panels.push(html), closePanel() {}, showBoard: (b) => out.board = b, on: (ev, fn) => (out.listeners[ev] ||= []).push(fn),
  };
  const document = { createElement: () => el(), head: el() };
  vm.runInNewContext(fs.readFileSync(path.join(SKILL, 'assets', 'ui', '35-targets.js'), 'utf8'), { window: { Floorplan: SC }, document });
  return { ...out, SC, el };
}

test('the Targets panel lists every target with its writers and readers as tiles that go to the map', () => {
  const p = panel(graph);
  assert.equal(p.buttons.length, 1);
  assert.equal(p.buttons[0].label, 'Targets');
  p.buttons[0].onClick();
  const html = p.panels.at(-1);
  for (const s of ['Orders', 'Payments', 'Outgoing email', 'Settings file', 'Writers', 'Readers', 'One target, two writers', 'One writer only', 'Any number of writers', 'Only the server changes orders.']) assert.ok(html.includes(s), `"${s}" is in the panel`);
  // tiles: a click goes to the part or file on the map
  for (const id of ['n:api', 'n:web', 'f:shop-api/payments.js', 'f:shop-web/src/prices.js', 'f:shop-api/config.js']) assert.ok(html.includes(`data-go="${id}"`), `a tile for ${id}`);
  // the calls targets.json doesn't list are shown with their direction
  assert.ok(html.includes('Also calls it, not listed'));
  // the overview panel has a way in, with the count of targets that break their rule
  const ov = p.sections.overview[0]();
  assert.match(ov.html, /Targets/);
  assert.match(ov.html, /1 target has more than one writer/);
});

test('in German the panel says Ziele, Schreiber, Leser and Ein Ziel, zwei Schreiber', () => {
  build(root, '--lang', 'de');
  try {
    const p = panel(readGraph(root), 'de');
    assert.equal(p.buttons[0].label, 'Ziele');
    p.buttons[0].onClick();
    const html = p.panels.at(-1);
    for (const s of ['Ziele', 'Schreiber', 'Leser', 'Ein Ziel, zwei Schreiber', 'Bestellungen', 'Nur ein Schreiber']) assert.ok(html.includes(s), `"${s}" is in the German panel`);
  } finally { build(root); }
});

test('on the map the box of a target with two writers, and the writes into it, turn red', () => {
  const p = panel(graph);
  const card = { classList: new Set() };
  card.classList.add = card.classList.add.bind(card.classList);
  const box = (c) => ({ querySelector: () => c });
  const writeEdge = { g: { style: {} }, pg: { style: {} }, e: { k: 'write', a: 'n:web', b: 'n:stripe' } };
  const readEdge = { g: { style: {} }, pg: { style: {} }, e: { k: 'read', a: 'n:web', b: 'n:db' } };
  const okCard = { classList: new Set() };
  okCard.classList.add = okCard.classList.add.bind(okCard.classList);
  p.SC.state.chipEls.set('n:stripe', box(card));
  p.SC.state.chipEls.set('n:db', box(okCard));
  p.SC.state.edgeEls.set('e0', writeEdge);
  p.SC.state.edgeEls.set('e1', readEdge);
  for (const fn of p.listeners.render || []) fn({});
  assert.ok(card.classList.has('tg-conflict'), 'the Stripe box is marked');
  assert.ok(!okCard.classList.has('tg-conflict'), 'the database box, with one writer, is not');
  assert.equal(writeEdge.g.style.color, 'var(--sev-high)');
  assert.equal(readEdge.g.style.color, undefined);
  // the colour for it is in the page, and the badge on the Targets button counts it
  const html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.match(html, /\.card\.tg-conflict \{[^}]*var\(--sev-high\)/);
  assert.equal(p.buttons[0].el.children.find((c) => c.className === 'badge')?.textContent, '1');
});

test('without targets the panel adds nothing to the map', () => {
  const p = panel({ ...graph, targets: undefined });
  assert.equal(p.buttons.length, 0);
  assert.equal(p.sections.overview.length + p.sections.item.length, 0);
  assert.equal((p.listeners.render || []).length, 0);
});
