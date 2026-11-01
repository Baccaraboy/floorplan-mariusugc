// The map's lookups know the other floors: graph-query.js (the Ask tools and floorplan/query.mjs) answers who writes
// where (targets), which rules and decisions hold, also at one place through its parents (rules), what a clock starts
// and when (schedules), what is running as the owner's tooling reports it (ops), what you see at each place
// (outcomes) and what starts each flow and what you have in the end (flows); show lists the floors at a card and
// overview counts them. A map without the files answers exactly as before, plus empty lists, never an error.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { REPO, SKILL, shopApp, scanAndBuild, run, readGraph, readJson, writeJson, cleanup } from './helpers.mjs';

const FIXTURES = path.join(REPO, 'tests', 'fixtures');
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

/** The sample shop with every floor: a database, a mailbox and a phone, two targets, the rules fixture, two schedules, the ops fixture and flows that say what you see. */
function shopWithFloors() {
  const root = shopApp();
  const archFile = path.join(root, 'floorplan', 'architecture.json');
  const arch = readJson(archFile);
  writeJson(archFile, {
    ...arch,
    nodes: [...arch.nodes,
      { id: 'db', label: 'Database', kind: 'external', summary: 'Where orders are kept.' },
      { id: 'mail', label: 'Mailbox', kind: 'external', summary: 'Where the mails land.' },
      { id: 'phone', label: 'Phone', kind: 'external', summary: 'The messages on the phone.' },
    ],
    flows: [
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
    ],
  });
  writeJson(path.join(root, 'floorplan', 'targets.json'), { targets: [
    { id: 'orders', name: 'Orders', kind: 'database', external: 'db', writers: ['api'], readers: ['web'], policy: 'single-writer', note: 'Only the server changes orders.' },
    { id: 'notes', name: 'Customer notes', kind: 'file', writers: ['shop-api/routes/notes.js', 'shop-web/src/api.js'], policy: 'single-writer' },
  ] });
  fs.copyFileSync(path.join(FIXTURES, 'rules.json'), path.join(root, 'floorplan', 'rules.json'));
  writeJson(path.join(root, 'floorplan', 'schedules.json'), { schedules: [
    { id: 'nightly-report', title: 'Nightly report', cron: '30 2 * * *', tz: 'Europe/Berlin', trigger: 'shop-api/server.js', runs: ['api'], source: 'README § Schedules' },
    { id: 'sync', title: 'Order sync', cron: '*/15 * * * *', runs: ['orders'], calls: 'POST /api/notes', note: 'Pulls new orders.', source: 'README § Schedules', enabled: false },
  ] });
  writeJson(path.join(root, 'floorplan', 'ops.json'), { ...readJson(path.join(FIXTURES, 'ops.json')), asOf: hoursAgo(1) });
  return root;
}

/** The lookups of graph-query.js on a built graph, the way the viewer and query.mjs load them. */
function queryOf(graph) {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(SKILL, 'assets', 'graph-query.js'), 'utf8'), ctx);
  // every answer as JSON, the way query.mjs prints it (and as values of this realm, so deepEqual can compare them)
  const q = Object.fromEntries(Object.entries(ctx.createGraphQuery(graph)).map(([k, fn]) => [k, (...args) => JSON.parse(JSON.stringify(fn(...args)))]));
  return { q, ctx };
}
const ids = (list) => Array.from(list, (x) => x.id);
const cli = (root, ...args) => execFileSync(process.execPath, [path.join(root, 'floorplan', 'query.mjs'), ...args], { encoding: 'utf8' });
const cliJson = (root, ...args) => JSON.parse(cli(root, ...args));

let root, graph, q, route;
before(() => {
  root = shopWithFloors();
  scanAndBuild(root);
  graph = readGraph(root);
  ({ q } = queryOf(graph));
  route = (key) => 'r:' + graph.routes.findIndex((r) => `${r.m} ${r.p}` === key);
});
after(() => cleanup(root));

// ---------- the floors, one query each ----------

test('targets: every target with its box, writers and readers as ids with names, the conflict and the note; words narrow the list', () => {
  const all = q.targets();
  assert.deepEqual(ids(all), ['orders', 'notes']);
  const orders = all[0];
  assert.equal(orders.name, 'Orders');
  assert.equal(orders.kind, 'database');
  assert.equal(orders.policy, 'single-writer');
  assert.equal(orders.conflict, false);
  assert.equal(orders.note, 'Only the server changes orders.');
  assert.deepEqual(orders.box, { id: 'n:db', name: 'Database' });
  assert.deepEqual(orders.writers, [{ id: 'n:api', name: 'Server', ref: 'api' }]);
  assert.deepEqual(orders.readers, [{ id: 'n:web', name: 'Website', ref: 'web' }]);
  const notes = all[1];
  assert.equal(notes.conflict, true);
  assert.equal(notes.writerCount, 2);
  assert.equal(notes.box, null);
  assert.deepEqual(ids(notes.writers), ['f:shop-api/routes/notes.js', 'f:shop-web/src/api.js']);
  assert.equal(notes.note, undefined);
  // by id, name, kind or note, every word
  assert.deepEqual(ids(q.targets('orders')), ['orders']);
  assert.deepEqual(ids(q.targets('customer NOTES')), ['notes']);
  assert.deepEqual(ids(q.targets('database')), ['orders']);
  assert.deepEqual(ids(q.targets('server changes')), ['orders']);
  assert.deepEqual(q.targets('nothing like this'), []);
});

test('rules: all of them, the retired ones last, each with where it applies; words narrow the list', () => {
  const all = q.rules();
  assert.deepEqual(ids(all), ['one-writer', 'merge-when-green', 'no-direct-db']);
  const one = all[0];
  assert.equal(one.kind, 'rule');
  assert.equal(one.title, 'One writer per target');
  assert.equal(one.text, 'Only the server changes orders; the website reads them through the server.');
  assert.equal(one.source, 'CLAUDE.md § Build rules');
  assert.equal(one.since, '2026-10-25');
  assert.equal(one.status, 'active');
  assert.equal(one.everywhere, false);
  assert.deepEqual(one.appliesTo, [
    { id: 'n:api', name: 'Server' },
    { id: 't:orders', name: 'Orders', box: 'n:db' },
    { id: 'f:shop-web/src/api.js', name: graph.files.find((f) => f.p === 'shop-web/src/api.js').name },
    { id: route('POST /api/orders/:id/refund'), name: graph.routes[+route('POST /api/orders/:id/refund').slice(2)].name },
  ]);
  const merge = all[1];
  assert.equal(merge.kind, 'decision');
  assert.equal(merge.everywhere, true);
  assert.deepEqual(merge.appliesTo, []);
  assert.equal(all[2].status, 'retired');
  assert.equal(all[2].until, '2026-10-25');
  assert.deepEqual(all[2].tags, ['history']);
  assert.deepEqual(ids(q.rules('merge green')), ['merge-when-green']);
  assert.deepEqual(ids(q.rules('decision')), ['merge-when-green'], 'the kind counts as a word');
  assert.deepEqual(ids(q.rules('database')), ['no-direct-db'], 'the title and text count');
  assert.deepEqual(q.rules('nothing like this'), []);
});

test('rules at a place: the rules that name it, its file, its part or a parent, with the card they reach it through, then the project-wide ones', () => {
  // a file inside the server: the rule on the part reaches it through the part
  const atFile = q.rules('shop-api/auth.js');
  assert.deepEqual(atFile.map((r) => [r.id, r.via?.id, r.everywhere]), [['one-writer', 'n:api', false], ['merge-when-green', undefined, true]]);
  assert.deepEqual(atFile[0].via, { id: 'n:api', name: 'Server' });
  // an endpoint named itself
  assert.deepEqual(q.rules('POST /api/orders/:id/refund').map((r) => [r.id, r.via?.id]), [['one-writer', route('POST /api/orders/:id/refund')], ['merge-when-green', undefined]]);
  // an endpoint of the part, not named itself
  assert.deepEqual(q.rules('GET /api/orders').map((r) => [r.id, r.via?.id]), [['one-writer', 'n:api'], ['merge-when-green', undefined]]);
  // the part itself, by id or by card id
  assert.deepEqual(q.rules('api').map((r) => [r.id, r.via?.id]), [['one-writer', 'n:api'], ['merge-when-green', undefined]]);
  assert.deepEqual(q.rules('n:api').map((r) => r.id), ['one-writer', 'merge-when-green']);
  // a target by its id, and its box on the map
  assert.deepEqual(q.rules('orders').map((r) => [r.id, r.via?.id]), [['one-writer', 't:orders'], ['merge-when-green', undefined]]);
  assert.deepEqual(q.rules('t:orders').map((r) => r.id), ['one-writer', 'merge-when-green']);
  assert.deepEqual(q.rules('n:db').map((r) => [r.id, r.via?.id]), [['one-writer', 't:orders'], ['merge-when-green', undefined]]);
  // the retired rule still shows where it is listed; a file named itself and inside the website
  assert.deepEqual(q.rules('web').map((r) => [r.id, r.status]), [['no-direct-db', 'retired'], ['merge-when-green', 'active']]);
  assert.deepEqual(q.rules('f:shop-web/src/api.js').map((r) => [r.id, r.via?.id]), [['one-writer', 'f:shop-web/src/api.js'], ['no-direct-db', 'n:web'], ['merge-when-green', undefined]]);
  // a place nothing names: only the project-wide ones
  assert.deepEqual(q.rules('n:phone').map((r) => r.id), ['merge-when-green']);
});

test('schedules: each plan with its cron in words, time zone, trigger and runs as ids with names, and the next start of the day', () => {
  const all = q.schedules();
  assert.deepEqual(ids(all), ['nightly-report', 'sync']);
  const nightly = all[0];
  assert.equal(nightly.title, 'Nightly report');
  assert.equal(nightly.cron, '30 2 * * *');
  assert.equal(nightly.human, 'daily at 02:30');
  assert.equal(nightly.tz, 'Europe/Berlin');
  assert.equal(nightly.enabled, true);
  assert.equal(nightly.found, false);
  assert.deepEqual(nightly.trigger, { id: 'f:shop-api/server.js', name: graph.files.find((f) => f.p === 'shop-api/server.js').name });
  assert.deepEqual(nightly.runs, [{ id: 'n:api', name: 'Server' }]);
  assert.equal(nightly.source, 'README § Schedules');
  assert.deepEqual(nightly.times, [150]);
  assert.equal(nightly.next.at, '02:30');
  assert.ok(nightly.next.inMinutes >= 0 && nightly.next.inMinutes < 24 * 60, `minutes until the next start: ${nightly.next.inMinutes}`);
  const sync = all[1];
  assert.equal(sync.enabled, false);
  assert.equal(sync.human, 'every 15 minutes');
  assert.equal(sync.trigger, null);
  assert.deepEqual(sync.runs, [{ id: 't:orders', name: 'Orders', box: 'n:db' }, { id: route('POST /api/notes'), name: graph.routes[+route('POST /api/notes').slice(2)].name }], 'a target by its id, and the endpoint the plan calls');
  assert.equal(sync.calls, 'POST /api/notes');
  assert.equal(sync.note, 'Pulls new orders.');
  assert.equal(sync.next, null, 'a plan that is switched off has no next start');
});

test('ops: the whole report worst first with its time, or one place with everything inside it and the worst status', () => {
  const all = q.ops();
  assert.equal(all.source, 'tools/ops-export.sh');
  assert.equal(all.stale, false);
  assert.ok(!Number.isNaN(Date.parse(all.asOf)));
  assert.deepEqual(all.counts, { ok: 1, warn: 1, down: 1, unknown: 1 });
  assert.deepEqual(all.items.map((it) => [it.id, it.status]), [[route('POST /api/notes'), 'down'], ['f:shop-api/routes/orders.js', 'warn'], ['n:api', 'ok'], ['n:web', 'unknown']]);
  assert.equal(all.items[2].name, 'Server');
  assert.equal(all.items[2].ref, 'api');
  assert.equal(all.items[2].version, 'v2026.11.01');
  assert.deepEqual(all.items[2].metrics, { 'runs today': 12, queue: 0 });
  assert.equal(all.items[0].lastError, '503 from the notes service');
  // one place: its own entry, the entries inside it, and the worst of them
  const api = q.ops('api');
  assert.equal(api.id, 'n:api');
  assert.equal(api.name, 'Server');
  assert.equal(api.status, 'down', 'an endpoint that is down turns its server red');
  assert.deepEqual(api.items.map((it) => it.id), [route('POST /api/notes'), 'f:shop-api/routes/orders.js', 'n:api']);
  assert.ok(!Number.isNaN(Date.parse(api.asOf)));
  const file = q.ops('shop-api/routes/orders.js');
  assert.equal(file.status, 'warn');
  assert.deepEqual(file.items.map((it) => it.id), ['f:shop-api/routes/orders.js']);
  const phone = q.ops('n:phone');
  assert.equal(phone.status, null, 'a place nothing reports on');
  assert.deepEqual(phone.items, []);
  assert.throws(() => q.ops('no-such-thing'), /Unknown id/);
});

test('outcomes: per place what arrives there and from which flow and step, or one place; flows: what starts each one and what you have in the end', () => {
  const all = q.outcomes();
  assert.deepEqual(all.map((o) => o.where), [{ id: 'n:mail', name: 'Mailbox' }, { id: 'n:phone', name: 'Phone' }]);
  assert.deepEqual(all[0].arrives, [
    { flow: { id: 'order', title: 'An order comes in' }, step: { index: 1, id: 'n:api', name: 'Server' }, text: 'A confirmation mail in your inbox', example: 'Order #1234 received' },
    { flow: { id: 'nightly', title: 'The nightly report' }, step: { index: 1, id: 'n:mail', name: 'Mailbox' }, text: 'The report as a PDF in your inbox' },
    { flow: { id: 'nightly', title: 'The nightly report' }, text: 'The report as a PDF in your inbox, every morning.', example: 'Report 2026-11-01.pdf' },
  ]);
  assert.deepEqual(q.outcomes('phone').map((o) => o.where.id), ['n:phone']);
  assert.deepEqual(q.outcomes('n:mail')[0].arrives.map((a) => a.text), ['A confirmation mail in your inbox', 'The report as a PDF in your inbox', 'The report as a PDF in your inbox, every morning.']);
  assert.deepEqual(q.outcomes('api'), [], 'a place where nothing arrives');
  assert.throws(() => q.outcomes('no-such-thing'), /Unknown id/);
  const flows = q.flows();
  assert.deepEqual(ids(flows), ['order', 'nightly', 'plain']);
  const order = flows[0];
  assert.equal(order.title, 'An order comes in');
  assert.equal(order.description, 'From the click to the mail.');
  assert.deepEqual(order.trigger, { kind: 'click', text: 'The customer presses «Buy»', at: { id: 'n:web', name: 'Website' } });
  assert.deepEqual(order.steps.map((s) => s.id), ['n:web', 'n:api', 'f:shop-api/routes/orders.js']);
  assert.equal(order.steps[1].name, 'Server');
  assert.equal(order.steps[1].note, 'The server checks the cart and saves the order');
  assert.deepEqual(order.steps[1].youSee, { where: { id: 'n:mail', name: 'Mailbox' }, text: 'A confirmation mail in your inbox', example: 'Order #1234 received' });
  assert.equal(order.steps[0].youSee, undefined);
  assert.deepEqual(order.outcome, { where: { id: 'n:phone', name: 'Phone' }, text: 'A message on your phone with the customer\'s name.' });
  // a clock behind the trigger: the schedule's words, time zone and cron
  assert.deepEqual(flows[1].trigger, { kind: 'schedule', text: 'Every night the report runs', schedule: 'nightly-report', when: 'daily at 02:30', tz: 'Europe/Berlin', cron: '30 2 * * *' });
  assert.deepEqual(Object.keys(flows[2]), ['id', 'title', 'steps'], 'a plain flow carries nothing more');
});

// ---------- the floors at a card, and in the overview ----------

test('show lists the floors at a card: the rules here, the targets it writes and reads, the schedules here, its status and what you see here', () => {
  const api = q.show('api');
  assert.deepEqual(api.rulesHere, [{ id: 'one-writer', title: 'One writer per target' }]);
  assert.deepEqual(api.targetsWritten, [{ id: 't:orders', name: 'Orders', box: 'n:db' }, { id: 't:notes', name: 'Customer notes', via: { id: 'f:shop-api/routes/notes.js', name: graph.files.find((f) => f.p === 'shop-api/routes/notes.js').name } }]);
  assert.equal(api.targetsRead, undefined);
  assert.deepEqual(api.schedulesHere, [{ id: 'nightly-report', title: 'Nightly report', when: 'daily at 02:30' }]);
  assert.equal(api.ops.status, 'down');
  assert.equal(api.ops.version, 'v2026.11.01');
  assert.deepEqual(api.ops.inside.map((it) => [it.id, it.status]), [[route('POST /api/notes'), 'down'], ['f:shop-api/routes/orders.js', 'warn']]);
  assert.equal(api.youSeeHere, undefined);
  // a file: the rule through its part, its own target, no schedule, its own status
  const notes = q.show('shop-api/routes/notes.js');
  assert.deepEqual(ids(notes.rulesHere), ['one-writer']);
  assert.deepEqual(notes.targetsWritten, [{ id: 't:notes', name: 'Customer notes' }]);
  assert.equal(notes.schedulesHere, undefined);
  assert.equal(notes.ops.status, 'down', 'the endpoint inside it is down');
  const web = q.show('web');
  assert.deepEqual(ids(web.rulesHere), ['no-direct-db']);
  assert.deepEqual(web.targetsRead, [{ id: 't:orders', name: 'Orders', box: 'n:db' }]);
  assert.deepEqual(web.ops, { status: 'unknown', version: 'v2026.10.30', note: 'Deployed by the website pipeline' });
  // a target's box, and a place where things arrive
  const db = q.show('n:db');
  assert.deepEqual(db.boxOf, [{ id: 't:orders', name: 'Orders' }]);
  assert.deepEqual(ids(db.rulesHere), ['one-writer']);
  const mail = q.show('n:mail');
  assert.deepEqual(mail.youSeeHere.map((o) => [o.flow.title, o.text]), [['An order comes in', 'A confirmation mail in your inbox'], ['The nightly report', 'The report as a PDF in your inbox'], ['The nightly report', 'The report as a PDF in your inbox, every morning.']]);
  // the trigger of a schedule shows it too
  assert.deepEqual(ids(q.show('shop-api/server.js').schedulesHere), ['nightly-report']);
});

test('overview counts the floors and says how to ask for each', () => {
  const ov = q.overview();
  assert.deepEqual(ov.floors.targets, { count: 2, conflicts: 1, ask: 'targets [words]' });
  assert.deepEqual(ov.floors.rules, { rules: 2, decisions: 1, retired: 1, ask: 'rules [words | id]' });
  assert.deepEqual({ ...ov.floors.schedules, next: undefined }, { count: 2, found: 0, declared: 2, off: 1, next: undefined, ask: 'schedules' });
  assert.match(ov.floors.schedules.next, /^02:30 Europe\/Berlin Nightly report$/);
  assert.deepEqual({ ...ov.floors.ops, asOf: undefined }, { asOf: undefined, stale: false, counts: { ok: 1, warn: 1, down: 1, unknown: 1 }, ask: 'ops [id]' });
  assert.ok(!Number.isNaN(Date.parse(ov.floors.ops.asOf)));
  assert.deepEqual(ov.floors.outcomes, { places: 2, ask: 'outcomes [id]' });
  assert.equal(ov.flows.find((f) => f.title === 'The nightly report').startsWhen, 'Every night the report runs');
});

// ---------- without the files ----------

test('a map without the files answers as before: no floors in the overview, nothing new on a card, empty lists and never an error', () => {
  const r = shopApp();
  try {
    scanAndBuild(r);
    const { q: plain } = queryOf(readGraph(r));
    assert.equal(plain.overview().floors, undefined);
    assert.deepEqual(plain.targets(), []);
    assert.deepEqual(plain.targets('orders'), []);
    assert.deepEqual(plain.rules(), []);
    assert.deepEqual(plain.rules('api'), []);
    assert.deepEqual(plain.rules('anything'), []);
    assert.deepEqual(plain.schedules(), []);
    assert.deepEqual(plain.ops(), { asOf: null, source: null, stale: false, counts: { ok: 0, warn: 0, down: 0, unknown: 0 }, items: [] });
    assert.deepEqual(plain.ops('api'), { asOf: null, source: null, stale: false, id: 'n:api', name: 'Server', status: null, items: [] });
    assert.deepEqual(plain.outcomes(), []);
    assert.deepEqual(plain.outcomes('api'), []);
    assert.deepEqual(plain.flows(), []);
    const api = plain.show('api');
    for (const k of ['rulesHere', 'targetsWritten', 'targetsRead', 'schedulesHere', 'ops', 'youSeeHere', 'boxOf']) assert.equal(api[k], undefined, k);
    // the CLI too
    for (const args of [['targets'], ['rules'], ['rules', 'api'], ['schedules'], ['ops'], ['ops', 'api'], ['outcomes'], ['flows']]) assert.doesNotThrow(() => cliJson(r, ...args), args.join(' '));
  } finally { cleanup(r); }
});

// ---------- the command line ----------

test('query.mjs has a command per floor, each answering in JSON, and the help names them', () => {
  assert.deepEqual(ids(cliJson(root, 'targets')), ['orders', 'notes']);
  assert.deepEqual(ids(cliJson(root, 'targets', 'customer', 'notes')), ['notes']);
  assert.deepEqual(ids(cliJson(root, 'rules')), ['one-writer', 'merge-when-green', 'no-direct-db']);
  assert.deepEqual(ids(cliJson(root, 'rules', 'shop-api/auth.js')), ['one-writer', 'merge-when-green']);
  assert.deepEqual(ids(cliJson(root, 'rules', 'GET', '/api/orders')), ['one-writer', 'merge-when-green'], 'an endpoint as two words');
  assert.deepEqual(ids(cliJson(root, 'rules', 'merge')), ['merge-when-green']);
  assert.deepEqual(ids(cliJson(root, 'schedules')), ['nightly-report', 'sync']);
  assert.equal(cliJson(root, 'ops').counts.down, 1);
  assert.equal(cliJson(root, 'ops', 'api').status, 'down');
  assert.deepEqual(cliJson(root, 'outcomes').map((o) => o.where.id), ['n:mail', 'n:phone']);
  assert.deepEqual(cliJson(root, 'outcomes', 'phone').map((o) => o.where.id), ['n:phone']);
  assert.deepEqual(ids(cliJson(root, 'flows')), ['order', 'nightly', 'plain']);
  assert.ok(cliJson(root, 'overview').floors, 'the overview counts the floors');
  const help = cli(root, '--help');
  for (const c of ['overview', 'find', 'show', 'path', 'targets [words]', 'rules [words | id]', 'schedules', 'ops [id]', 'outcomes [id]', 'flows']) assert.ok(help.includes(c), `--help names ${c}`);
  assert.equal(cli(root), help, 'no command prints the same help');
  let failed = null;
  try { cli(root, 'nonsense'); } catch (e) { failed = e; }
  assert.equal(failed?.status, 1);
  assert.ok(String(failed.stdout).includes('rules [words | id]'), 'an unknown command prints the help');
  try { cli(root, 'ops', 'no-such-thing'); assert.fail('an unknown place is an error'); } catch (e) { assert.deepEqual(JSON.parse(e.stdout), { error: 'Unknown id "no-such-thing". Use find first; ids look like n:api, f:src/app.ts, r:12, s:src/app.ts#3.' }); }
});

// ---------- the instructions to the agents ----------

test('the Ask instructions and the CLAUDE.local.md note name the commands, one line per floor', () => {
  const { ctx } = queryOf(graph);
  const cliText = ctx.floorplanAskInstructions(graph, 'cli');
  for (const c of ['query.mjs targets', 'query.mjs rules', 'query.mjs schedules', 'query.mjs ops', 'query.mjs outcomes', 'query.mjs flows']) assert.ok(cliText.includes(c), `the CLI instructions name ${c}`);
  assert.match(cliText, /who writes where/);
  const appText = ctx.floorplanAskInstructions(graph, 'app');
  assert.doesNotMatch(appText, /query\.mjs/, 'the app has no shell');
  assert.match(appText, /rules here/i, 'the app is told where the floors are');
  run('build.mjs', root, '--agent', 'claude', '--claude-md');
  const notes = fs.readFileSync(path.join(root, 'CLAUDE.local.md'), 'utf8');
  for (const c of ['query.mjs find', 'query.mjs show', 'query.mjs path', 'query.mjs overview', 'query.mjs targets', 'query.mjs rules', 'query.mjs schedules', 'query.mjs ops', 'query.mjs outcomes', 'query.mjs flows']) assert.ok(notes.includes(c), `CLAUDE.local.md names ${c}`);
});
