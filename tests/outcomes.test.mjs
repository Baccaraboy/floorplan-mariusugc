// What you see: a flow says what starts it (a click, a clock, a message, a webhook, a file, a hand), what the owner
// sees at a step and what they have in the end, each at a place on the map (usually an outside service: a phone, a
// calendar, a database, a mailbox). The build checks the refs like a flow's steps, keeps it all in graph.flows, and
// turns it round into graph.outcomes, the index by place. MAP.md gets a Trigger and a You see line per flow and a
// "What you see" section; the map shows the trigger in the flow list and the guided view, an eye card at a step, an end
// card at the last step, a "What you see" panel and "What arrives here" on the place's card. Flows without the new
// fields build as before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { SKILL, shopApp, scanAndBuild, run, readGraph, readJson, writeJson, launchBrowser, openMap, cleanup } from './helpers.mjs';

const build = (root, ...args) => run('build.mjs', root, '--no-claude-md', ...args);
const buildOut = (root, ...args) => { try { return build(root, ...args); } catch (e) { return String(e.stdout) + String(e.stderr); } };
const archFile = (root) => path.join(root, 'floorplan', 'architecture.json');
const mapOf = (root) => fs.readFileSync(path.join(root, 'floorplan', 'MAP.md'), 'utf8');
/** One section of MAP.md: from its marker to the next one. */
const section = (md, name) => { const from = md.indexOf(`<!-- floorplan:${name} -->`); assert.ok(from >= 0, `the ${name} marker is in MAP.md`); const rest = md.slice(from + 1); const to = rest.search(/\n<!-- floorplan:\w+ -->/); return to < 0 ? md.slice(from) : md.slice(from, from + 1 + to); };
/** One flow of MAP.md: from its heading to the next heading or marker. */
const entry = (md, heading) => { const lines = md.split('\n'); const at = lines.indexOf(heading); assert.ok(at >= 0, `"${heading}" is in MAP.md`); let end = lines.findIndex((l, i) => i > at && /^#{1,6} |^<!-- floorplan:\w+ -->$/.test(l)); if (end < 0) end = lines.length; return lines.slice(at, end).join('\n'); };
const flow = (g, id) => g.flows.find((f) => f.id === id);

/** The sample shop with two outside places (a mailbox and a phone), a schedule, and three flows: two that say what you see, one that doesn't. */
const OUTSIDE = [
  { id: 'mail', label: 'Mailbox', kind: 'external', summary: 'Where the mails land.' },
  { id: 'phone', label: 'Phone', kind: 'external', summary: 'The messages on the phone.' },
];
const FLOWS = [
  { id: 'order', title: 'An order comes in', description: 'From the click to the mail.',
    trigger: { kind: 'click', text: 'The customer presses «Buy»', node: 'web' },
    steps: [
      { node: 'web', note: 'The website sends the order' },
      { node: 'api', note: 'The server checks the cart and saves the order', you_see: { where: 'mail', text: 'A confirmation mail in your inbox', example: 'Order #1234 received' } },
      { node: 'shop-api/routes/orders.js', note: 'The order is kept' },
    ],
    outcome: { where: 'phone', text: 'A message on your phone with the customer\'s name.' } },
  { id: 'nightly', title: 'The nightly report',
    trigger: { kind: 'schedule', text: 'Every night the report runs', schedule: 'nightly-report' },
    steps: [
      { node: 'api', note: 'Builds the report' },
      { node: 'mail', note: 'Mails it', you_see: { where: 'mail', text: 'The report as a PDF in your inbox' } },
    ],
    outcome: { where: 'mail', text: 'The report as a PDF in your inbox, every morning.', example: 'Report 2026-11-01.pdf' } },
  { id: 'plain', title: 'Refund', steps: [{ node: 'web', note: 'Staff press Refund' }, { node: 'api', note: 'The server refunds it' }] },
];
function shopWithOutcomes(flows = FLOWS) {
  const root = shopApp();
  const arch = readJson(archFile(root));
  writeJson(archFile(root), { ...arch, nodes: [...arch.nodes, ...OUTSIDE], flows });
  writeJson(path.join(root, 'floorplan', 'schedules.json'), { schedules: [{ id: 'nightly-report', title: 'Nightly report', cron: '30 2 * * *', tz: 'Europe/Berlin', trigger: 'shop-api/server.js', runs: ['api'], source: 'README § Schedules' }] });
  return root;
}

let root, graph, output;
before(() => { root = shopWithOutcomes(); output = scanAndBuild(root); graph = readGraph(root); });
after(() => cleanup(root));

// ---------- the build ----------

test('a flow keeps its trigger, what you see at a step and its outcome, each ref resolved to a card', () => {
  const order = flow(graph, 'order');
  assert.deepEqual(order.trigger, { kind: 'click', text: 'The customer presses «Buy»', node: 'n:web' });
  assert.deepEqual(order.steps.map((s) => s.ref), ['n:web', 'n:api', 'f:shop-api/routes/orders.js']);
  assert.equal(order.steps[0].you_see, undefined, 'a step without it carries nothing');
  assert.deepEqual(order.steps[1].you_see, { where: 'n:mail', text: 'A confirmation mail in your inbox', example: 'Order #1234 received' });
  assert.deepEqual(order.outcome, { where: 'n:phone', text: 'A message on your phone with the customer\'s name.' });
  assert.deepEqual(flow(graph, 'nightly').outcome, { where: 'n:mail', text: 'The report as a PDF in your inbox, every morning.', example: 'Report 2026-11-01.pdf' });
  assert.match(output, /FLOWS {2}3 · with trigger 2 · with outcome 2 · outcomes at 2 places/);
  assert.doesNotMatch(output, /warning\(s\)/);
});

test('a trigger that names a schedule gets the clock\'s words from the Clock, in the map\'s language', () => {
  assert.deepEqual(flow(graph, 'nightly').trigger, { kind: 'schedule', text: 'Every night the report runs', schedule: 'nightly-report', when: 'daily at 02:30', tz: 'Europe/Berlin', cron: '30 2 * * *' });
  build(root, '--lang', 'de');
  try { assert.equal(flow(readGraph(root), 'nightly').trigger.when, 'täglich um 02:30'); } finally { build(root); }
});

test('graph.outcomes turns it round: per place, what arrives there and from which flow and step', () => {
  assert.deepEqual(Object.keys(graph.outcomes), ['n:mail', 'n:phone']);
  assert.deepEqual(graph.outcomes['n:mail'], [
    { flow: 'order', step: 1, text: 'A confirmation mail in your inbox', example: 'Order #1234 received' },
    { flow: 'nightly', step: 1, text: 'The report as a PDF in your inbox' },
    { flow: 'nightly', text: 'The report as a PDF in your inbox, every morning.', example: 'Report 2026-11-01.pdf' },
  ]);
  assert.deepEqual(graph.outcomes['n:phone'], [{ flow: 'order', text: 'A message on your phone with the customer\'s name.' }]);
});

test('the map\'s lookups tell the agent what starts a flow, what you see and what you have in the end', () => {
  const overview = JSON.parse(execFileSync(process.execPath, [path.join(root, 'floorplan', 'query.mjs'), 'overview'], { encoding: 'utf8' }));
  const order = overview.flows.find((f) => f.title === 'An order comes in');
  assert.equal(order.startsWhen, 'The customer presses «Buy»');
  assert.deepEqual(order.youSee, ['n:mail A confirmation mail in your inbox']);
  assert.equal(order.inTheEnd, 'n:phone A message on your phone with the customer\'s name.');
  assert.deepEqual(Object.keys(overview.flows.find((f) => f.title === 'Refund')), ['title', 'steps'], 'a plain flow as before');
});

test('an unknown place, trigger node, kind, schedule or field, and a missing text, are errors with a suggestion', () => {
  const r = shopWithOutcomes([
    { id: 'bad', title: 'Bad', trigger: { kind: 'clik', text: 'x', node: 'wbe', schedule: 'nightly-reprot', txt: 'y' },
      steps: [{ node: 'web', note: '', you_see: { where: 'mial', text: 'x' } }, { node: 'api', note: '', you_see: 'A mail' }],
      outcome: { where: 'phone', exemple: 'z' } },
  ]);
  try {
    run('scan.mjs', r);
    const out = buildOut(r);
    assert.match(out, /flows\[0\]\.trigger\.kind "clik" must be one of click, schedule, message, webhook, file, manual, other — did you mean "click"\?/);
    assert.match(out, /flows\[0\]\.trigger\.node "wbe" is neither a node id nor a scanned file — did you mean "web"\?/);
    assert.match(out, /flows\[0\]\.trigger\.schedule "nightly-reprot" is not a schedule the scan found or schedules\.json lists — did you mean "nightly-report"\?/);
    assert.match(out, /flows\[0\]\.trigger: unknown field "txt" — did you mean "text"\?/);
    assert.match(out, /flows\[0\]\.steps\[0\]\.you_see\.where "mial" is neither a node id nor a scanned file — did you mean "mail"\?/);
    assert.match(out, /flows\[0\]\.steps\[1\]\.you_see must be \{ "where": "<node id or file path>", "text": "…" \}/);
    assert.match(out, /flows\[0\]\.outcome: unknown field "exemple" — did you mean "example"\?/);
    assert.match(out, /flows\[0\]\.outcome\.text is required/);
    assert.ok(!fs.existsSync(path.join(r, 'floorplan', 'graph.json')), 'nothing is written');
  } finally { cleanup(r); }
});

test('flows without the new fields build exactly as before: no trigger, no you_see, no outcome, no graph.outcomes', () => {
  const r = shopApp();
  try {
    const arch = readJson(archFile(r));
    writeJson(archFile(r), { ...arch, flows: [{ id: 'refund', title: 'Refund an order', steps: [{ node: 'web', note: 'Staff press Refund' }, { node: 'api', note: 'The server refunds it' }] }] });
    const out = scanAndBuild(r);
    const g = readGraph(r);
    assert.deepEqual(g.flows, [{ id: 'refund', title: 'Refund an order', description: '', steps: [{ ref: 'n:web', note: 'Staff press Refund' }, { ref: 'n:api', note: 'The server refunds it' }] }]);
    assert.equal(g.outcomes, undefined);
    assert.match(out, /FLOWS {2}1 · with trigger 0 · with outcome 0 · outcomes at 0 places/);
    const md = mapOf(r);
    assert.doesNotMatch(entry(md, '### Refund an order (`refund`)'), /Trigger|You see/);
    assert.match(section(md, 'outcomes'), /^<!-- floorplan:outcomes -->\n## What you see\n\nNone\.\n$/);
    assert.deepEqual(flow(graph, 'plain'), { id: 'plain', title: 'Refund', description: '', steps: [{ ref: 'n:web', note: 'Staff press Refund' }, { ref: 'n:api', note: 'The server refunds it' }] }, 'a plain flow beside the others carries nothing new');
  } finally { cleanup(r); }
});

test('without any flow there is no FLOWS line, as before', () => {
  const r = shopApp();
  try { assert.doesNotMatch(scanAndBuild(r), /FLOWS {2}/); } finally { cleanup(r); }
});

// ---------- MAP.md ----------

test('MAP.md gives each flow its Trigger and You see lines, a step what you see there, and a What you see section by place', () => {
  const md = mapOf(root);
  const order = entry(md, '### An order comes in (`order`)');
  assert.match(order, /^> From the click to the mail\.$/m);
  assert.match(order, /^- Trigger: Click · The customer presses «Buy» · Website \(`web`\)$/m);
  assert.match(order, /^2\. Server \(`api`\): The server checks the cart and saves the order — You see: A confirmation mail in your inbox \(Mailbox \(`mail`\)\) · Example: Order #1234 received$/m);
  assert.match(order, /^3\. `shop-api\/routes\/orders\.js`: The order is kept$/m);
  assert.match(order, /^- You see: A message on your phone with the customer's name\. \(Phone \(`phone`\)\)$/m);
  const nightly = entry(md, '### The nightly report (`nightly`)');
  assert.match(nightly, /^- Trigger: Clock · Every night the report runs · daily at 02:30, time zone Europe\/Berlin$/m);
  assert.match(nightly, /^- You see: The report as a PDF in your inbox, every morning\. \(Mailbox \(`mail`\)\) · Example: Report 2026-11-01\.pdf$/m);
  const seen = section(md, 'outcomes');
  assert.match(seen, /^<!-- floorplan:outcomes -->\n## What you see\n\n### Mailbox \(`mail`\)\n/);
  assert.match(seen, /^- A confirmation mail in your inbox \(An order comes in\) · Example: Order #1234 received$/m);
  assert.match(seen, /^- The report as a PDF in your inbox \(The nightly report\)$/m);
  assert.match(seen, /^- The report as a PDF in your inbox, every morning\. \(The nightly report\) · Example: Report 2026-11-01\.pdf$/m);
  assert.match(seen, /\n### Phone \(`phone`\)\n- A message on your phone with the customer's name\. \(An order comes in\)\n/);
  // the eighth section sits between Flows and Health
  const markers = md.split('\n').filter((l) => /^<!-- floorplan:\w+ -->$/.test(l));
  assert.deepEqual(markers, ['parts', 'targets', 'rules', 'schedules', 'flows', 'outcomes', 'health', 'recent'].map((s) => `<!-- floorplan:${s} -->`));
});

test('in German MAP.md says Auslöser, Das siehst du, Beispiel and Klick, and the markers stay the same', () => {
  build(root, '--lang', 'de');
  try {
    const md = mapOf(root);
    assert.match(md, /^## Das siehst du$/m);
    assert.match(entry(md, '### An order comes in (`order`)'), /^- Auslöser: Klick · The customer presses «Buy» · Website \(`web`\)$/m);
    assert.match(entry(md, '### An order comes in (`order`)'), /— Das siehst du: A confirmation mail in your inbox \(Mailbox \(`mail`\)\) · Beispiel: Order #1234 received$/m);
    assert.match(entry(md, '### The nightly report (`nightly`)'), /^- Auslöser: Uhr · Every night the report runs · täglich um 02:30, Zeitzone Europe\/Berlin$/m);
    assert.match(section(md, 'outcomes'), /^- A message on your phone with the customer's name\. \(An order comes in\)$/m);
  } finally { build(root); }
});

test('text from the inputs cannot add structure to MAP.md: it is one line, and no line it writes starts a heading', () => {
  const r = shopWithOutcomes([{ id: 'f1', title: 'Flow', trigger: { kind: 'other', text: 't\n# no' }, steps: [{ node: 'web', note: '', you_see: { where: 'mail', text: 's\n# no', example: 'e\n- no' } }, { node: 'api', note: '' }], outcome: { where: 'phone', text: 'o\n## no' } }]);
  try {
    scanAndBuild(r);
    const md = mapOf(r);
    assert.match(md, /^- Trigger: Other · t # no$/m);
    assert.match(md, /— You see: s # no \(Mailbox \(`mail`\)\) · Example: e - no$/m);
    assert.match(section(md, 'outcomes'), /^- o ## no \(Flow\)$/m);
    assert.ok(!md.split('\n').some((l) => /^(# no|## no|- no)$/.test(l)), 'no injected line');
  } finally { cleanup(r); }
});

// ---------- the panel, run against a stand-in map ----------

const table = (lang) => ({ ...readJson(path.join(SKILL, 'assets', 'lang', 'en.json')), ...(lang === 'en' ? {} : readJson(path.join(SKILL, 'assets', 'lang', `${lang}.json`))) });
/** A stand-in for window.Floorplan, enough for ui/45-outcomes.js to run against a built graph. */
function standIn(g, lang = 'en') {
  const w = table(lang);
  const t = (k, vars) => (w[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => (vars && x in vars ? String(vars[x]) : m));
  const tn = (k, n, vars) => t(w[`${k}.${n === 1 ? 'one' : 'other'}`] ? `${k}.${n === 1 ? 'one' : 'other'}` : `${k}.other`, { n, ...vars });
  const el = () => ({ children: [], attrs: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} });
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const files = new Map(g.files.map((f) => [f.p, f]));
  const info = (id) => id.startsWith('n:') ? { type: 'node', name: nodes.get(id.slice(2)).label, kind: nodes.get(id.slice(2)).kind } : { type: 'file', name: files.get(id.slice(2))?.name || id, kind: 'file', path: id.slice(2) };
  const exists = (id) => id.startsWith('n:') ? nodes.has(id.slice(2)) : id.startsWith('f:') && files.has(id.slice(2));
  const chain = (id) => { const out = [id]; let n = id.startsWith('f:') ? files.get(id.slice(2))?.n : nodes.get(id.slice(2))?.parent; while (n) { out.push('n:' + n); n = nodes.get(n)?.parent; } return [...out, 'root']; };
  const out = { buttons: [], sections: { overview: [], item: [] }, panels: [], started: [], listeners: {}, closed: 0 };
  const SC = {
    graph: g, lang, t, tn, h: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), exported: null,
    info, exists, chain, colorOf: () => 'var(--n-external)', icon: () => '<svg></svg>', iconI: () => '<svg></svg>', icons: {}, state: { selected: null, container: 'root' },
    startFlow: (id, at) => out.started.push([id, at]),
    addHeaderButton: (b) => { const e = el(); out.buttons.push({ ...b, el: e }); return e; },
    addPanelSection: (where, fn) => out.sections[where].push(fn),
    showPanel: (html, bind) => out.panels.push({ html, bind }), closePanel: () => out.closed++, on: (ev, fn) => (out.listeners[ev] ||= []).push(fn),
  };
  const document = { createElement: () => el(), head: el(), querySelector: () => null, querySelectorAll: () => [] };
  const window = { Floorplan: SC };
  vm.runInNewContext(fs.readFileSync(path.join(SKILL, 'assets', 'ui', '45-outcomes.js'), 'utf8'), { window, document });
  return { ...out, out, api: window.FloorplanOutcomes };
}

test('the What you see button opens the panel: every place with what arrives there and from which flow, a line opens the flow at its step', () => {
  const p = standIn(graph);
  assert.equal(p.buttons.length, 1);
  assert.equal(p.buttons[0].label, 'What you see');
  assert.match(p.buttons[0].title, /2 places/);
  p.buttons[0].onClick();
  const { html } = p.panels.at(-1);
  for (const s of ['2 places', '4 entries', 'data-oc-back']) assert.ok(html.includes(s), `"${s}" is in the panel`);
  assert.ok(html.indexOf('Mailbox') < html.indexOf('Phone'), 'the places in the order the flows name them');
  assert.match(html, /data-go="n:mail"/);
  assert.match(html, /data-oc-open="order" data-oc-step="1"[^>]*>.*?<div class="rn">A confirmation mail in your inbox<\/div><div class="rd">An order comes in · step 2 of 3<\/div><div class="rp">Example: Order #1234 received<\/div>/);
  assert.match(html, /data-oc-open="nightly" data-oc-step=""[^>]*>.*?<div class="rn">The report as a PDF in your inbox, every morning\.<\/div><div class="rd">The nightly report · in the end<\/div>/);
  assert.match(html, /data-oc-open="order" data-oc-step=""[^>]*>.*?A message on your phone/);
  // a line opens the flow at its step: the last step for an outcome
  p.api.open('order', 1);
  p.api.open('order');
  assert.deepEqual(p.started, [['order', 1], ['order', 2]]);
  // the codebase panel has a way in; a place's card lists what arrives there, and a part holding it too
  assert.match(p.sections.overview[0]().html, /data-oc-all/);
  assert.match(p.sections.overview[0]().html, /2 places/);
  const here = (id) => { const r = p.sections.item[0](id); return r ? [...r.html.matchAll(/data-oc-open="([^"]+)" data-oc-step="([^"]*)"/g)].map((m) => `${m[1]}@${m[2]}`) : []; };
  assert.deepEqual(here('n:mail'), ['order@1', 'nightly@1', 'nightly@']);
  assert.deepEqual(here('n:phone'), ['order@']);
  assert.deepEqual(here('n:api'), [], 'nothing arrives at the server');
  assert.match(p.sections.item[0]('n:phone').html, /What arrives here/);
});

test('in German the button says Das siehst du, the panel Was hier ankommt, am Ende, Beispiel', () => {
  build(root, '--lang', 'de');
  try {
    const p = standIn(readGraph(root), 'de');
    assert.equal(p.buttons[0].label, 'Das siehst du');
    p.buttons[0].onClick();
    const { html } = p.panels.at(-1);
    for (const s of ['2 Orte', '4 Einträge', 'An order comes in · Schritt 2 von 3', 'The nightly report · am Ende', 'Beispiel: Order #1234 received']) assert.ok(html.includes(s), `"${s}" is in the German panel`);
    assert.match(p.sections.item[0]('n:phone').html, /Was hier ankommt/);
  } finally { build(root); }
});

test('without outcomes the panel adds nothing to the map', () => {
  const r = shopApp();
  try {
    scanAndBuild(r);
    const p = standIn(readGraph(r));
    assert.equal(p.buttons.length, 0);
    assert.equal(p.sections.overview.length + p.sections.item.length, 0);
  } finally { cleanup(r); }
});

// ---------- the built page and the export ----------

test('the built page carries the panel and the words for the flow bar, and every word is in both language tables', () => {
  const page = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.ok(page.includes('/* ui/45-outcomes.js */'));
  assert.ok(page.includes("id: 'btn-outcomes'"));
  for (const code of ['en', 'de']) {
    const tbl = readJson(path.join(SKILL, 'assets', 'lang', `${code}.json`));
    for (const k of ['outcomes.button', 'outcomes.title', 'outcomes.intro', 'outcomes.here', 'outcomes.youSee', 'outcomes.startsWhen', 'outcomes.inTheEnd', 'outcomes.example', 'outcomes.kind.click', 'outcomes.kind.schedule', 'outcomes.kind.message', 'outcomes.kind.webhook', 'outcomes.kind.file', 'outcomes.kind.manual', 'outcomes.kind.other']) assert.ok(tbl[k], `${code}.json ${k}`);
  }
});

test('an exported copy keeps what you see with the flows, and drops it with them', () => {
  const copy = path.join(root, 'copy.html');
  const data = (file) => JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(fs.readFileSync(file, 'utf8'))[1]);
  execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', copy], { cwd: root, encoding: 'utf8' });
  assert.deepEqual(Object.keys(data(copy).outcomes), ['n:mail', 'n:phone']);
  assert.equal(data(copy).flows.find((f) => f.id === 'order').trigger.kind, 'click');
  execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', copy, '--include', 'notes'], { cwd: root, encoding: 'utf8' });
  assert.equal(data(copy).outcomes, undefined);
  assert.deepEqual(data(copy).flows, []);
});

// ---------- in a real browser ----------

test('in the browser the flow list and the guided view show the trigger, the eye card and the end card, the panel opens the flow at a step, and nothing errors', async (t) => {
  const browser = await launchBrowser();
  if (!browser) return t.skip('no Playwright with a Chromium in this environment');
  try {
    const { page, errors } = await openMap(browser, root);
    // the flow list: the trigger under each flow that has one, the clock's words for a schedule
    await page.click('#flows-btn');
    const menu = await page.evaluate(() => document.querySelector('#flowmenu').innerText);
    assert.match(menu, /An order comes in[\s\S]*Starts when: The customer presses «Buy»/);
    assert.match(menu, /The nightly report[\s\S]*Starts when: Every night the report runs · daily at 02:30/);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#flowmenu .fg-start').length), 2, 'the plain flow has none');
    // the guided view: the trigger at the first step, the eye card at the second, the end card at the last
    await page.click('#flowmenu [data-flow="order"]');
    await page.waitForFunction(() => !document.querySelector('#flowbar').hidden && window.Floorplan.state.flow?.i === 0);
    let bar = await page.evaluate(() => document.querySelector('#flowbar').innerText);
    assert.match(bar, /Starts when: The customer presses «Buy»/);
    assert.doesNotMatch(bar, /You see:|In the end:/);
    await page.click('#fl-next');
    await page.waitForFunction(() => window.Floorplan.state.flow?.i === 1);
    bar = await page.evaluate(() => document.querySelector('#flowbar').innerText);
    assert.match(bar, /You see: A confirmation mail in your inbox/);
    assert.match(bar, /Example: Order #1234 received/);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#flowbar .fg-see').length), 1);
    await page.click('#fl-next');
    await page.waitForFunction(() => window.Floorplan.state.flow?.i === 2);
    bar = await page.evaluate(() => document.querySelector('#flowbar').innerText);
    assert.match(bar, /In the end: A message on your phone with the customer's name\./);
    await page.keyboard.press('Escape');
    // the panel: a line opens the flow at that step
    await page.click('#btn-outcomes');
    await page.waitForFunction(() => document.querySelectorAll('#panel [data-oc-open]').length === 4);
    const panel = await page.evaluate(() => document.querySelector('#panel').innerText);
    for (const s of ['2 places', '4 entries', 'Mailbox', 'Phone', 'A confirmation mail in your inbox', 'An order comes in · step 2 of 3', 'The nightly report · in the end']) assert.ok(panel.includes(s), `"${s}" is in the panel`);
    await page.click('#panel [data-oc-open="nightly"][data-oc-step="1"]');
    await page.waitForFunction(() => window.Floorplan.state.flow?.f.id === 'nightly' && window.Floorplan.state.flow.i === 1);
    assert.match(await page.evaluate(() => document.querySelector('#flowbar').innerText), /You see: The report as a PDF in your inbox/);
    await page.keyboard.press('Escape');
    // the place's card lists what arrives there
    await page.evaluate(() => window.Floorplan.go('root', { select: 'n:mail' }));
    await page.waitForFunction(() => /What arrives here/.test(document.querySelector('#panel').innerText));
    assert.equal(await page.evaluate(() => document.querySelectorAll('#panel [data-oc-open]').length), 3);
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});
