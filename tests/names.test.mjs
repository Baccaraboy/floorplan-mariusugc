// Fixed names: floorplan/names.json holds the owner's own names (and, if they like, descriptions) for parts, files
// and endpoints. The build applies it last, so it wins over architecture.json and descriptions/, in one language or
// one per language; unknown entries are errors with a suggestion; describe.mjs leaves fixed entries alone; refresh.mjs
// never re-keys them, it says what moved. Without the file, nothing changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shopApp, scanAndBuild, run, readGraph, readJson, writeJson, cleanup } from './helpers.mjs';

const namesFile = (root) => path.join(root, 'floorplan', 'names.json');
const build = (root, ...args) => run('build.mjs', root, '--no-claude-md', ...args);
/** Runs build.mjs and returns what it printed, also when it fails. */
const buildOut = (root, ...args) => { try { return build(root, ...args); } catch (e) { return String(e.stdout) + String(e.stderr); } };
const route = (g, key) => g.routes.find((r) => `${r.m} ${r.p}` === key);
const file = (g, p) => g.files.find((f) => f.p === p);
const node = (g, id) => g.nodes.find((n) => n.id === id);

let root;
before(() => { root = shopApp(); scanAndBuild(root); });
after(() => cleanup(root));

test('an entry in names.json wins over architecture.json and descriptions/', () => {
  writeJson(path.join(root, 'floorplan', 'descriptions', 'api.json'), {
    files: { 'shop-api/routes/orders.js': { name: 'Orders handler', description: 'Lists and refunds orders.' } },
    routes: { 'GET /api/orders': { name: 'List orders', description: 'Every order of the signed-in customer.' } },
  });
  writeJson(namesFile(root), {
    parts: { api: { name: 'The Back Office', description: 'Where every order is kept and changed.' } },
    files: { 'shop-api/routes/orders.js': { name: 'The Till' } },
    routes: { 'GET /api/orders': { name: 'The Order Book', description: 'Hands out the order list.' } },
  });
  const out = build(root);
  const g = readGraph(root);
  // a part: name and description from the table, not architecture.json's label and summary
  assert.equal(node(g, 'api').label, 'The Back Office');
  assert.equal(node(g, 'api').summary, 'Where every order is kept and changed.');
  assert.equal(node(g, 'api').fixed, 'all');
  assert.equal(node(g, 'web').label, 'Website', 'parts the table leaves out keep their own label');
  assert.equal(node(g, 'web').fixed, undefined);
  // a file: the name is fixed, the description still comes from descriptions/
  assert.equal(file(g, 'shop-api/routes/orders.js').name, 'The Till');
  assert.equal(file(g, 'shop-api/routes/orders.js').d, 'Lists and refunds orders.');
  assert.equal(file(g, 'shop-api/routes/orders.js').fixed, 'name');
  // an endpoint: both fixed
  assert.equal(route(g, 'GET /api/orders').name, 'The Order Book');
  assert.equal(route(g, 'GET /api/orders').d, 'Hands out the order list.');
  assert.equal(route(g, 'GET /api/orders').fixed, 'all');
  assert.match(out, /NAMES {2}3 fixed in names\.json \(1 part, 1 file, 1 endpoint\)/);
  // the map shows them: the page carries the same graph
  const html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.ok(html.includes('"label":"The Back Office"'));
});

test('a rebuild and a refresh keep the fixed names, and describe.mjs leaves them alone', () => {
  writeJson(namesFile(root), {
    files: { 'shop-api/auth.js': { name: 'The Gatekeeper', description: 'Checks who may come in.' }, 'shop-api/config.js': { name: 'The Settings' } },
  });
  build(root);
  run('refresh.mjs', root);
  let g = readGraph(root);
  assert.equal(file(g, 'shop-api/auth.js').name, 'The Gatekeeper');
  assert.equal(file(g, 'shop-api/config.js').name, 'The Settings');
  // names.json itself is never rewritten by a build or refresh
  assert.deepEqual(readJson(namesFile(root)).files['shop-api/auth.js'], { name: 'The Gatekeeper', description: 'Checks who may come in.' });

  const out = run('describe.mjs', root, '--all');
  const sheets = path.join(root, 'floorplan', '.cache', 'worksheets');
  const text = fs.readdirSync(sheets).map((n) => fs.readFileSync(path.join(sheets, n), 'utf8')).join('\n');
  // fully fixed: no worksheet entry at all, even with --all
  assert.doesNotMatch(text, /## shop-api\/auth\.js/);
  // only the name fixed: the AI writes the description and keeps the name
  assert.match(text, /## shop-api\/config\.js .*\n.*FIXED NAME "The Settings"/);
  assert.match(text, /keep that name exactly and write only the description/);
  assert.match(out, /worksheet/);
  const skel = readJson(path.join(root, 'floorplan', 'descriptions', 'api.json'));
  assert.equal(skel.files['shop-api/config.js'].name, 'The Settings');
  assert.equal(skel.files['shop-api/auth.js'], undefined, 'no skeleton entry for what is fully fixed');
  // the AI's own name in descriptions/ doesn't win either
  skel.files['shop-api/config.js'] = { name: 'Configuration', description: 'Settings the server reads at start.' };
  writeJson(path.join(root, 'floorplan', 'descriptions', 'api.json'), skel);
  build(root);
  g = readGraph(root);
  assert.equal(file(g, 'shop-api/config.js').name, 'The Settings');
  assert.equal(file(g, 'shop-api/config.js').d, 'Settings the server reads at start.');
});

test('names can be one per language: the map\'s language, else English, else the first one given', () => {
  writeJson(namesFile(root), {
    parts: {
      api: { name: { en: 'The Back Office', de: 'Das Hinterzimmer' }, description: { en: 'Keeps the orders.', de: 'Verwahrt die Bestellungen.' } },
      web: { name: { de: 'Der Empfang' } },
    },
    files: { 'shop-api/auth.js': { name: 'Gatekeeper' } },
  });
  build(root);
  let g = readGraph(root);
  assert.equal(node(g, 'api').label, 'The Back Office');
  assert.equal(node(g, 'api').summary, 'Keeps the orders.');
  assert.equal(node(g, 'web').label, 'Der Empfang', 'with no English name, the one given is used');
  assert.equal(file(g, 'shop-api/auth.js').name, 'Gatekeeper', 'a plain string is the same in every language');
  build(root, '--lang', 'de');
  g = readGraph(root);
  assert.equal(node(g, 'api').label, 'Das Hinterzimmer');
  assert.equal(node(g, 'api').summary, 'Verwahrt die Bestellungen.');
  assert.equal(node(g, 'web').label, 'Der Empfang');
  assert.equal(file(g, 'shop-api/auth.js').name, 'Gatekeeper');
});

test('an unknown part, file or endpoint is an error that suggests the likely one', () => {
  writeJson(namesFile(root), {
    parts: { ap: { name: 'The Back Office' } },
    files: { 'shop-api/routes/order.js': { name: 'The Till' }, 'shop-api/package.json': { name: 'Manifest' } },
    routes: { 'GET /api/order': { name: 'The Order Book' } },
  });
  const out = buildOut(root);
  assert.match(out, /error\(s\) in floorplan\/architecture\.json or names\.json/);
  assert.match(out, /names\.json parts\["ap"\] is not a part in architecture\.json — did you mean "api"\?/);
  assert.match(out, /names\.json files\["shop-api\/routes\/order\.js"\] is not a file on the map — did you mean "shop-api\/routes\/orders\.js"\?/);
  assert.match(out, /names\.json files\["shop-api\/package\.json"\] is a file that is not on the map \(category config\)/);
  assert.match(out, /names\.json routes\["GET \/api\/order"\] is not an endpoint on the map — did you mean "GET \/api\/orders"\?/);
  assert.match(out, /Fix the errors above and run build again/);
});

test('a malformed entry or section is an error too, naming the field', () => {
  writeJson(namesFile(root), {
    part: {},
    parts: { api: { description: 'No name' }, web: 'Website' },
    files: { 'shop-api/auth.js': { name: { english: 'The Gatekeeper' } }, 'shop-api/config.js': { name: '  ' } },
  });
  const out = buildOut(root);
  assert.match(out, /names\.json: unknown section "part" — did you mean "parts"\?/);
  assert.match(out, /names\.json parts\["api"\]\.name is required/);
  assert.match(out, /names\.json parts\["web"\] must be \{ "name": "…", "description": "…" \}/);
  assert.match(out, /names\.json files\["shop-api\/auth\.js"\]\.name: "english" is not a language code/);
  assert.match(out, /names\.json files\["shop-api\/config\.js"\]\.name is empty/);
  fs.writeFileSync(namesFile(root), '{ "parts": ');
  assert.match(buildOut(root), /names\.json is not valid JSON/);
});

test('without names.json the build is unchanged, and an empty one changes nothing', () => {
  const r = shopApp();
  try {
    const out = scanAndBuild(r);
    const g = readGraph(r);
    assert.doesNotMatch(out, /NAMES/);
    assert.deepEqual(g.nodes.map((n) => n.label), ['Server', 'Website']);
    for (const x of [...g.nodes, ...g.files, ...g.routes]) assert.equal(x.fixed, undefined);
    const strip = (x) => JSON.stringify({ ...x, meta: { ...x.meta, generatedAt: null } });
    writeJson(namesFile(r), {});
    build(r);
    assert.equal(strip(readGraph(r)), strip(g));
  } finally { cleanup(r); }
});

test('a refresh never re-keys names.json: a renamed or deleted file is reported in NEXT, with the new path', () => {
  const r = shopApp();
  try {
    scanAndBuild(r);
    const table = { files: { 'shop-api/routes/notes.js': { name: 'Guest Book' }, 'shop-api/routes/admin.js': { name: 'Staff Room' } }, routes: { 'DELETE /admin/users/:id': { name: 'Show Someone Out' } } };
    writeJson(namesFile(r), table);
    build(r);
    // notes.js is renamed (same content), admin.js and its endpoint are deleted
    fs.renameSync(path.join(r, 'shop-api/routes/notes.js'), path.join(r, 'shop-api/routes/feedback.js'));
    const server = path.join(r, 'shop-api/server.js');
    fs.writeFileSync(server, fs.readFileSync(server, 'utf8').replaceAll('notes', 'feedback').replace("import admin from './routes/admin.js';\n", '').replace("app.use('/admin', requireStaff, admin);\n", ''));
    fs.rmSync(path.join(r, 'shop-api/routes/admin.js'));
    const out = run('refresh.mjs', r);
    // the table is exactly as the owner left it
    assert.deepEqual(readJson(namesFile(r)), table);
    assert.match(out, /names\.json fixes names that the refresh doesn't move/);
    assert.match(out, /"shop-api\/routes\/notes\.js" moved to "shop-api\/routes\/feedback\.js"/);
    assert.match(out, /"shop-api\/routes\/admin\.js" was deleted/);
    assert.match(out, /"DELETE \/admin\/users\/:id" no longer exists/);
    // and the build, which fails until names.json is updated, says the same instead of guessing by spelling
    assert.match(out, /names\.json files\["shop-api\/routes\/notes\.js"\] is not a file on the map — did you mean "shop-api\/routes\/feedback\.js"\? \(it moved there\)/);
    assert.match(out, /names\.json files\["shop-api\/routes\/admin\.js"\] is not a file on the map \(it was deleted\)/);
    assert.match(out, /names\.json routes\["DELETE \/admin\/users\/:id"\] is not an endpoint on the map \(it was deleted\)/);
  } finally { cleanup(r); }
});

test('a refresh reports an endpoint whose address changed, with its new address', () => {
  const r = shopApp();
  try {
    const notes = path.join(r, 'shop-api/routes/notes.js');
    // a named handler lets the refresh follow the endpoint to its new address
    fs.writeFileSync(notes, "import { Router } from 'express';\nconst router = Router();\nrouter.post('/notes', saveNote);\nexport async function saveNote(req, res) { res.json({ saved: true }); }\nexport default router;\n");
    scanAndBuild(r);
    writeJson(namesFile(r), { routes: { 'POST /api/notes': { name: 'Sign the Guest Book' } } });
    build(r);
    fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace("'/notes'", "'/guestbook'"));
    const out = run('refresh.mjs', r);
    assert.match(out, /"POST \/api\/notes" is now "POST \/api\/guestbook"/);
    assert.deepEqual(Object.keys(readJson(namesFile(r)).routes), ['POST /api/notes']);
  } finally { cleanup(r); }
});
