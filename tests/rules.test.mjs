// Rules and decisions: floorplan/rules.json holds the rules a project documents ("one writer per target") and its dated
// decisions, each with its source, hung on the parts, files, endpoints and targets it applies to. The build checks it
// like targets.json (an unknown ref is an error with a suggestion), resolves each ref and writes graph.rules; a retired
// rule that still names places is a minor Health finding; MAP.md gets a Rules section; the map gets a Rules panel and a
// "Rules here" section on the cards. Without the file, nothing changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { REPO, SKILL, makeProject, shopApp, scanAndBuild, run, readGraph, readJson, writeJson, launchBrowser, openMap, cleanup } from './helpers.mjs';

const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'rules.json');
const RULES = readJson(FIXTURE);

/** The sample shop with a database it writes to, as a target with a box, so a rule can hang on the target. */
function shopWithTarget() {
  const files = {
    'shop-api/package.json': JSON.stringify({ name: 'shop-api', type: 'module', dependencies: { express: '^4.19.0', pg: '^8.12.0' } }),
    'shop-api/server.js': "import express from 'express';\nimport orders from './routes/orders.js';\nimport { pool } from './db.js';\nconst app = express();\napp.use('/api', orders);\napp.listen(3000, () => pool.connect());\n",
    'shop-api/db.js': "import pg from 'pg';\nexport const pool = new pg.Pool();\n",
    'shop-api/routes/orders.js': "import { Router } from 'express';\nconst router = Router();\n/** Every order. */\nrouter.get('/orders', async (req, res) => { res.json([]); });\nrouter.post('/orders/:id/refund', async (req, res) => { res.json({ ok: true }); });\nexport default router;\n",
    'shop-web/package.json': JSON.stringify({ name: 'shop-web', type: 'module' }),
    'shop-web/src/api.js': "export const listOrders = () => fetch('/api/orders').then((r) => r.json());\nexport const refund = (id) => fetch(`/api/orders/${id}/refund`, { method: 'POST' });\n",
    'shop-web/src/App.jsx': "import { listOrders, refund } from './api.js';\nexport default function App() { return <button onClick={() => listOrders().then((o) => refund(o[0].id))}>Refund</button>; }\n",
  };
  const arch = {
    project: { name: 'Shop', summary: 'A sample shop.' },
    nodes: [
      { id: 'api', label: 'Server', kind: 'service', summary: 'The shop server.', paths: ['shop-api/**'] },
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The shop website.', paths: ['shop-web/**'] },
      { id: 'db', label: 'Database', kind: 'external', summary: 'Where orders are kept.', packages: ['pg'] },
    ],
  };
  const root = makeProject(files, { repos: ['shop-api', 'shop-web'], arch });
  writeJson(path.join(root, 'floorplan', 'targets.json'), { targets: [{ id: 'orders', name: { en: 'Orders', de: 'Bestellungen' }, kind: 'database', external: 'db', writers: ['api'], readers: ['web'], policy: 'single-writer' }] });
  return root;
}
const rulesFile = (root) => path.join(root, 'floorplan', 'rules.json');
const build = (root, ...args) => run('build.mjs', root, '--no-claude-md', ...args);
const buildOut = (root, ...args) => { try { return build(root, ...args); } catch (e) { return String(e.stdout) + String(e.stderr); } };
const rule = (g, id) => g.rules.find((r) => r.id === id);
const mapOf = (root) => fs.readFileSync(path.join(root, 'floorplan', 'MAP.md'), 'utf8');
/** The Rules section of MAP.md: from its marker to the next one. */
const ids = (items) => Array.from(items, (x) => x.id); // an array from the stand-in's own realm, so deepEqual can compare it
const rulesSection = (md) => { const from = md.indexOf('<!-- floorplan:rules -->'); assert.ok(from >= 0, 'the Rules marker is in MAP.md'); return md.slice(from, md.indexOf('<!-- floorplan:flows -->')); };

let root, graph, output;
before(() => { root = shopWithTarget(); fs.copyFileSync(FIXTURE, rulesFile(root)); output = scanAndBuild(root); graph = readGraph(root); });
after(() => cleanup(root));

// ---------- the build ----------

test('a valid file lands in graph.rules: each rule with its kind, text, source, dates, status and the cards it applies to', () => {
  assert.deepEqual(graph.rules.map((r) => r.id), ['one-writer', 'merge-when-green', 'no-direct-db']);
  const one = rule(graph, 'one-writer');
  assert.equal(one.kind, 'rule');
  assert.equal(one.title, 'One writer per target');
  assert.equal(one.text, 'Only the server changes orders; the website reads them through the server.');
  assert.equal(one.source, 'CLAUDE.md § Build rules');
  assert.equal(one.since, '2026-10-25');
  assert.equal(one.until, null);
  assert.equal(one.status, 'active');
  assert.equal(one.tags, undefined);
  // a part id, a target id (the rule hangs on the target), a file path and "METHOD /path", in the file's order
  assert.deepEqual(one.items, ['n:api', 't:orders', 'f:shop-web/src/api.js', 'r:1']);
  assert.equal(`${graph.routes[1].m} ${graph.routes[1].p}`, 'POST /api/orders/:id/refund');
  assert.equal(graph.targets.find((t) => t.id === 'orders').node, 'n:db', 'the target has a box the map can mark');
  // a decision with no refs applies to the whole project; status defaults to active
  const merge = rule(graph, 'merge-when-green');
  assert.equal(merge.kind, 'decision');
  assert.deepEqual(merge.items, []);
  assert.equal(merge.status, 'active');
  // a retired rule keeps its history
  const old = rule(graph, 'no-direct-db');
  assert.equal(old.status, 'retired');
  assert.equal(old.until, '2026-10-25');
  assert.deepEqual(old.tags, ['history']);
  assert.deepEqual(old.items, ['n:web']);
  assert.match(output, /RULES {2}2 rules, 1 decision · 1 retired/);
  assert.doesNotMatch(output, /warning\(s\)/);
});

test('a glob that covers a whole part stands for the part; one that covers some files lists those files', () => {
  const r = shopWithTarget();
  try {
    writeJson(rulesFile(r), { rules: [
      { id: 'a', kind: 'rule', title: 'A', text: 'Everything in the server.', applies: ['shop-api/**'], source: 'README' },
      { id: 'b', kind: 'rule', title: 'B', text: 'Only the routes.', applies: ['shop-api/routes/*.js', 'shop-api/db.js', 'api'], source: 'README' },
    ] });
    scanAndBuild(r);
    const g = readGraph(r);
    assert.deepEqual(rule(g, 'a').items, ['n:api']);
    assert.deepEqual(rule(g, 'b').items, ['f:shop-api/routes/orders.js', 'f:shop-api/db.js', 'n:api'], 'the same card is listed once');
  } finally { cleanup(r); }
});

test('mistakes in rules.json are errors that name the field and suggest the likely value', () => {
  const r = shopWithTarget();
  try {
    run('scan.mjs', r);
    writeJson(rulesFile(r), { rules: [
      { id: 'one-writer', kind: 'rule', title: 'One writer', text: 'x', applies: ['ordres', 'apii', 'shop-web/src/nothing.js', 'POST /api/orders/:id/refunds'], source: 'CLAUDE.md', since: '25.10.2026', status: 'retried' },
      { id: 'one-writer', kind: 'decison', title: '', aplies: ['api'], source: 'README' },
      { kind: 'rule', title: 'No id', text: 'x', tags: 'history' },
      'not an object',
    ] });
    const out = buildOut(r);
    assert.match(out, /error\(s\) in floorplan\/architecture\.json or rules\.json/);
    assert.match(out, /rules\.json rules\[0\] \("one-writer"\)\.applies\[0\] "ordres" is neither a part id, a path or glob that matches a file on the map, "METHOD \/path" nor a target id — did you mean "orders"\?/);
    assert.match(out, /rules\.json rules\[0\] \("one-writer"\)\.applies\[1\] "apii" is neither .* — did you mean "api"\?/);
    assert.match(out, /rules\.json rules\[0\] \("one-writer"\)\.applies\[2\] "shop-web\/src\/nothing\.js" is neither .* — did you mean "shop-web\/src\/api\.js"\?/);
    assert.match(out, /rules\.json rules\[0\] \("one-writer"\)\.applies\[3\] "POST \/api\/orders\/:id\/refunds" is neither .* — did you mean "POST \/api\/orders\/:id\/refund"\?/);
    assert.match(out, /rules\.json rules\[0\] \("one-writer"\)\.since "25\.10\.2026" must be a date like 2026-10-25/);
    assert.match(out, /rules\.json rules\[0\] \("one-writer"\)\.status "retried" must be "active" or "retired" — did you mean "retired"\?/);
    assert.match(out, /rules\.json rules\[1\] \("one-writer"\): unknown field "aplies" — did you mean "applies"\?/, 'a misspelt "applies" would silently mean "everywhere"');
    assert.match(out, /rules\.json rules\[1\] \("one-writer"\)\.id duplicates an earlier rule/);
    assert.match(out, /rules\.json rules\[1\] \("one-writer"\)\.kind "decison" must be "rule" or "decision" — did you mean "decision"\?/);
    assert.match(out, /rules\.json rules\[1\] \("one-writer"\)\.title is empty/);
    assert.match(out, /rules\.json rules\[1\] \("one-writer"\)\.text is required/);
    assert.match(out, /rules\.json rules\[2\]\.id is required/);
    assert.match(out, /rules\.json rules\[2\]\.source is required: where the rule is written down/);
    assert.match(out, /rules\.json rules\[2\]\.tags must be an array of strings/);
    assert.match(out, /rules\.json rules\[3\] must be an object/);
    assert.ok(!fs.existsSync(path.join(r, 'floorplan', 'index.html')), 'nothing was written');
    fs.writeFileSync(rulesFile(r), '{');
    assert.match(buildOut(r), /rules\.json is not valid JSON/);
    writeJson(rulesFile(r), { rule: [] });
    assert.match(buildOut(r), /rules\.json must be a list of rules, or \{ "rules": \[ … \] \}/);
    // a bare list works as well as { "rules": [...] }
    writeJson(rulesFile(r), [RULES.rules[1]]);
    build(r);
    assert.deepEqual(readGraph(r).rules.map((x) => x.id), ['merge-when-green']);
  } finally { cleanup(r); }
});

test('after a refresh, a ref whose file moved is an error that names where it went', () => {
  const r = shopWithTarget();
  try {
    writeJson(rulesFile(r), { rules: [{ id: 'calls', kind: 'rule', title: 'Calls go through one file', text: 'x', applies: ['shop-web/src/api.js'], source: 'README' }] });
    scanAndBuild(r);
    fs.renameSync(path.join(r, 'shop-web/src/api.js'), path.join(r, 'shop-web/src/client.js'));
    const out = run('refresh.mjs', r);
    assert.match(out, /rules\.json rules\[0\] \("calls"\)\.applies\[0\] "shop-web\/src\/api\.js" is neither .* — did you mean "shop-web\/src\/client\.js"\? \(it moved there\)/);
    assert.deepEqual(readJson(rulesFile(r)).rules[0].applies, ['shop-web/src/api.js'], 'the refresh leaves rules.json as it was');
  } finally { cleanup(r); }
});

test('a retired rule that still names places is a minor Health finding with a fix; a retired rule without places is not', () => {
  const issue = graph.health.issues.find((i) => i.kind === 'retired-rule');
  assert.ok(issue, JSON.stringify(graph.health.issues.map((i) => i.kind)));
  assert.equal(issue.severity, 'low');
  assert.equal(issue.title, 'Retired rule still applied: No database access from the website');
  assert.deepEqual(issue.items, ['n:web']);
  assert.match(issue.detail, /until 2026-10-25/);
  assert.match(issue.detail, /Website/);
  assert.match(issue.fix, /floorplan\/rules\.json/);
  assert.match(issue.fix, /Website \(shop-web\/\*\*\)/);
  assert.match(issue.fix, /The rule said: The website used to query the database itself/);
  assert.equal(graph.health.issues.filter((i) => i.kind === 'retired-rule').length, 1);
  assert.match(output, /HEALTH {2}0 important · 1 worth fixing · 1 minor/);
  const r = shopWithTarget();
  try {
    writeJson(rulesFile(r), { rules: [{ id: 'old', kind: 'decision', title: 'Old', text: 'x', applies: [], source: 'README', status: 'retired' }] });
    scanAndBuild(r);
    assert.equal(readGraph(r).health.issues.filter((i) => i.kind === 'retired-rule').length, 0);
  } finally { cleanup(r); }
});

test('a retired rule on a target is marked on the target\'s box', () => {
  const r = shopWithTarget();
  try {
    writeJson(rulesFile(r), { rules: [{ id: 'old', kind: 'rule', title: 'Old', text: 'x', applies: ['orders', 'GET /api/orders'], source: 'README', status: 'retired' }] });
    scanAndBuild(r);
    const issue = readGraph(r).health.issues.find((i) => i.kind === 'retired-rule');
    assert.deepEqual(issue.items, ['n:db', 'r:0']);
    assert.match(issue.detail, /2 places: Orders and GET \/api\/orders/);
  } finally { cleanup(r); }
});

// ---------- MAP.md ----------

test('MAP.md has a Rules section with its marker after Targets: per rule its kind, dates, places, text and source', () => {
  const md = mapOf(root);
  const markers = md.split('\n').filter((l) => /^<!-- floorplan:\w+ -->$/.test(l));
  assert.deepEqual(markers, ['parts', 'targets', 'rules', 'flows', 'health', 'recent'].map((s) => `<!-- floorplan:${s} -->`));
  const sec = rulesSection(md);
  assert.match(sec, /^<!-- floorplan:rules -->\n## Rules\n/);
  const lines = sec.split('\n');
  const at = lines.indexOf('### One writer per target (`one-writer`)');
  assert.ok(at > 0);
  assert.deepEqual(lines.slice(at, at + 5), [
    '### One writer per target (`one-writer`)',
    '- Kind: Rule · since 2026-10-25',
    '- Applies to: Server (`api`), Orders (`orders`), `shop-web/src/api.js`, `POST /api/orders/:id/refund`',
    '> Only the server changes orders; the website reads them through the server.',
    '- Source: CLAUDE.md § Build rules',
  ]);
  assert.match(sec, /^- Kind: Decision · since 2026-10-26\n- Applies to: the whole project$/m);
  assert.match(sec, /^- Kind: Rule · retired · since 2026-09-01 · until 2026-10-25$/m);
  // the retired rule comes last, after the decision that follows it in the file
  assert.ok(sec.indexOf('(`merge-when-green`)') < sec.indexOf('(`no-direct-db`)'));
  assert.match(md, /^Inputs in floorplan\/: architecture\.json, targets\.json, rules\.json$/m);
});

test('a rule that names many places lists eight and counts the rest; in German the section says Regeln, Gilt für, Quelle', () => {
  const r = shopWithTarget();
  try {
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`shop-web/src/p${i}.js`, `export const p${i} = ${i};\n`]));
    for (const [p, src] of Object.entries(files)) fs.writeFileSync(path.join(r, p), src);
    writeJson(rulesFile(r), { rules: [{ id: 'many', kind: 'rule', title: 'Many', text: 'x', applies: ['shop-web/src/p*.js'], source: 'README' }] });
    scanAndBuild(r);
    const sec = rulesSection(mapOf(r));
    assert.match(sec, /^- Applies to: (`shop-web\/src\/p\d\.js`, ){8}… and 2 more$/m);
    build(r, '--lang', 'de');
    const de = rulesSection(mapOf(r));
    assert.match(de, /^## Regeln$/m);
    assert.match(de, /^- Art: Regel$/m);
    assert.match(de, /^- Gilt für: .*… und 2 weitere$/m);
    assert.match(de, /^- Quelle: README$/m);
  } finally { cleanup(r); }
});

// ---------- the Rules panel, run against a stand-in map ----------

const words = (lang) => ({ ...readJson(path.join(SKILL, 'assets', 'lang', 'en.json')), ...(lang === 'en' ? {} : readJson(path.join(SKILL, 'assets', 'lang', `${lang}.json`))) });
/** A stand-in for window.Floorplan, enough for ui/38-rules.js to run against a built graph. */
function standIn(g, lang = 'en') {
  const w = words(lang);
  const t = (k, vars) => (w[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => (vars && x in vars ? String(vars[x]) : m));
  const tn = (k, n, vars) => t(w[`${k}.${n === 1 ? 'one' : 'other'}`] ? `${k}.${n === 1 ? 'one' : 'other'}` : `${k}.other`, { n, ...vars });
  const el = () => { const e = { children: [], style: { setProperty() {} }, classList: new Set(), appendChild: (c) => { e.children.push(c); return c; }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }; e.classList.add = e.classList.add.bind(e.classList); return e; };
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
  const out = { buttons: [], sections: { overview: [], item: [] }, listeners: {}, panels: [], boards: [], closed: 0 };
  const SC = {
    graph: g, lang, t, tn, h: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), exported: null,
    info, exists, chain, colorOf: () => 'var(--n-file)',
    icon: () => '<svg></svg>', iconI: () => '<svg></svg>', icons: {}, state: { chipEls: new Map(), edgeEls: new Map(), selected: null, container: 'root' },
    addHeaderButton: (b) => { const e = el(); out.buttons.push({ ...b, el: e }); return e; },
    addPanelSection: (where, fn) => out.sections[where].push(fn),
    showPanel: (html) => out.panels.push(html), closePanel: () => out.closed++, showBoard: (b) => out.boards.push(b), on: (ev, fn) => (out.listeners[ev] ||= []).push(fn),
  };
  const document = { createElement: () => el(), head: el(), querySelector: () => null };
  const window = { Floorplan: SC };
  vm.runInNewContext(fs.readFileSync(path.join(SKILL, 'assets', 'ui', '38-rules.js'), 'utf8'), { window, document, Date });
  return { ...out, SC, api: window.FloorplanRules };
}

test('the Rules panel groups the rules: Everywhere first, then rules and decisions, the retired ones last and dimmed', () => {
  const p = standIn(graph);
  assert.equal(p.buttons.length, 1);
  assert.equal(p.buttons[0].label, 'Rules');
  assert.match(p.buttons[0].title, /2 rules · 1 decision · 1 retired/);
  p.buttons[0].onClick();
  const html = p.panels.at(-1);
  for (const s of ['Rules', '2 rules · 1 decision · 1 retired', 'Floorplan never makes one up', 'data-rl-back']) assert.ok(html.includes(s), `"${s}" is in the panel`);
  const order = [...html.matchAll(/class="rl-g">([^<]+)<|data-rl-open="([^"]+)"/g)].map((m) => m[1] || m[2]);
  assert.deepEqual(order, ['Everywhere', 'merge-when-green', 'Rules', 'one-writer', 'Retired', 'no-direct-db']);
  assert.match(html, /rl-row rl-off" data-rl-open="no-direct-db"/, 'the retired rule is dimmed');
  assert.match(html, /Decision · since Oct 26, 2026 · the whole project/);
  assert.match(html, /Rule · since Oct 25, 2026 · 4 places/);
  assert.match(html, /Rule · since Sep 1, 2026 · until Oct 25, 2026 · 1 place/);
  // the codebase panel has a way in
  const ov = p.sections.overview[0]();
  assert.match(ov.html, /data-rl-all/);
  assert.match(ov.html, /2 rules · 1 decision · 1 retired/);
  assert.match(ov.html, /One writer per target · The lead merges when CI is green/);
});

test('opening a rule puts its cards on a board, a target by its box, and shows its text, source and places as links', () => {
  const p = standIn(graph);
  p.api.show(rule(graph, 'one-writer'));
  const board = p.boards.at(-1);
  assert.equal(board.title, 'One writer per target');
  assert.equal(board.kind, 'Rule');
  assert.equal(board.question, 'Only the server changes orders; the website reads them through the server.');
  assert.deepEqual(ids(board.items), ['n:api', 'n:db', 'f:shop-web/src/api.js', 'r:1']);
  assert.equal(board.items[1].note, 'Rule: One writer per target');
  const html = p.panels.at(-1);
  for (const s of ['One writer per target', 'Only the server changes orders', 'since Oct 25, 2026', 'Source:', 'CLAUDE.md § Build rules', 'Applies to', 'data-go="n:api"', 'data-go="n:db"', 'Orders', 'data-go="f:shop-web/src/api.js"', 'data-go="r:1"', 'data-rl-list']) assert.ok(html.includes(s), `"${s}" is in the rule's panel`);
  // a project-wide rule has no board, only its text
  p.api.show(rule(graph, 'merge-when-green'));
  assert.equal(p.boards.length, 1);
  assert.match(p.panels.at(-1), /the whole project/);
  assert.match(p.panels.at(-1), /Decision/);
  // a target without a box is named, but leads nowhere
  const g2 = { ...graph, targets: graph.targets.map((x) => ({ ...x, node: null })) };
  const p2 = standIn(g2);
  p2.api.show(rule(g2, 'one-writer'));
  assert.deepEqual(ids(p2.boards.at(-1).items), ['n:api', 'f:shop-web/src/api.js', 'r:1']);
  assert.match(p2.panels.at(-1), /Orders<\/div><div class="rp">No box on the map/);
});

test('"Rules here" on a card lists the rules that name it, its part or its parents, and a target\'s box', () => {
  const p = standIn(graph);
  const here = (id) => { const r = p.sections.item[0](id); return r ? [...r.html.matchAll(/data-rl-open="([^"]+)"/g)].map((m) => m[1]) : []; };
  assert.deepEqual(here('n:api'), ['one-writer']);
  assert.deepEqual(here('f:shop-api/db.js'), ['one-writer'], 'a file inside the part');
  assert.deepEqual(here('r:0'), ['one-writer'], 'an endpoint of the part');
  assert.deepEqual(here('n:db'), ['one-writer'], 'the target\'s box');
  assert.deepEqual(here('n:web'), ['no-direct-db'], 'the retired rule still shows where it is listed');
  assert.deepEqual(here('f:shop-web/src/api.js'), ['one-writer', 'no-direct-db'], 'named itself, and inside the website');
  assert.deepEqual(here('f:shop-web/src/App.jsx'), ['no-direct-db']);
  assert.match(p.sections.item[0]('n:api').html, /Rules here/);
  assert.match(p.sections.item[0]('n:api').html, /All rules/);
  assert.equal(p.api.reaches(rule(graph, 'merge-when-green'), 'n:api'), false, 'a project-wide rule is not repeated on every card');
});

test('in German the panel says Regeln, Entscheidung, Überall, seit, bis, Quelle, Gilt für, Gilt hier and zurückgezogen', () => {
  build(root, '--lang', 'de');
  try {
    const g = readGraph(root);
    const p = standIn(g, 'de');
    assert.equal(p.buttons[0].label, 'Regeln');
    p.buttons[0].onClick();
    const html = p.panels.at(-1);
    for (const s of ['Regeln', '2 Regeln · 1 Entscheidung · 1 zurückgezogen', 'Überall', 'Entscheidung · seit 26.10.2026 · das ganze Projekt', 'Regel · seit 25.10.2026 · 4 Stellen', 'Zurückgezogen', 'bis 25.10.2026 · 1 Stelle']) assert.ok(html.includes(s), `"${s}" is in the German panel`);
    p.api.show(rule(g, 'one-writer'));
    assert.match(p.panels.at(-1), /Quelle:<\/b> CLAUDE\.md § Build rules/);
    assert.match(p.panels.at(-1), /Gilt für/);
    assert.match(p.panels.at(-1), /Bestellungen/, 'the target by its German name');
    assert.match(p.sections.item[0]('n:api').html, /Gilt hier/);
  } finally { build(root); }
});

test('the built page carries the panel, and every word of it is in both language tables', () => {
  const page = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.ok(page.includes('/* ui/38-rules.js */'));
  assert.ok(page.includes("id: 'btn-rules'"));
  for (const code of ['en', 'de']) {
    const table = readJson(path.join(SKILL, 'assets', 'lang', `${code}.json`));
    for (const k of ['rules.button', 'rules.title', 'rules.intro', 'rules.kind.rule', 'rules.kind.decision', 'rules.group.everywhere', 'rules.retired', 'rules.since', 'rules.until', 'rules.applies', 'rules.everywhere', 'rules.source', 'rules.here']) assert.ok(table[k], `${code}.json ${k}`);
  }
});

test('without rules.json the build is unchanged: no graph.rules, "RULES  none", a Rules section that says None, nothing on the map', () => {
  const r = shopApp();
  try {
    const out = scanAndBuild(r);
    const g = readGraph(r);
    assert.equal(g.rules, undefined);
    assert.match(out, /RULES {2}none \(no rules\.json\)/);
    assert.equal(g.health.issues.filter((i) => i.kind === 'retired-rule').length, 0);
    assert.match(rulesSection(mapOf(r)), /^<!-- floorplan:rules -->\n## Rules\n\nNone\.\n\n$/);
    const strip = (x) => JSON.stringify({ ...x, meta: { ...x.meta, generatedAt: null } });
    writeJson(rulesFile(r), { rules: [] });
    assert.match(build(r), /RULES {2}none \(nothing in rules\.json\)/);
    assert.equal(strip(readGraph(r)), strip(g), 'an empty list changes nothing either');
    const p = standIn(g);
    assert.equal(p.buttons.length, 0);
    assert.equal(p.sections.overview.length + p.sections.item.length, 0);
  } finally { cleanup(r); }
});

// ---------- in a real browser ----------

test('in the browser the Rules panel opens, a rule lays its cards out on a board, and nothing errors', async (t) => {
  const browser = await launchBrowser();
  if (!browser) return t.skip('no Playwright with a Chromium in this environment');
  try {
    const { page, errors } = await openMap(browser, root);
    await page.click('#btn-rules');
    const list = await page.evaluate(() => document.querySelector('#panel').innerText);
    for (const s of ['2 rules · 1 decision · 1 retired', 'Everywhere', 'The lead merges when CI is green', 'One writer per target', 'Retired', 'No database access from the website']) assert.ok(list.includes(s), `"${s}" is in the panel`);
    await page.click('#panel [data-rl-open="one-writer"]');
    await page.waitForFunction(() => window.Floorplan.state.container === 'q:answer' && document.querySelectorAll('.node .card').length === 4);
    const board = await page.evaluate(() => ({ cards: [...document.querySelectorAll('.node .card .title')].map((e) => e.textContent).sort(), notes: document.querySelectorAll('.node .card .anote').length, panel: document.querySelector('#panel').innerText }));
    assert.deepEqual(board.cards, ['API', 'Database', 'Router', 'Server']);
    assert.equal(board.notes, 4, 'every card carries the rule as its note');
    assert.match(board.panel, /Source: CLAUDE\.md § Build rules/);
    assert.match(board.panel, /Applies to/);
    // a card's own details show the rules that reach it
    await page.evaluate(() => window.Floorplan.go('root', { select: 'n:api' }));
    await page.waitForFunction(() => /Rules here/.test(document.querySelector('#panel').innerText));
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});
