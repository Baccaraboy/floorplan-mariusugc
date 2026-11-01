// The Health findings in the map's language: every finding has a fixed id, and its title, explanation and notes come
// from the language table (health.<check>.* keys) in the language the map is built in, with the fix request staying
// English. In English a map reads exactly as before: the titles of a sample built with `en` are the ones the code
// wrote before the table had them. In German nothing English is left, MAP.md lists the German titles, and the Health
// panel shows them in a real browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILL, shopApp, run, readGraph, readJson, writeJson, launchBrowser, openMap, cleanup } from './helpers.mjs';

// made-up values, put together at run time so nothing id-like is committed
const UUID = ['0c1f7e2a', '58b4', '4d3e', '9a61', '3f5e2b7c8d90'].join('-');
const WORD = 'Wendrich';

/**
 * The sample shop (a password in its config, an endpoint anyone can use) with a one-writer target that has two
 * writers, a very large file, a retired rule still naming a part, and layers with a private word and a content
 * import in system code, so one map carries a finding of most kinds.
 */
function sample(wordsFile) {
  const root = shopApp();
  const api = path.join(root, 'shop-api'), web = path.join(root, 'shop-web');
  fs.writeFileSync(path.join(api, 'payments.js'), `// Charges the card.\nexport const charge = (order) => fetch('https://api.stripe.com/v1/charges', { method: 'POST', body: JSON.stringify(order) });\n`);
  fs.writeFileSync(path.join(web, 'src', 'prices.js'), `// The price list.\nexport const prices = () => fetch('https://api.stripe.com/v1/prices', { method: 'GET' }).then((r) => r.json());\n`);
  fs.writeFileSync(path.join(api, 'big.js'), Array.from({ length: 1200 }, (_, i) => `export const step${i} = (x) => x + ${i};`).join('\n') + '\n');
  fs.writeFileSync(path.join(api, 'notion.js'), `// Thanks to ${WORD} for the first order.\nexport const ORDERS_DB = '${UUID}';\n`);
  fs.mkdirSync(path.join(api, 'content'));
  fs.writeFileSync(path.join(api, 'content', 'customers.json'), '[]\n');
  fs.writeFileSync(path.join(api, 'import.js'), `import customers from './content/customers.json';\nexport const all = () => customers;\n`);
  const archFile = path.join(root, 'floorplan', 'architecture.json');
  const arch = readJson(archFile);
  arch.nodes.push({ id: 'stripe', label: 'Stripe', kind: 'external', summary: 'Card payments.', hosts: ['api.stripe.com'] });
  writeJson(archFile, arch);
  writeJson(path.join(root, 'floorplan', 'targets.json'), { targets: [{ id: 'payments', name: { en: 'Payments', de: 'Zahlungen' }, kind: 'api', external: 'stripe', writers: ['shop-api/payments.js', 'shop-web/src/prices.js'], readers: [], policy: 'single-writer' }] });
  writeJson(path.join(root, 'floorplan', 'rules.json'), { rules: [{ id: 'no-db-web', kind: 'rule', title: { en: 'No database access from the website', de: 'Kein Datenbankzugriff von der Website' }, text: 'The website used to query the database itself.', applies: ['web'], source: 'README', status: 'retired', until: '2026-10-25' }] });
  writeJson(path.join(root, 'floorplan', 'layers.json'), { layers: [{ id: 'content', patterns: ['shop-api/content/**'] }], default: 'system', privateWords: wordsFile });
  return root;
}
const build = (root, ...args) => run('build.mjs', root, '--no-claude-md', ...args);
const titles = (g) => g.health.issues.map((i) => i.title);
const mapHealth = (root) => { const md = fs.readFileSync(path.join(root, 'floorplan', 'MAP.md'), 'utf8'); return md.slice(md.indexOf('<!-- floorplan:health -->'), md.indexOf('<!-- floorplan:recent -->')); };

// what the code wrote before the texts moved to the table, for this sample, in this order
const BEFORE = [
  'A secret key is written into config.js',
  'Anyone could change data through Notes',
  'Two writers for a single-writer target: Payments',
  'One file is very large',
  '3 files in Server look unused',
  'A file in Website looks unused',
  'Retired rule still applied: No database access from the website',
  'System code imports a content file',
  'A name from your private word list is in system files',
  'An identifier of one installation sits in system code',
];
const ENGLISH = /\b(writer|writers|files are|file is|secret|anyone|unused|imports|retired|identifier|private word|look unused|system code)\b/i;

let wordsDir, wordsFile, root, en, de;
before(() => {
  wordsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-words-'));
  wordsFile = path.join(wordsDir, 'private-words.txt');
  fs.writeFileSync(wordsFile, `${WORD}\n`);
  root = sample(wordsFile);
  run('scan.mjs', root);
  build(root);
  en = readGraph(root);
  build(root, '--lang', 'de');
  de = readGraph(root);
});
after(() => { cleanup(root); cleanup(wordsDir); });

test('in English every finding reads exactly as it did before the texts moved to the table', () => {
  assert.deepEqual(titles(en), BEFORE);
  const byId = Object.fromEntries(en.health.issues.map((i) => [i.id, i]));
  assert.equal(byId['secret:shop-api/config.js'].detail, 'Shop API config (shop-api/config.js) contains a password. Anyone who can see the code can use it to get into the services they unlock as you. Treat it as leaked: move it out of the code and replace it with a new one.');
  assert.equal(byId['secret:shop-api/config.js'].notes['f:shop-api/config.js'], `line 1: DB_PASSWORD, a password (${'correct-horse-battery-staple-42'.length} characters)`);
  assert.equal(byId['open-endpoints:shop-api/routes/notes.js'].detail, 'notes.js has 1 endpoint that changes data (create, update or delete) with no login check, so anyone who finds the address can use it. If it is meant to be public, that\'s fine; otherwise it needs a login check.');
  assert.deepEqual(byId['open-endpoints:shop-api/routes/notes.js'].notes, { 'r:1': 'Changes data, no login check' });
  assert.equal(byId['single-writer:payments'].detail, 'floorplan/targets.json says only one part may write to Payments, but lists 2: Payments and Prices. Two writers can overwrite each other’s changes or disagree about what is true. Pick the one that owns Payments, and have the others hand their changes to it.');
  assert.equal(byId['single-writer:payments'].notes['n:stripe'], 'Payments: one writer allowed, 2 listed');
  assert.equal(byId['large-files'].notes['f:shop-api/big.js'], '1,200 lines');
  assert.match(byId['large-files'].detail, /^This file has over 1,000 lines\. AI assistants/);
  assert.equal(byId['unused:api'].notes['f:shop-api/big.js'], 'Nothing uses this file (1,200 lines)');
  assert.equal(byId['retired-rule:no-db-web'].detail, 'floorplan/rules.json retires “No database access from the website” (until 2026-10-25), but it still applies to 1 place: Website. Either the code there still follows the old rule, or the entry just wasn\'t cleaned up. Source: README.');
  assert.equal(byId['publish:layer-mixing:system'].detail, 'Import (shop-api/import.js) imports shop-api/content/customers.json from the content layer. System depends on content: the system will not run without this owner\'s content.');
  assert.equal(byId['publish:private-word:system'].notes['f:shop-api/notion.js'], 'line 1: W*******');
  assert.equal(byId['publish:hardcoded-identifier:system'].detail, 'Notion (shop-api/notion.js) holds a UUID-style id. An identifier of one installation sits in system code: anyone who installs the system would be pointed at this installation\'s database, calendar, documents or accounts. Move it to configuration, like an environment variable or a setup file in the config layer.');
  // the fix requests are English, as before, built from the same findings
  assert.match(byId['secret:shop-api/config.js'].fix, /- shop-api\/config\.js:1: DB_PASSWORD — a password/);
  assert.match(byId['publish:hardcoded-identifier:system'].fix, /- shop-api\/notion\.js:2: a UUID-style id/);
});

test('every finding has a fixed id, and the same ids come out in German', () => {
  for (const g of [en, de]) for (const i of g.health.issues) assert.match(i.id, /^[a-z-]+(:.+)?$/, i.title);
  assert.deepEqual(de.health.issues.map((i) => i.id), en.health.issues.map((i) => i.id));
  assert.deepEqual(de.health.issues.map((i) => i.kind), en.health.issues.map((i) => i.kind));
  assert.deepEqual(de.health.summary, en.health.summary);
});

test('in German the titles, explanations and notes are German, with nothing English left, and the fix stays English', () => {
  assert.deepEqual(titles(de), [
    'Ein geheimer Schlüssel steht in config.js',
    'Jeder könnte über Notes Daten ändern',
    'Zwei Schreiber für ein Ziel, das nur einen haben darf: Zahlungen',
    'Eine Datei ist sehr groß',
    '3 Dateien in Server sehen unbenutzt aus',
    'Eine Datei in Website sieht unbenutzt aus',
    'Zurückgezogene Regel gilt noch: Kein Datenbankzugriff von der Website',
    'Systemcode importiert eine Inhaltsdatei',
    'Ein Name aus deiner privaten Wortliste steht in System-Dateien',
    'Eine Kennung dieser einen Installation steht im Systemcode',
  ]);
  for (const i of de.health.issues) {
    for (const s of [i.title, i.detail, ...Object.values(i.notes || {})]) assert.doesNotMatch(s, ENGLISH, `${i.id}: ${s}`);
    // the same English request; only a name the map itself has per language (a target's, a rule's) follows the map
    const fix = i.fix.replace(/Zahlungen/g, 'Payments').replace(/Kein Datenbankzugriff von der Website/g, 'No database access from the website');
    assert.equal(fix, en.health.issues.find((x) => x.id === i.id).fix, `${i.id}: the fix request is the same English text`);
  }
  const byId = Object.fromEntries(de.health.issues.map((i) => [i.id, i]));
  assert.equal(byId['secret:shop-api/config.js'].notes['f:shop-api/config.js'], `Zeile 1: DB_PASSWORD, ein Passwort (${'correct-horse-battery-staple-42'.length} Zeichen)`);
  assert.equal(byId['single-writer:payments'].notes['n:stripe'], 'Zahlungen: ein Schreiber erlaubt, 2 eingetragen');
  assert.equal(byId['large-files'].notes['f:shop-api/big.js'], '1.200 Zeilen', 'numbers in the map\'s language');
  assert.match(byId['retired-rule:no-db-web'].detail, /\(bis 2026-10-25\), aber sie gilt noch an 1 Stelle: Website\./);
  assert.match(byId['publish:private-word:system'].detail, /\(W\*{7}\)/, 'a private word still shows only its first letter');
  assert.equal(byId['publish:hardcoded-identifier:system'].notes['f:shop-api/notion.js'], 'Zeile 2: eine ID im UUID-Format');
});

test('MAP.md lists the findings with their titles in the map\'s language, and its count of places once', () => {
  const md = mapHealth(root);
  assert.match(md, /^## Code-Check$/m);
  assert.match(md, /^- \[wichtig\] Ein geheimer Schlüssel steht in config\.js \(1 Stelle\)$/m);
  assert.match(md, /^- \[bald beheben\] Ein Name aus deiner privaten Wortliste steht in System-Dateien \(1 Stelle\)$/m);
  assert.doesNotMatch(md, /Stellen?\) \(\d+ Stellen?\)/, 'a title that counts its places says it once');
  build(root);
  const english = mapHealth(root);
  assert.match(english, /^- \[important\] A secret key is written into config\.js \(1 place\)$/m);
  assert.match(english, /^- \[worth fixing\] A name from your private word list is in system files \(1 place\)$/m);
  build(root, '--lang', 'de');
});

test('every health.* key is in both tables, and the German texts keep the placeholders', () => {
  const table = (code) => readJson(path.join(SKILL, 'assets', 'lang', `${code}.json`));
  const enT = table('en'), deT = table('de');
  const keys = Object.keys(enT).filter((k) => k.startsWith('health.'));
  assert.ok(keys.length > 250, 'the findings\' texts are in the table');
  for (const k of keys) assert.equal(typeof deT[k], 'string', `${k} is in de.json`);
  // one block of keys per check, named by the id's first part
  for (const check of ['secret', 'env-file', 'public-env', 'rls', 'open-policy', 'firebase-rules', 'stripe-webhook', 'cors', 'misplaced-guard', 'no-auth', 'open-endpoints', 'unused', 'large-files', 'localhost-url', 'single-writer', 'undeclared-target-call', 'retired-rule', 'publish.hardcoded-identifier', 'publish.private-word', 'publish.contact-data', 'publish.machine-path', 'publish.layer-mixing', 'plan-open-writes', 'plan-no-access', 'plan-question', 'plan-unused-endpoints', 'plan-loose-files']) {
    assert.ok(keys.some((k) => k.startsWith(`health.${check}.`)), `health.${check}.* is in the table`);
  }
});

test('the scan records the kind of a secret and a CORS form as keys, not words, so one scan serves any language', async () => {
  const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  const secret = scan.files.find((f) => f.path === 'shop-api/config.js').issues.find((x) => x.k === 'secret');
  assert.equal(secret.what, 'password');
  assert.deepEqual(secret.hint, { len: 'correct-horse-battery-staple-42'.length });
  const { findIssues } = await import(new URL('../skills/floorplan/scripts/lib/health.mjs', import.meta.url));
  const [cors] = findIssues(`import cors from 'cors';\napp.use(cors());`, { path: 'server.js', category: 'code', lang: 'javascript' }).filter((x) => x.k === 'cors-any');
  assert.equal(cors.how, 'cors');
});

// ---------- in a real browser ----------

// With FLOORPLAN_TEST_SHOTS set to a folder, the test also saves a screenshot of the German Health panel there.
test('in the browser the Health panel shows the German findings, and nothing errors', async (t) => {
  const browser = await launchBrowser();
  if (!browser) return t.skip('no Playwright with a Chromium in this environment');
  try {
    const { page, errors } = await openMap(browser, root);
    await page.click('#btn-health');
    const panel = await page.evaluate(() => document.querySelector('#panel').innerText);
    for (const s of ['Code-Check', 'Zuerst beheben', 'Ein geheimer Schlüssel steht in config.js', 'Zwei Schreiber für ein Ziel, das nur einen haben darf: Zahlungen', 'Veröffentlichbarkeit', 'Eine Kennung dieser einen Installation steht im Systemcode', 'Mit Claude beheben']) assert.ok(panel.includes(s), `"${s}" is in the panel`);
    assert.doesNotMatch(panel, /Fix with|written into|single-writer target|looks unused/);
    if (process.env.FLOORPLAN_TEST_SHOTS) await page.screenshot({ path: path.join(process.env.FLOORPLAN_TEST_SHOTS, 'health-de.png'), fullPage: false });
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});
