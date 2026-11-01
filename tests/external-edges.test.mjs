// An edge in architecture.json between two external nodes (a database that notifies a mail service, a sign-in provider
// that calls a webhook on a hosting platform) is true, but the viewer puts every external node in the last column of
// the layout, and the layout engine rejects an edge from one last-column node to another: the whole board failed with
// "Layout failed: … layer constraint set to LAST …". The build now keeps such an edge, warns, and marks it "drawn: false";
// the viewer leaves it out of the layout and still lists it in the connections of both nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, shopApp, scanAndBuild, run, readGraph, launchBrowser, openMap, cleanup } from './helpers.mjs';

/** A small app with a database and a mail service, and an edge from the one to the other. */
function appWithTwoServices(edges) {
  const files = {
    'app/package.json': JSON.stringify({ name: 'app', type: 'module', dependencies: { pg: '^8.12.0' } }),
    'app/db.js': "import pg from 'pg';\nexport const pool = new pg.Pool();\n",
    'app/mail.js': "export const send = (m) => fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', body: m });\n",
  };
  const arch = {
    project: { name: 'Mini', summary: 'A small app.' },
    nodes: [
      { id: 'app', label: 'App', kind: 'service', summary: 'The app.', paths: ['app/**'] },
      { id: 'db', label: 'Database', kind: 'external', summary: 'Keeps the data.', packages: ['pg'] },
      { id: 'mail', label: 'Email service', kind: 'external', summary: 'Sends mail.', hosts: ['api.sendgrid.com'] },
    ],
    edges,
  };
  return makeProject(files, { repos: ['app'], arch });
}
const BETWEEN = { from: 'db', to: 'mail', kind: 'event', label: 'db events', description: 'The database notifies the mail service.' };

test('the build keeps an edge between two external nodes, warns, and marks it as not drawn', () => {
  const root = appWithTwoServices([BETWEEN, { from: 'mail', to: 'app/mail.js', kind: 'http', label: 'delivery webhooks' }]);
  try {
    const out = scanAndBuild(root);
    assert.match(out, /edges\[0\]: both ends are external nodes \("db" and "mail"\); shown in the panels, not drawn on the board/);
    assert.doesNotMatch(out, /edges\[1\]/, 'an edge from an external node into the code is drawn as before');
    assert.doesNotMatch(out, /error/);
    const g = readGraph(root);
    const between = g.links.find((l) => l.a === 'n:db' && l.b === 'n:mail');
    assert.equal(between.drawn, false);
    assert.equal(between.k, 'event');
    assert.deepEqual(between.labels, ['db events'], 'the edge keeps its label and description for the panels');
    assert.equal(between.desc, 'The database notifies the mail service.');
    for (const l of g.links.filter((l) => l !== between)) assert.equal(l.drawn, undefined, `${l.a} > ${l.b} is drawn`);
  } finally { cleanup(root); }
});

test('without such an edge nothing changes: no "drawn" field and no warning', () => {
  const root = shopApp();
  try {
    const out = scanAndBuild(root);
    assert.doesNotMatch(out, /external nodes/);
    assert.ok(readGraph(root).links.every((l) => !('drawn' in l)));
  } finally { cleanup(root); }
});

test('the map lays out without an error, draws the other connections, and lists the edge under both nodes', async (t) => {
  const browser = await launchBrowser();
  if (!browser) return t.skip('no Playwright with a Chromium in this environment');
  const root = appWithTwoServices([BETWEEN]);
  try {
    scanAndBuild(root);
    const { page, errors } = await openMap(browser, root);
    const board = await page.evaluate(() => ({
      failed: !document.querySelector('#empty').hidden,
      cards: [...document.querySelectorAll('.node .card .title')].map((e) => e.textContent).sort(),
      edges: document.querySelectorAll('g.edges > .edge path.trace').length,
    }));
    assert.equal(board.failed, false, 'the layout went through');
    assert.deepEqual(board.cards, ['App', 'Database', 'Email service']);
    assert.equal(board.edges, 2, 'the two connections from the app are drawn, the one between the services is not');
    assert.deepEqual(errors, []);
    // the details of each node still list the other
    const listed = await page.evaluate(() => {
      const text = (id) => { window.Floorplan.select(id); return document.querySelector('#panel').textContent; };
      return { db: text('n:db'), mail: text('n:mail') };
    });
    assert.match(listed.db, /Depends on[\s\S]*Email service/);
    assert.match(listed.mail, /Used by[\s\S]*Database/);
    await page.close();
  } finally { await browser.close(); cleanup(root); }
});
