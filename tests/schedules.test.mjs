// The Clock: what a clock starts, not a person. The scan finds schedules in the files that hold them (GitHub Actions,
// Vercel crons, n8n triggers, crontabs, ofelia labels), floorplan/schedules.json adds what the scan can't see and
// overrides a find by id, and the build merges them into graph.schedules: each plan with its cron in words in the
// map's language, the start minutes of one day for the strip, its trigger and what it runs, and an event edge between
// the two when both are on the map; MAP.md gets a Schedules section, the map a Clock button with a 24-hour strip, the
// list and marks on the cards. Without a find and without the file, nothing changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { REPO, SKILL, lib, makeProject, shopApp, scanAndBuild, run, readGraph, readJson, writeJson, launchBrowser, openMap, cleanup } from './helpers.mjs';

const { parseCron, cronTimes, cronWords, intervalWords, intervalTimes } = await lib('cron-text.mjs');
const { strings, fill } = await lib('lang.mjs');

const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'schedules');
const build = (root, ...args) => run('build.mjs', root, '--no-claude-md', ...args);
const buildOut = (root, ...args) => { try { return build(root, ...args); } catch (e) { return String(e.stdout) + String(e.stderr); } };
const schedulesFile = (root) => path.join(root, 'floorplan', 'schedules.json');
const mapOf = (root) => fs.readFileSync(path.join(root, 'floorplan', 'MAP.md'), 'utf8');
/** The Schedules section of MAP.md: from its marker to the next one. */
const section = (md) => { const from = md.indexOf('<!-- floorplan:schedules -->'); assert.ok(from >= 0, 'the Schedules marker is in MAP.md'); return md.slice(from, md.indexOf('<!-- floorplan:flows -->')); };
const plan = (g, id) => g.schedules.find((s) => s.id === id);
const ids = (items) => Array.from(items, (x) => x.id);
const words = (lang) => { const w = strings(lang); return (k, vars) => fill(w[k] ?? k, vars); };

/** The sample shop with every fixture the scanner knows, loose at the root beside the two repos. */
function shopWithSchedules() {
  const root = shopApp();
  fs.cpSync(FIXTURES, root, { recursive: true });
  return root;
}
/** What an owner writes: an override by id, a plan of their own, a find switched off, and one in words only. */
const OWNER = { schedules: [
  { id: 'actions-report', runs: ['api'], note: 'Builds the PDF and mails it.' },
  { id: 'nightly-cleanup', title: { en: 'Nightly cleanup', de: 'Nächtliches Aufräumen' }, cron: '30 2 * * *', tz: 'Europe/Berlin', trigger: 'shop-api/server.js', runs: ['POST /api/orders/:id/refund', 'shop-web/**'], calls: 'node cleanup.js', source: 'README § Schedules' },
  { id: 'vercel-api-cron-digest', enabled: false },
  { id: 'by-hand', title: 'Hand-run report', human: 'whenever the owner remembers', source: 'README § Schedules' },
] };

let root, graph, output;
before(() => { root = shopWithSchedules(); writeJson(schedulesFile(root), OWNER); output = scanAndBuild(root); graph = readGraph(root); });
after(() => cleanup(root));

// ---------- the scan ----------

test('the scan finds every form: GitHub Actions, Vercel crons, n8n triggers, crontab lines and ofelia labels, each with its file', () => {
  const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  const by = Object.fromEntries(scan.schedules.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(by).sort(), ['actions-ci', 'actions-ci-2', 'actions-report', 'cron-backup-js', 'cron-holer-sh', 'cron-prune-logs', 'cron-report-py', 'n8n-sync-orders', 'n8n-sync-orders-2', 'n8n-weekly-digest', 'ofelia-backup', 'ofelia-ping', 'ofelia-prune', 'vercel-api-cron-cleanup', 'vercel-api-cron-digest']);
  // GitHub Actions: the workflow's name, the cron line (quoted or not, deeper or at the same indent), UTC
  assert.deepEqual(by['actions-report'], { id: 'actions-report', title: 'Nightly report', cron: '30 2 * * *', tz: 'UTC', kind: 'github-actions', source: '.github/workflows/report.yml', trigger: '.github/workflows/report.yml' });
  assert.equal(by['actions-ci'].cron, '0 6 * * 1-5');
  assert.equal(by['actions-ci-2'].cron, '0 */6 * * *', 'a second cron in the same workflow gets -2');
  // Vercel: the path is what the cron calls, with GET, without its query
  assert.deepEqual(by['vercel-api-cron-cleanup'], { id: 'vercel-api-cron-cleanup', title: 'Cleanup', cron: '0 3 * * *', tz: 'UTC', calls: 'GET /api/cron/cleanup', kind: 'vercel', source: 'vercel.json', trigger: 'vercel.json' });
  assert.equal(by['vercel-api-cron-digest'].calls, 'GET /api/cron/digest');
  // crontab: the command, its program as the title, CRON_TZ for the lines below it, @daily kept, @reboot left out, a cron.d user dropped
  assert.deepEqual(by['cron-holer-sh'], { id: 'cron-holer-sh', title: 'holer.sh', cron: '*/5 * * * *', tz: 'Europe/Berlin', calls: '/opt/tools/holer.sh >> /var/log/holer.log 2>&1', kind: 'crontab', source: 'crontab', trigger: 'crontab' });
  assert.equal(by['cron-backup-js'].cron, '@daily');
  assert.equal(by['cron-backup-js'].title, 'backup.js', 'past "cd … &&" and the interpreter');
  assert.equal(by['cron-report-py'].cron, '0 7 * * mon');
  assert.ok(!Object.values(by).some((s) => /start\.sh/.test(s.calls || '')), '@reboot is not a time');
  assert.deepEqual(by['cron-prune-logs'], { id: 'cron-prune-logs', title: 'prune-logs', cron: '15 4 * * *', calls: '/usr/sbin/prune-logs --days 30', kind: 'crontab', source: 'etc/cron.d/prune', trigger: 'etc/cron.d/prune' });
  // ofelia: map and list labels, @every as cron where it fits and as an interval where it doesn't, 6 fields to 5, the service in the title
  assert.deepEqual(by['ofelia-backup'], { id: 'ofelia-backup', title: 'Backup (db)', cron: '0 * * * *', calls: 'pg_dump -U app app > /backups/app.sql', kind: 'ofelia', source: 'docker-compose.yml', trigger: 'docker-compose.yml' });
  assert.equal(by['ofelia-prune'].cron, '30 4 * * *');
  assert.equal(by['ofelia-prune'].calls, 'rm -rf /var/cache/nginx/*');
  assert.deepEqual(by['ofelia-ping'].interval, { every: 90, unit: 'minutes' });
  assert.equal(by['ofelia-ping'].cron, undefined);
  // n8n: the workflow's name, the rule as cron, the time zone setting, the HTTP Request node as the call, a disabled node switched off
  assert.deepEqual(by['n8n-weekly-digest'], { id: 'n8n-weekly-digest', title: 'Weekly digest', cron: '0 18 * * 0', tz: 'Europe/Berlin', calls: 'POST /api/digest', kind: 'n8n', source: 'n8n/weekly-digest.json', trigger: 'n8n/weekly-digest.json' });
  assert.equal(by['n8n-sync-orders'].cron, '*/15 * * * *');
  assert.equal(by['n8n-sync-orders'].calls, 'GET /api/orders', 'the path of a full URL, without its query');
  assert.equal(by['n8n-sync-orders-2'].cron, '15 7 * * *', 'the older Cron node');
  assert.equal(by['n8n-sync-orders-2'].enabled, false);
  assert.match(output, /SCHEDULES {2}15 found \(override by id in floorplan\/schedules\.json/);
  assert.match(output, /^ {2}actions-report {15}30 2 \* \* \* {7}github-actions \.github\/workflows\/report\.yml$/m);
  assert.match(output, /^ {2}n8n-sync-orders-2 .*\(off\)$/m);
});

test('an n8n rule cron cannot say exactly becomes an interval, and a seconds trigger too', () => {
  const r = shopApp();
  try {
    writeJson(path.join(r, 'n8n', 'odd.json'), { name: 'Odd', nodes: [
      { type: 'n8n-nodes-base.scheduleTrigger', parameters: { rule: { interval: [{ field: 'days', daysInterval: 2, triggerAtHour: 2, triggerAtMinute: 30 }, { field: 'seconds', secondsInterval: 30 }, { field: 'hours', hoursInterval: 3, triggerAtMinute: 15 }] } } },
    ] });
    writeJson(path.join(r, 'n8n', 'plain.json'), { name: 'No trigger', nodes: [{ type: 'n8n-nodes-base.httpRequest', parameters: { url: '/x' } }] });
    run('scan.mjs', r);
    const found = readJson(path.join(r, 'floorplan', '.cache', 'scan.json')).schedules;
    assert.deepEqual(found.map((s) => [s.id, s.cron, s.interval]), [['n8n-odd', undefined, { every: 2, unit: 'days', at: '02:30' }], ['n8n-odd-2', undefined, { every: 30, unit: 'seconds' }], ['n8n-odd-3', '15 */3 * * *', undefined]]);
  } finally { cleanup(r); }
});

// ---------- the build ----------

test('the build merges the finds with schedules.json: an override by id changes only its fields, a plan of its own is added, a find is switched off', () => {
  assert.equal(graph.schedules.length, 17);
  const report = plan(graph, 'actions-report');
  assert.equal(report.title, 'Nightly report', 'kept from the find');
  assert.equal(report.cron, '30 2 * * *');
  assert.equal(report.tz, 'UTC');
  assert.equal(report.human, 'daily at 02:30');
  assert.deepEqual(report.runs, ['n:api'], 'added by the owner');
  assert.equal(report.note, 'Builds the PDF and mails it.');
  assert.equal(report.trigger, '.github/workflows/report.yml', 'a workflow is config, not on this map: the trigger stays its path');
  assert.equal(report.kind, 'github-actions');
  assert.equal(report.found, true);
  assert.deepEqual(report.times, [150]);
  const own = plan(graph, 'nightly-cleanup');
  assert.equal(own.title, 'Nightly cleanup');
  assert.equal(own.trigger, 'f:shop-api/server.js', 'a file on the map is a card');
  assert.deepEqual(own.runs, [`r:${graph.routes.findIndex((x) => x.m === 'POST' && x.p === '/api/orders/:id/refund')}`, 'n:web'], '"METHOD /path" is an endpoint, a glob over a whole part is the part');
  assert.equal(own.calls, 'node cleanup.js');
  assert.equal(own.source, 'README § Schedules');
  assert.equal(own.kind, null);
  assert.equal(own.found, false);
  const off = plan(graph, 'vercel-api-cron-digest');
  assert.equal(off.enabled, false);
  assert.equal(off.human, 'monthly on the 1st at 07:00');
  assert.deepEqual(off.times, [], 'a plan switched off has no marks on the strip');
  const hand = plan(graph, 'by-hand');
  assert.equal(hand.cron, null);
  assert.equal(hand.human, 'whenever the owner remembers');
  assert.deepEqual(hand.times, []);
  // a call that names an endpoint on the map counts as a run
  const sync = plan(graph, 'n8n-sync-orders');
  assert.deepEqual(sync.runs, [`r:${graph.routes.findIndex((x) => x.m === 'GET' && x.p === '/api/orders')}`]);
  // an interval in words, with its series
  assert.equal(plan(graph, 'ofelia-ping').human, 'every 90 minutes');
  assert.equal(plan(graph, 'ofelia-ping').times.length, 16);
  assert.match(output, /SCHEDULES {2}17 \(15 found, 2 declared\) · 2 off · next: \d\d:\d\d/);
  assert.doesNotMatch(output, /warning\(s\)/);
});

test('an event edge runs from the trigger to what it runs, labelled with the cron, only when both are on the map', () => {
  const events = graph.links.filter((l) => l.k === 'event');
  assert.deepEqual(events.map((l) => [l.a, l.b, l.labels]), [
    ['f:shop-api/server.js', `r:${graph.routes.findIndex((x) => x.p === '/api/orders/:id/refund')}`, ['cron 30 2 * * *']],
    ['f:shop-api/server.js', 'n:web', ['cron 30 2 * * *']],
  ], 'the finds whose trigger is a workflow or a crontab draw nothing; the switched-off plan draws nothing');
  assert.match(output, /LINKS {2}\d+ \(.*event 2/);
});

test('with "config" included, a workflow is on the map and its plan draws the edge from the workflow file', () => {
  const r = shopWithSchedules();
  try {
    const archFile = path.join(r, 'floorplan', 'architecture.json');
    const arch = readJson(archFile);
    arch.include = ['code', 'config'];
    arch.nodes.push({ id: 'ci', label: 'CI', kind: 'infra', summary: 'The pipeline.', paths: ['.github/**'] });
    writeJson(archFile, arch);
    writeJson(schedulesFile(r), [{ id: 'actions-report', runs: ['api'] }]);
    scanAndBuild(r);
    const g = readGraph(r);
    assert.equal(plan(g, 'actions-report').trigger, 'f:.github/workflows/report.yml');
    assert.deepEqual(g.links.filter((l) => l.k === 'event').map((l) => [l.a, l.b]), [['f:.github/workflows/report.yml', 'n:api']]);
  } finally { cleanup(r); }
});

test('mistakes in schedules.json are errors that name the field and suggest the likely value; a bad cron or time zone is a warning', () => {
  const r = shopWithSchedules();
  try {
    run('scan.mjs', r);
    writeJson(schedulesFile(r), { schedules: [
      { id: 'actions-report', run: ['api'] },
      { id: 'nightly', title: 'Nightly', cron: '30 2 * * *', trigger: 'shop-api/servr.js', runs: ['apii', 'POST /api/orders/:id/refunds', 'shop-web/src/nothing.js'] },
      { id: 'nightly', title: 'Twice', cron: '0 0 * * *' },
      { id: 'no when', title: 'No when' },
      { title: 'No id', cron: '0 0 * * *' },
      { id: 'bad-cron', title: 'Bad cron', cron: '0 0 * *', tz: 'Mars/Olympus', enabled: 'yes' },
      'not an object',
    ] });
    const out = buildOut(r);
    assert.match(out, /error\(s\) in floorplan\/architecture\.json or schedules\.json/);
    assert.match(out, /schedules\.json schedules\[0\] \("actions-report"\): unknown field "run" — did you mean "runs"\?/);
    assert.match(out, /schedules\.json schedules\[1\] \("nightly"\)\.trigger "shop-api\/servr\.js" is neither a part id, a scanned file nor "METHOD \/path" — did you mean "shop-api\/server\.js"\?/);
    assert.match(out, /schedules\.json schedules\[1\] \("nightly"\)\.runs\[0\] "apii" is neither a part id, a path or glob that matches a file on the map, "METHOD \/path" nor a target id — did you mean "api"\?/);
    assert.match(out, /schedules\.json schedules\[1\] \("nightly"\)\.runs\[1\] "POST \/api\/orders\/:id\/refunds" is neither .* — did you mean "POST \/api\/orders\/:id\/refund"\?/);
    assert.match(out, /schedules\.json schedules\[1\] \("nightly"\)\.runs\[2\] "shop-web\/src\/nothing\.js" is neither .* — did you mean "shop-web\/src\/api\.js"\?/);
    assert.match(out, /schedules\.json schedules\[2\] \("nightly"\)\.id duplicates an earlier schedule/);
    assert.match(out, /schedules\.json schedules\[3\] \("no when"\)\.id may only use letters, digits, "_", "-" and "\."/);
    assert.match(out, /schedules\.json schedules\[3\] \("no when"\) needs "cron" \(five fields, like "30 2 \* \* \*"\) or "human" \(the schedule in words\)/);
    assert.match(out, /schedules\.json schedules\[4\]\.id is required/);
    assert.match(out, /schedules\.json schedules\[5\] \("bad-cron"\)\.enabled must be true or false/);
    assert.match(out, /schedules\.json \("bad-cron"\): cron "0 0 \* \*" is not a five-field cron expression \(minute hour day month weekday\); shown as written/);
    assert.match(out, /schedules\.json schedules\[5\] \("bad-cron"\)\.tz "Mars\/Olympus" is not a time zone this Node knows; shown as written/);
    assert.match(out, /schedules\.json schedules\[6\] must be an object/);
    assert.ok(!fs.existsSync(path.join(r, 'floorplan', 'index.html')), 'nothing was written');
    fs.writeFileSync(schedulesFile(r), '{');
    assert.match(buildOut(r), /schedules\.json is not valid JSON/);
    writeJson(schedulesFile(r), { schedule: [] });
    assert.match(buildOut(r), /schedules\.json must be a list of schedules, or \{ "schedules": \[ … \] \}/);
    // a warning alone doesn't stop the build: the raw expression is shown as its words
    writeJson(schedulesFile(r), [{ id: 'bad-cron', title: 'Bad cron', cron: '0 0 * *' }]);
    const ok = build(r);
    assert.match(ok, /cron "0 0 \* \*" is not a five-field cron expression/);
    const bad = plan(readGraph(r), 'bad-cron');
    assert.equal(bad.human, '0 0 * *');
    assert.deepEqual(bad.times, []);
    // a find the scan can't read as five fields is a warning that names its file
    fs.writeFileSync(path.join(r, '.github', 'workflows', 'odd.yml'), 'name: Odd\non:\n  schedule:\n    - cron: "every day"\n');
    run('scan.mjs', r);
    assert.match(build(r), /\.github\/workflows\/odd\.yml \("actions-odd"\): cron "every day" is not a five-field cron expression/);
    assert.equal(plan(readGraph(r), 'actions-odd').human, 'every day');
  } finally { cleanup(r); }
});

test('after a refresh, a run whose file moved is an error that names where it went', () => {
  const r = shopApp();
  try {
    writeJson(schedulesFile(r), [{ id: 'calls', title: 'Calls', cron: '0 1 * * *', runs: ['shop-web/src/api.js'] }]);
    scanAndBuild(r);
    fs.renameSync(path.join(r, 'shop-web/src/api.js'), path.join(r, 'shop-web/src/client.js'));
    const out = run('refresh.mjs', r);
    assert.match(out, /schedules\.json schedules\[0\] \("calls"\)\.runs\[0\] "shop-web\/src\/api\.js" is neither .* — did you mean "shop-web\/src\/client\.js"\? \(it moved there\)/);
    assert.deepEqual(readJson(schedulesFile(r))[0].runs, ['shop-web/src/api.js'], 'the refresh leaves schedules.json as it was');
  } finally { cleanup(r); }
});

// ---------- cron in words, and the start minutes of a day ----------

test('the usual cron forms read as words in English and German; a rarer one shows as written', () => {
  const en = words('en'), de = words('de');
  const say = (expr, lang) => cronWords(parseCron(expr), lang === 'de' ? de : en, lang);
  const cases = [
    ['* * * * *', 'every minute', 'jede Minute'],
    ['*/20 * * * *', 'every 20 minutes', 'alle 20 Minuten'],
    ['30 * * * *', 'hourly at :30', 'stündlich um :30'],
    ['0 */6 * * *', 'every 6 hours at :00', 'alle 6 Stunden um :00'],
    ['30 2 * * *', 'daily at 02:30', 'täglich um 02:30'],
    ['0 6,18 * * *', 'daily at 06:00, 18:00', 'täglich um 06:00, 18:00'],
    ['@daily', 'daily at 00:00', 'täglich um 00:00'],
    ['0 8 * * 1-5', 'weekdays at 08:00', 'werktags um 08:00'],
    ['0 10 * * 0,6', 'weekends at 10:00', 'am Wochenende um 10:00'],
    ['0 3 * * 0', 'every Sunday at 03:00', 'jeden Sonntag um 03:00'],
    ['0 3 * * 7', 'every Sunday at 03:00', 'jeden Sonntag um 03:00'],
    ['0 7 * * mon,wed', 'every Monday, Wednesday at 07:00', 'jeden Montag, Mittwoch um 07:00'],
    ['0 6 1 * *', 'monthly on the 1st at 06:00', 'monatlich am 1. um 06:00'],
    ['0 6 2 * *', 'monthly on the 2nd at 06:00', 'monatlich am 2. um 06:00'],
    ['0 6 23 * *', 'monthly on the 23rd at 06:00', 'monatlich am 23. um 06:00'],
    ['0 6 11 * *', 'monthly on the 11th at 06:00', 'monatlich am 11. um 06:00'],
  ];
  for (const [expr, e, d] of cases) { assert.equal(say(expr, 'en'), e, expr); assert.equal(say(expr, 'de'), d, expr); }
  for (const expr of ['0 6 1 1 *', '0 9-17 * * *', '0 6 1 * 1', '15,45 * * * *']) assert.equal(say(expr, 'en'), null, `${expr} has no words of its own`);
  for (const expr of ['0 0 * *', '60 * * * *', '* * * * * *', '0 25 * * *', 'daily', '0 0 32 * *', '0 0 * 13 *', '0 0 * * foo', '']) assert.equal(parseCron(expr), null, `${expr} is not a cron expression`);
  assert.equal(parseCron('0 0 * * sunday').fields[4].size, 1, 'full day names too');
  assert.equal(parseCron(' 0  0 * * * ').expr, '0  0 * * *');
  // intervals the scan writes for what cron can't say
  assert.equal(intervalWords({ every: 2, unit: 'days', at: '02:30' }, en), 'every 2 days at 02:30');
  assert.equal(intervalWords({ every: 2, unit: 'days', at: '02:30' }, de), 'alle 2 Tage um 02:30');
  assert.equal(intervalWords({ every: 30, unit: 'seconds' }, en), 'every 30 seconds');
  assert.equal(intervalWords({ every: 90, unit: 'minutes' }, de), 'alle 90 Minuten');
  assert.equal(intervalWords({ every: 3, unit: 'weeks', at: '08:00' }, en), 'every 3 weeks at 08:00');
  assert.equal(intervalWords({ every: 2, unit: 'months', at: '08:00' }, de), 'alle 2 Monate um 08:00');
  assert.equal(intervalWords({ every: 0, unit: 'days' }, en), null);
});

test('the start minutes of one day: the series for a plan that runs any day, none for a weekly or monthly one', () => {
  const times = (expr) => cronTimes(parseCron(expr));
  assert.equal(times('*/20 * * * *').length, 72);
  assert.deepEqual(times('*/20 * * * *').slice(0, 4), [0, 20, 40, 60]);
  assert.deepEqual(times('30 2 * * *'), [150]);
  assert.deepEqual(times('0 6,18 * * *'), [360, 1080]);
  assert.equal(times('* * * * *').length, 1440);
  assert.deepEqual(times('0 8 * * 1-5'), [480], 'weekdays count as any day');
  assert.deepEqual(times('0 3 * * 0'), [], 'weekly');
  assert.deepEqual(times('0 6 1 * *'), [], 'monthly');
  assert.deepEqual(times('0 6 1 1 *'), [], 'yearly');
  assert.deepEqual(times('0 0 * *'), [], 'not a cron expression');
  assert.equal(intervalTimes({ every: 90, unit: 'minutes' }).length, 16);
  assert.equal(intervalTimes({ every: 30, unit: 'seconds' }).length, 1440);
  assert.deepEqual(intervalTimes({ every: 3, unit: 'hours', at: '00:15' }), [15, 195, 375, 555, 735, 915, 1095, 1275]);
  assert.deepEqual(intervalTimes({ every: 2, unit: 'days', at: '02:30' }), [150]);
  assert.deepEqual(intervalTimes({ every: 2, unit: 'weeks', at: '02:30' }), []);
});

// ---------- MAP.md ----------

test('MAP.md has a Schedules section with its marker after Rules: one line per plan, the switched-off ones last', () => {
  const md = mapOf(root);
  const markers = md.split('\n').filter((l) => /^<!-- floorplan:\w+ -->$/.test(l));
  assert.deepEqual(markers, ['parts', 'targets', 'rules', 'schedules', 'flows', 'health', 'recent'].map((s) => `<!-- floorplan:${s} -->`));
  const sec = section(md);
  assert.match(sec, /^<!-- floorplan:schedules -->\n## Schedules\n/);
  const lines = sec.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 17);
  assert.ok(lines.includes('- Nightly report (`actions-report`) · `30 2 * * *` · daily at 02:30, time zone UTC · Trigger: `.github/workflows/report.yml` · Runs: Server (`api`) · Note: Builds the PDF and mails it.'), lines.join('\n'));
  assert.ok(lines.includes('- Nightly cleanup (`nightly-cleanup`) · `30 2 * * *` · daily at 02:30, time zone Europe/Berlin · Trigger: `shop-api/server.js` · Runs: `POST /api/orders/:id/refund`, Website (`web`) · Calls: `node cleanup.js` · Source: README § Schedules'));
  assert.ok(lines.includes('- holer.sh (`cron-holer-sh`) · `*/5 * * * *` · every 5 minutes, time zone Europe/Berlin · Trigger: `crontab` · Calls: `/opt/tools/holer.sh >> /var/log/holer.log 2>&1`'));
  assert.ok(lines.includes('- Ping (web) (`ofelia-ping`) · every 90 minutes · Trigger: `docker-compose.yml` · Calls: `curl -s http://localhost/health`'));
  assert.ok(lines.includes('- Hand-run report (`by-hand`) · whenever the owner remembers · Source: README § Schedules'));
  assert.ok(lines.at(-1).endsWith(' · off') && lines.at(-2).endsWith(' · off'), 'the two switched-off plans come last');
  assert.match(lines.at(-1), /^- Digest \(`vercel-api-cron-digest`\) · `0 7 1 \* \*` · monthly on the 1st at 07:00, time zone UTC · Trigger: `vercel\.json` · Calls: `GET \/api\/cron\/digest` · off$/);
  assert.match(md, /^Inputs in floorplan\/: architecture\.json, schedules\.json$/m);
  build(root, '--lang', 'de');
  try {
    const de = section(mapOf(root));
    assert.match(de, /^## Zeitpläne$/m);
    assert.ok(de.includes('- Nächtliches Aufräumen (`nightly-cleanup`) · `30 2 * * *` · täglich um 02:30, Zeitzone Europe/Berlin · Auslöser: `shop-api/server.js` · Läuft: `POST /api/orders/:id/refund`, Website (`web`) · Aufruf: `node cleanup.js` · Quelle: README § Schedules'), de);
    assert.match(de, /monatlich am 1\. um 07:00, Zeitzone UTC .* · ausgeschaltet$/m);
  } finally { build(root); }
});

// ---------- the Clock panel, run against a stand-in map ----------

const table = (lang) => ({ ...readJson(path.join(SKILL, 'assets', 'lang', 'en.json')), ...(lang === 'en' ? {} : readJson(path.join(SKILL, 'assets', 'lang', `${lang}.json`))) });
/** A stand-in for window.Floorplan, enough for ui/28-clock.js to run against a built graph, with the clock stopped at `now`. */
function standIn(g, lang = 'en', { now = '2026-11-01T05:04:00Z', store = {} } = {}) {
  const w = table(lang);
  const t = (k, vars) => (w[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => (vars && x in vars ? String(vars[x]) : m));
  const tn = (k, n, vars) => t(w[`${k}.${n === 1 ? 'one' : 'other'}`] ? `${k}.${n === 1 ? 'one' : 'other'}` : `${k}.other`, { n, ...vars });
  const el = () => {
    // querySelector finds a child by one class, enough for an extension to take its own mark off a card again
    const e = { children: [], style: { props: {}, setProperty(k, v) { e.style.props[k] = v; }, getPropertyValue: () => '' }, attrs: {}, classList: new Set(), appendChild: (c) => { e.children.push(c); c.remove = () => e.children.splice(e.children.indexOf(c), 1); return c; }, remove() {}, setAttribute: (k, v) => { e.attrs[k] = v; }, querySelector: (sel) => e.children.find((c) => sel.startsWith('.') && String(c.attrs.class || '').split(' ').includes(sel.slice(1))) || null, querySelectorAll: () => [], addEventListener() {} };
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
  const exists = (id) => id.startsWith('n:') ? nodes.has(id.slice(2)) : id.startsWith('r:') ? !!routes[+id.slice(2)] : id.startsWith('f:') && files.has(id.slice(2));
  const chain = (id) => {
    const out = [id];
    let n = id.startsWith('f:') ? files.get(id.slice(2))?.n : id.startsWith('r:') ? (out.push('f:' + routes[+id.slice(2)].f), files.get(routes[+id.slice(2)].f)?.n) : nodes.get(id.slice(2))?.parent;
    while (n) { out.push('n:' + n); n = nodes.get(n)?.parent; }
    return [...out, 'root'];
  };
  const out = { buttons: [], sections: { overview: [], item: [] }, tips: [], listeners: {}, panels: [], boards: [], refreshed: 0, closed: 0 };
  const chipEls = new Map();
  const SC = {
    graph: g, lang, t, tn, h: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), exported: null,
    info, nodes, files, routes, exists, chain, colorOf: () => 'var(--n-file)',
    icon: () => '<svg></svg>', iconI: () => '<svg></svg>', icons: {}, state: { chipEls, edgeEls: new Map(), layout: { children: [] }, selected: null, container: 'root' },
    store: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } },
    addHeaderButton: (b) => { const e = el(); out.buttons.push({ ...b, el: e }); return e; },
    addPanelSection: (where, fn) => out.sections[where].push(fn),
    addTipSection: (fn) => out.tips.push(fn),
    showPanel: (html) => out.panels.push(html), closePanel: () => out.closed++, refreshPanel: () => out.refreshed++, showBoard: (b) => out.boards.push(b), on: (ev, fn) => (out.listeners[ev] ||= []).push(fn),
  };
  const document = { createElement: () => el(), createElementNS: () => el(), head: el(), querySelector: () => null, querySelectorAll: () => [] };
  const window = { Floorplan: SC };
  // the clock stands still, so the list's order and the next start are the same on every run
  const fixed = Date.parse(now);
  const FixedDate = class extends Date { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } };
  vm.runInNewContext(fs.readFileSync(path.join(SKILL, 'assets', 'ui', '28-clock.js'), 'utf8'), { window, document, Date: FixedDate });
  return { ...out, out, SC, el, chipEls, store, api: window.FloorplanClock };
}

test('the Clock button carries the count; switched on, the panel opens with the strip and the list, next start first, the switched-off plans dimmed at the end', () => {
  const p = standIn(graph);
  assert.equal(p.buttons.length, 1);
  assert.equal(p.buttons[0].label, 'Clock');
  assert.match(p.buttons[0].title, /17 schedules/);
  assert.equal(p.buttons[0].el.children[0].textContent, '15', 'the badge counts the plans in force');
  assert.equal(p.panels.length, 0, 'nothing opens on its own');
  p.buttons[0].onClick();
  assert.equal(p.store.clock, true);
  const html = p.panels.at(-1);
  for (const s of ['17 schedules', '15 found in the code · 2 from schedules.json', 'class="cl-strip"', 'data-cl-back', 'One day, 0 to 24 h']) assert.ok(html.includes(s), `"${s}" is in the panel`);
  // the strip: a line per start, a band for a plan that fills the day, nothing for the weekly, monthly and switched-off ones
  assert.equal((html.match(/<rect class="cl-band" data-cl="cron-holer-sh"/g) || []).length, 1, '288 starts a day are a band, not 288 lines');
  assert.equal((html.match(/<line class="cl-start" data-cl="n8n-sync-orders"/g) || []).length, 96);
  assert.equal((html.match(/<line class="cl-start" data-cl="actions-report"/g) || []).length, 1);
  assert.match(html, /<line class="cl-start" data-cl="actions-report" x1="150" x2="150"/);
  for (const id of ['n8n-weekly-digest', 'cron-report-py', 'by-hand', 'vercel-api-cron-digest', 'n8n-sync-orders-2']) assert.doesNotMatch(html, new RegExp(`data-cl="${id}" x1=`), id);
  // the list at 05:04 UTC (06:04 in Berlin), each plan on its own clock: the five-minute plan is next, 06:00 UTC comes before
  // 02:30 UTC tomorrow, the weekly ones follow the daily ones, the switched-off ones close (the plans without a time zone
  // read this computer's clock, so only the others are compared)
  const order = [...html.matchAll(/data-cl-open="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(order[0], 'cron-holer-sh', 'one minute to its next start');
  assert.ok(order.indexOf('actions-ci') < order.indexOf('actions-report'));
  assert.ok(order.indexOf('actions-report') < order.indexOf('n8n-weekly-digest'), 'a plan without a daily time comes after the ones with one');
  assert.deepEqual(order.slice(-2).sort(), ['n8n-sync-orders-2', 'vercel-api-cron-digest']);
  assert.match(html, /class="row cl-row cl-off" data-cl-open="vercel-api-cron-digest"/, 'dimmed');
  assert.match(html, /holer\.sh<\/div><div class="rd">every 5 minutes · time zone Europe\/Berlin · crontab<\/div><div class="rp">crontab<\/div><\/span><span class="rc">06:05<\/span>/);
  assert.match(html, /Nightly cleanup<\/div><div class="rd">daily at 02:30 · time zone Europe\/Berlin · listed in schedules\.json<\/div><div class="rp">Shop API server → Router → Website<\/div>/);
  assert.match(html, /Nightly report<\/div><div class="rd">daily at 02:30 · time zone UTC · GitHub Actions workflow<\/div><div class="rp">\.github\/workflows\/report\.yml → Server<\/div><\/span><span class="rc">02:30<\/span>/);
  assert.match(html, /Digest<\/div>.*<span class="rc">off<\/span>/);
  // switched off again: the panel closes
  p.buttons[0].onClick();
  assert.equal(p.store.clock, false);
  assert.equal(p.out.closed, 0, 'nothing to close when the stand-in shows no panel');
  assert.equal(p.out.refreshed, 1, 'the codebase panel is drawn again without the marks');
});

test('opening a plan puts its trigger and what it runs on a board, and shows its details with the places as links', () => {
  const p = standIn(graph);
  p.api.show(plan(graph, 'nightly-cleanup'));
  const board = p.boards.at(-1);
  assert.equal(board.title, 'Nightly cleanup');
  assert.equal(board.kind, 'Schedule');
  assert.equal(board.question, 'daily at 02:30 · time zone Europe/Berlin');
  const refund = `r:${graph.routes.findIndex((x) => x.p === '/api/orders/:id/refund')}`;
  assert.deepEqual(ids(board.items), ['f:shop-api/server.js', refund, 'n:web']);
  assert.equal(board.items[0].note, 'Trigger of “Nightly cleanup”');
  assert.equal(board.items[2].note, 'Started by “Nightly cleanup”');
  const html = p.panels.at(-1);
  for (const s of ['Nightly cleanup', 'daily at 02:30 · time zone Europe/Berlin', 'Cron:', '30 2 * * *', 'Calls:', 'node cleanup.js', 'listed in schedules.json', 'Source:', 'README § Schedules', 'data-go="f:shop-api/server.js"', `data-go="${refund}"`, 'data-go="n:web"', 'data-cl-list']) assert.ok(html.includes(s), `"${s}" is in the plan's panel`);
  // a find whose trigger isn't on the map: the path is named but leads nowhere; the one part it runs makes the board
  p.api.show(plan(graph, 'actions-report'));
  assert.deepEqual(ids(p.boards.at(-1).items), ['n:api']);
  assert.match(p.panels.at(-1), /GitHub Actions workflow · Found in \.github\/workflows\/report\.yml/);
  assert.match(p.panels.at(-1), /Builds the PDF and mails it\./);
  assert.match(p.panels.at(-1), /<div class="rn">\.github\/workflows\/report\.yml<\/div>/);
  // a plan with nothing on the map has no board, only its words
  p.api.show(plan(graph, 'by-hand'));
  assert.equal(p.boards.length, 2);
  assert.match(p.panels.at(-1), /whenever the owner remembers/);
  assert.match(p.panels.at(-1), /Nothing of it is on the map yet/);
  // a switched-off plan says so
  p.api.show(plan(graph, 'vercel-api-cron-digest'));
  assert.match(p.panels.at(-1), /Schedule · off/);
  assert.match(p.panels.at(-1), /Switched off in schedules\.json/);
});

test('switched on, the cards a plan touches and the parts holding them get a mark, with the plans on hover; a card\'s details list "Schedules here"', () => {
  const p = standIn(graph, 'en', { store: { clock: true } });
  const refund = `r:${graph.routes.findIndex((x) => x.p === '/api/orders/:id/refund')}`;
  for (const id of ['n:api', 'n:web', 'f:shop-api/server.js', refund, 'f:shop-api/routes/orders.js', 'f:shop-web/src/api.js', 'x:in:n:api']) p.chipEls.set(id, p.el());
  for (const fn of p.listeners.render) fn({ container: 'root' });
  const marked = (id) => p.chipEls.get(id).children.map((c) => c.attrs.class);
  assert.deepEqual(marked('f:shop-api/server.js'), ['cl-mark'], 'the trigger');
  assert.deepEqual(marked('n:web'), ['cl-mark'], 'a part it runs');
  assert.deepEqual(marked(refund), ['cl-mark'], 'an endpoint it runs');
  assert.deepEqual(marked('n:api'), ['cl-mark'], 'the Nightly report runs the server, and the server holds the trigger');
  assert.deepEqual(marked('f:shop-api/routes/orders.js'), ['cl-mark cl-inside'], 'the file holding the endpoint');
  assert.deepEqual(marked('f:shop-web/src/api.js'), [], 'a file inside a part a plan runs is not marked itself');
  assert.deepEqual(marked('x:in:n:api'), [], 'never on a connector');
  const tip = (id) => p.tips.map((fn) => fn(id)).join('');
  assert.match(tip('f:shop-api/server.js'), /Trigger of “Nightly cleanup”.*daily at 02:30 · time zone Europe\/Berlin/);
  assert.match(tip('n:web'), /Started by “Nightly cleanup”/);
  assert.match(tip('n:api'), /Started by “Nightly report”/);
  assert.match(tip('n:api'), /2 schedules inside<\/div><div class="cl-tn">Sync orders, Nightly cleanup/, 'the plans inside, besides its own');
  assert.match(tip('f:shop-api/routes/orders.js'), /2 schedules inside<\/div><div class="cl-tn">Sync orders, Nightly cleanup/, 'both endpoints of the file are run by a plan');
  assert.equal(tip('f:shop-web/src/App.jsx'), '');
  const here = (id) => { const r = p.sections.item[0](id); return r ? [...r.html.matchAll(/data-cl-open="([^"]+)"/g)].map((m) => m[1]) : []; };
  assert.deepEqual(here('f:shop-api/server.js'), ['nightly-cleanup']);
  assert.deepEqual(here('n:api'), ['actions-report', 'n8n-sync-orders', 'nightly-cleanup']);
  assert.deepEqual(here('f:shop-web/src/App.jsx'), []);
  assert.match(p.sections.item[0]('n:web').html, /Schedules here/);
  assert.match(p.sections.item[0]('n:web').html, /All schedules/);
  // the codebase panel: a way in, with the next start; switched off, a hint
  const ov = p.sections.overview[0]();
  assert.match(ov.html, /data-cl-all/);
  assert.match(ov.html, /17 schedules/);
  assert.match(ov.html, /Next: 06:05 · holer\.sh/);
  assert.doesNotMatch(ov.html, /Switch on/);
  p.api.set(false);
  for (const fn of p.listeners.render) fn({ container: 'root' });
  assert.deepEqual(marked('n:web'), [], 'the marks go when the clock is switched off');
  assert.match(p.sections.overview[0]().html, /Switch on <b>Clock<\/b>/);
});

test('in German the panel says Uhr, Zeitpläne, Auslöser, Läuft, Aufruf, Zeitzone, ausgeschaltet and Zeitpläne hier', () => {
  build(root, '--lang', 'de');
  try {
    const g = readGraph(root);
    const p = standIn(g, 'de', { store: { clock: true } });
    assert.equal(p.buttons[0].label, 'Uhr');
    p.buttons[0].onClick();
    assert.equal(p.store.clock, false, 'the button is a switch');
    p.buttons[0].onClick();
    const html = p.panels.at(-1);
    for (const s of ['17 Zeitpläne', '15 im Code gefunden · 2 aus schedules.json', 'Ein Tag, 0 bis 24 Uhr', 'alle 5 Minuten · Zeitzone Europe/Berlin · crontab', 'Nächtliches Aufräumen', 'täglich um 02:30 · Zeitzone Europe/Berlin · aus schedules.json', 'jeden Sonntag um 18:00', 'monatlich am 1. um 07:00', '<span class="rc">ausgeschaltet</span>']) assert.ok(html.includes(s), `"${s}" is in the German panel`);
    p.api.show(plan(g, 'nightly-cleanup'));
    const detail = p.panels.at(-1);
    for (const s of ['Zeitplan', 'Aufruf:', 'Quelle:', 'Auslöser', 'Läuft']) assert.ok(detail.includes(s), `"${s}" is in the German detail`);
    assert.equal(p.boards.at(-1).items[0].note, 'Löst aus: „Nächtliches Aufräumen“');
    assert.match(p.sections.item[0]('n:web').html, /Zeitpläne hier/);
  } finally { build(root); }
});

test('the built page carries the panel, and every word of it is in both language tables', () => {
  const page = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.ok(page.includes('/* ui/28-clock.js */'));
  assert.ok(page.includes("id: 'btn-clock'"));
  for (const code of ['en', 'de']) {
    const tbl = readJson(path.join(SKILL, 'assets', 'lang', `${code}.json`));
    for (const k of ['clock.button', 'clock.title', 'clock.schedules', 'clock.intro', 'clock.strip', 'clock.trigger', 'clock.runs', 'clock.calls', 'clock.off', 'clock.here', 'cron.everyMinutes', 'cron.daily', 'cron.weekdays', 'cron.weekly', 'cron.monthly', 'cron.day.0', 'cron.ordinal.other']) assert.ok(tbl[k], `${code}.json ${k}`);
  }
});

test('without a find and without schedules.json the build is unchanged: no graph.schedules, "SCHEDULES  none", a section that says None, nothing on the map', () => {
  const r = shopApp();
  try {
    const out = scanAndBuild(r);
    const g = readGraph(r);
    assert.equal(g.schedules, undefined);
    assert.deepEqual(readJson(path.join(r, 'floorplan', '.cache', 'scan.json')).schedules, []);
    assert.doesNotMatch(out, /SCHEDULES {2}\d/);
    assert.match(out, /SCHEDULES {2}none \(nothing found in the code, no schedules\.json\)/);
    assert.equal(g.links.filter((l) => l.k === 'event').length, 0);
    assert.match(section(mapOf(r)), /^<!-- floorplan:schedules -->\n## Schedules\n\nNone\.\n\n$/);
    const strip = (x) => JSON.stringify({ ...x, meta: { ...x.meta, generatedAt: null } });
    writeJson(schedulesFile(r), { schedules: [] });
    assert.match(build(r), /SCHEDULES {2}none \(nothing in schedules\.json, nothing found in the code\)/);
    assert.equal(strip(readGraph(r)), strip(g), 'an empty list changes nothing either');
    const p = standIn(g);
    assert.equal(p.buttons.length, 0);
    assert.equal(p.sections.overview.length + p.sections.item.length + p.tips.length, 0);
  } finally { cleanup(r); }
});

// ---------- in a real browser ----------

test('in the browser the Clock opens with its strip and list, a plan lays its cards out on a board, and nothing errors', async (t) => {
  const browser = await launchBrowser();
  if (!browser) return t.skip('no Playwright with a Chromium in this environment');
  try {
    const { page, errors } = await openMap(browser, root);
    await page.click('#btn-clock');
    await page.waitForFunction(() => document.querySelectorAll('#panel .cl-strip .cl-start').length > 0 && document.querySelectorAll('#panel [data-cl-open]').length === 17);
    const list = await page.evaluate(() => document.querySelector('#panel').innerText);
    for (const s of ['17 schedules', 'holer.sh', 'every 5 minutes', 'Nightly cleanup', 'daily at 02:30', 'Weekly digest', 'every Sunday at 18:00', 'off']) assert.ok(list.includes(s), `"${s}" is in the panel`);
    const strip = await page.evaluate(() => { const r = document.querySelector('#panel .cl-strip').getBoundingClientRect(); return { width: r.width, height: r.height, bands: document.querySelectorAll('#panel .cl-band').length }; });
    assert.ok(strip.width > 200 && strip.height > 20, 'the strip is drawn');
    assert.equal(strip.bands, 1);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.cl-mark').length), 2, 'both parts carry a mark');
    await page.click('#panel [data-cl-open="nightly-cleanup"]');
    await page.waitForFunction(() => window.Floorplan.state.container === 'q:answer' && document.querySelectorAll('.node .card').length === 3);
    const board = await page.evaluate(() => ({ cards: [...document.querySelectorAll('.node .card .title')].map((e) => e.textContent).sort(), notes: document.querySelectorAll('.node .card .anote').length, events: document.querySelectorAll('.edge.k-event').length, panel: document.querySelector('#panel').innerText }));
    assert.deepEqual(board.cards, ['Router', 'Shop API server', 'Website']);
    assert.equal(board.notes, 3, 'every card carries the plan as its note');
    assert.ok(board.events >= 2, 'the clock\'s event lines are drawn');
    assert.match(board.panel, /Cron: 30 2 \* \* \*/);
    assert.match(board.panel, /Trigger/);
    await page.evaluate(() => window.Floorplan.go('root', { select: 'n:web' }));
    await page.waitForFunction(() => /Schedules here/.test(document.querySelector('#panel').innerText));
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});
