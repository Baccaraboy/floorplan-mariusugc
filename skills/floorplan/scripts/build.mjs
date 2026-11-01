#!/usr/bin/env node
// floorplan builder: validate floorplan/architecture.json against the scan, assign every file to a
// node, attach import/HTTP/external edges, and write floorplan/graph.json + floorplan/index.html.
//
// usage: node build.mjs [root] [--arch <file>] [--scan <file>] [--out <dir>] [--lang <code>] [--check]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileGlob, parseArgs, fmtNum, mapDir, keepOutOfGit, git, toPosix, GIT_MODES } from './lib/common.mjs';
import { buildMapMd, withoutStamp } from './lib/mapmd.mjs';
import { fallbackFileName, fallbackRouteName, routeKey } from './lib/names.mjs';
import { buildHealth, TEST_FILE } from './lib/health.mjs';
import { LAYER_IDS, layerAssigner, majority, parseWords } from './lib/layers.mjs';
import { buildPlanHealth } from './lib/blueprint.mjs';
import { buildScreens } from './lib/screens.mjs';
import { writeClaudeMd } from './lib/claudemd.mjs';
import { detectAgent } from './lib/agent.mjs';
import { languages, strings as langStrings, fill } from './lib/lang.mjs';
import { parseCron, cronTimes, cronWords, isInterval, intervalWords, intervalTimes } from './lib/cron-text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const args = parseArgs(process.argv.slice(2));
const agent = detectAgent(args);
const root = path.resolve(args._[0] || '.');
const outDir = path.resolve(args.out || mapDir(root));
const archFile = path.resolve(args.arch || path.join(outDir, 'architecture.json'));
const scanFile = path.resolve(args.scan || path.join(outDir, '.cache', 'scan.json'));

export const NODE_KINDS = ['ui', 'service', 'worker', 'library', 'feature', 'data', 'config', 'test', 'script', 'infra', 'external'];
export const EDGE_KINDS = ['import', 'call', 'http', 'rpc', 'event', 'queue', 'data', 'config'];

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
if (!fs.existsSync(scanFile)) fail(`No scan at ${scanFile}. Run: node ${path.join(SKILL_DIR, 'scripts', 'scan.mjs')} "${root}"`);
if (!fs.existsSync(archFile)) fail(`No architecture file at ${archFile}. Write it first (see references/schema.md).`);
const scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
let arch;
try { arch = JSON.parse(fs.readFileSync(archFile, 'utf8')); } catch (e) { fail(`architecture.json is not valid JSON: ${e.message}`); }

// ---------- validate shape ----------
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
function closest(word, options) {
  let best = null, bestD = Infinity;
  for (const o of options) {
    const d = lev(word, o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return bestD <= Math.max(2, word.length / 3) ? best : null;
}
function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = dp[j]; dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return dp[b.length];
}
const didYouMean = (w, opts) => { const c = closest(w, opts); return c ? ` — did you mean "${c}"?` : ''; };

if (!arch || typeof arch !== 'object') fail('architecture.json must be an object');
if (!arch.project || !isStr(arch.project.name)) err('project.name is required');
if (!Array.isArray(arch.nodes) || !arch.nodes.length) err('nodes must be a non-empty array');
const nodes = Array.isArray(arch.nodes) ? arch.nodes : [];
const archEdges = Array.isArray(arch.edges) ? arch.edges : [];
const flows = Array.isArray(arch.flows) ? arch.flows : [];
const annotations = Array.isArray(arch.annotations) ? arch.annotations : [];
const include = isStrArr(arch.include) ? arch.include : ['code'];
const ignoreGlobs = (isStrArr(arch.ignore) ? arch.ignore : []).map(compileGlob);
// who the descriptions are written for: "everyone" (plain language, default) or "developers"
const AUDIENCES = ['everyone', 'developers'];
if (arch.audience !== undefined && !AUDIENCES.includes(arch.audience)) err(`audience "${arch.audience}" must be one of ${AUDIENCES.join(', ')}${didYouMean(String(arch.audience), AUDIENCES)}`);
const audience = AUDIENCES.includes(arch.audience) ? arch.audience : 'everyone';
// where the map's own files may go in git: "none" (default) keeps the whole folder out; "inputs" keeps out only what a
// build writes again, so the inputs and MAP.md can be committed (lib/common.mjs keepOutOfGit)
if (arch.git !== undefined && !GIT_MODES.includes(arch.git)) err(`git "${arch.git}" must be one of ${GIT_MODES.join(', ')}${didYouMean(String(arch.git), GIT_MODES)}`);
const gitMode = GIT_MODES.includes(arch.git) ? arch.git : 'none';
// the language of the map's own words (buttons, panels, the glossary): --lang, else architecture.json "lang", else English
const LANGS = languages();
const langWanted = args.lang !== undefined ? args.lang : arch.lang;
if (langWanted !== undefined && !LANGS.includes(langWanted)) err(`${args.lang !== undefined ? '--lang' : 'lang'} "${langWanted}" must be one of ${LANGS.join(', ')}${didYouMean(String(langWanted), LANGS)}`);
const lang = LANGS.includes(langWanted) ? langWanted : 'en';
const words = langStrings(lang);

const byId = new Map();
nodes.forEach((n, i) => {
  const where = `nodes[${i}]${n?.id ? ` ("${n.id}")` : ''}`;
  if (!n || typeof n !== 'object') return err(`${where} must be an object`);
  if (!isStr(n.id)) return err(`${where}.id is required`);
  if (!/^[A-Za-z0-9_.\-]+$/.test(n.id)) err(`${where}.id may only use letters, digits, "_", "-" and "."`);
  if (n.id === 'unassigned') err(`${where}.id "unassigned" is reserved`);
  if (byId.has(n.id)) err(`${where}.id duplicates an earlier node`);
  byId.set(n.id, n);
  if (!isStr(n.label)) err(`${where}.label is required`);
  if (!NODE_KINDS.includes(n.kind)) err(`${where}.kind "${n.kind}" must be one of ${NODE_KINDS.join(', ')}${didYouMean(String(n.kind), NODE_KINDS)}`);
  for (const k of ['paths', 'exclude', 'packages', 'hosts', 'tags']) if (n[k] !== undefined && !isStrArr(n[k])) err(`${where}.${k} must be an array of strings`);
  if (n.kind === 'external' && n.paths?.length) warn(`${where} is external but has paths; external nodes normally own no files`);
});
const ids = [...byId.keys()];
for (const n of nodes) {
  if (n?.parent === undefined) continue;
  if (!byId.has(n.parent)) err(`node "${n.id}".parent "${n.parent}" does not exist${didYouMean(n.parent, ids)}`);
}
// cycles + depth
const depthOf = new Map();
const depth = (id, seen = new Set()) => {
  if (depthOf.has(id)) return depthOf.get(id);
  if (seen.has(id)) { err(`node "${id}" is part of a parent cycle`); return 0; }
  seen.add(id);
  const n = byId.get(id);
  const d = n?.parent && byId.has(n.parent) ? depth(n.parent, seen) + 1 : 0;
  depthOf.set(id, d);
  return d;
};
ids.forEach((id) => depth(id));

// ---------- files ----------
const filesAll = scan.files;
const fileByPath = new Map(filesAll.map((f) => [f.path, f]));
const included = filesAll.filter((f) => include.includes(f.category) && !ignoreGlobs.some((g) => g.test(f.path)));
const includedSet = new Set(included.map((f) => f.path));

// ---------- assign files to nodes ----------
// A node's `exclude` also applies to its descendants, so "web excludes tests" holds all the way down.
const inheritedExcludes = (n, seen = new Set()) => {
  if (!n || seen.has(n.id)) return [];
  seen.add(n.id);
  return [...(isStrArr(n.exclude) ? n.exclude : []), ...(n.parent ? inheritedExcludes(byId.get(n.parent), seen) : [])];
};
const matchers = nodes.filter((n) => n?.id && isStrArr(n.paths ?? [])).map((n, order) => ({
  id: n.id, order, depth: depthOf.get(n.id) || 0,
  paths: (n.paths || []).map(compileGlob), exclude: inheritedExcludes(n).map(compileGlob), hits: new Array((n.paths || []).length).fill(0),
}));
const owner = new Map();
let ambiguous = 0;
const ambiguousEx = [];
for (const f of included) {
  let best = null, bestKey = null, tie = null;
  for (const m of matchers) {
    if (m.exclude.some((g) => g.test(f.path))) continue;
    let spec = -1;
    m.paths.forEach((g, i) => { if (g.test(f.path)) { m.hits[i]++; spec = Math.max(spec, g.specificity); } });
    if (spec < 0) continue;
    const key = [m.depth, spec];
    if (!best || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { best = m; bestKey = key; tie = null; }
    else if (key[0] === bestKey[0] && key[1] === bestKey[1]) tie = m.id;
  }
  if (tie) { ambiguous++; if (ambiguousEx.length < 3) ambiguousEx.push(`${f.path} (${best.id} vs ${tie})`); }
  owner.set(f.path, best ? best.id : 'unassigned');
}
for (const m of matchers) m.hits.forEach((h, i) => { if (!h) warn(`node "${m.id}" path "${m.paths[i].glob}" matches no included file`); });
if (ambiguous) warn(`${ambiguous} file(s) matched two sibling nodes equally; the first declared won. Make globs more specific or add an exclude. e.g. ${ambiguousEx.join('; ')}`);

// ---------- endpoints ----------
const resolveEndpoint = (ref, where) => {
  if (!isStr(ref)) { err(`${where} must be a node id or file path`); return null; }
  if (byId.has(ref)) return `n:${ref}`;
  const p = ref.replace(/^file:/, '');
  if (includedSet.has(p)) return `f:${p}`;
  if (fileByPath.has(p)) { err(`${where} "${ref}" is a file that is not included (category ${fileByPath.get(p).category}); point at its node instead`); return null; }
  err(`${where} "${ref}" is neither a node id nor a scanned file${didYouMean(ref, ids)}`);
  return null;
};

// ---------- links ----------
const links = new Map(); // key -> link
const addLink = (a, b, k, extra = {}) => {
  if (!a || !b || a === b) return;
  const key = `${a}|${b}|${k}`;
  let l = links.get(key);
  if (!l) { l = { a, b, k, w: 0 }; links.set(key, l); }
  l.w += extra.w || 1;
  if (extra.names?.length) l.names = [...new Set([...(l.names || []), ...extra.names])].slice(0, 40);
  if (extra.label) { l.labels = l.labels || []; if (!l.labels.includes(extra.label) && l.labels.length < 40) l.labels.push(extra.label); }
  if (extra.inferred) l.inferred = true;
  if (extra.desc) l.desc = extra.desc;
  if (extra.drawn === false) l.drawn = false;
  if (extra.route !== undefined) { l.calls = l.calls || []; if (l.calls.length < 80) l.calls.push([extra.route, extra.callLine || 0]); }
};

// ---------- routes ----------
const routeIdx = new Map();
const routesIn = scan.routes.filter((r) => includedSet.has(r.file));
routesIn.forEach((r, i) => routeIdx.set(`${r.file}|${r.method}|${r.path}`, i));

for (const e of scan.edges) if (includedSet.has(e.from) && includedSet.has(e.to)) addLink(`f:${e.from}`, `f:${e.to}`, 'import', { w: e.count || 1, names: e.names });
for (const h of scan.http) if (includedSet.has(h.from) && includedSet.has(h.to)) addLink(`f:${h.from}`, `f:${h.to}`, 'http', { label: `${h.method} ${h.path}`, inferred: true, route: routeIdx.get(`${h.to}|${h.method}|${h.path}`), callLine: h.line });

// externals: packages / hosts claimed by nodes
const extIds = scan.externals.map((e) => e.id);
const pkgMatchers = nodes.filter((n) => n?.packages?.length).map((n) => ({ id: n.id, globs: n.packages.map((p) => compileGlob(p.includes(':') ? p : `*:${p}`)), hits: 0 }));
const hostMatchers = nodes.filter((n) => n?.hosts?.length).map((n) => ({ id: n.id, globs: n.hosts.map((h) => compileGlob(h.toLowerCase())), hits: 0 }));
for (const e of scan.extEdges) {
  if (!includedSet.has(e.from)) continue;
  const m = pkgMatchers.find((pm) => pm.globs.some((g) => g.test(e.pkg)));
  if (m) { m.hits++; addLink(`f:${e.from}`, `n:${m.id}`, 'import', { w: e.count, names: [e.pkg.split(':')[1]] }); }
}
for (const h of scan.hosts) {
  if (!includedSet.has(h.from)) continue;
  const m = hostMatchers.find((hm) => hm.globs.some((g) => g.test(h.host)));
  if (m) { m.hits++; addLink(`f:${h.from}`, `n:${m.id}`, 'http', { label: h.host, inferred: true }); }
}
for (const pm of pkgMatchers) if (!pm.hits) warn(`node "${pm.id}" packages match nothing imported. Known: ${extIds.slice(0, 8).join(', ')}…`);
for (const hm of hostMatchers) if (!hm.hits) warn(`node "${hm.id}" hosts match no host called from code`);

// a blueprint's planned links from files to outside services and data stores (plan.json "services"/"data")
for (const e of scan.nodeLinks || []) {
  if (!includedSet.has(e.from)) continue;
  if (!byId.has(e.to)) { err(`plan.json: "${e.from}" names "${e.to}" in its ${e.kind === 'data' ? 'data' : 'services'}, which is not a node id in architecture.json${didYouMean(e.to, ids)}`); continue; }
  addLink(`f:${e.from}`, `n:${e.to}`, EDGE_KINDS.includes(e.kind) ? e.kind : 'call', { label: e.label });
}

// An edge between two external nodes is kept (it's true) but not drawn: the viewer puts every external node in the
// last column of the layout, and the layout engine rejects an edge from one last-column node to another. The panels
// still list it under both nodes.
const isExternal = (ref) => ref.startsWith('n:') && byId.get(ref.slice(2))?.kind === 'external';
archEdges.forEach((e, i) => {
  const where = `edges[${i}]`;
  if (!EDGE_KINDS.includes(e?.kind)) err(`${where}.kind "${e?.kind}" must be one of ${EDGE_KINDS.join(', ')}${didYouMean(String(e?.kind), EDGE_KINDS)}`);
  const a = resolveEndpoint(e?.from, `${where}.from`);
  const b = resolveEndpoint(e?.to, `${where}.to`);
  if (!a || !b || !EDGE_KINDS.includes(e.kind)) return;
  const undrawn = isExternal(a) && isExternal(b);
  if (undrawn) warn(`${where}: both ends are external nodes ("${e.from}" and "${e.to}"); shown in the panels, not drawn on the board`);
  addLink(a, b, e.kind, { label: e.label, desc: e.description, w: 1, ...(undrawn ? { drawn: false } : {}) });
});

// ---------- flows + annotations ----------
const outFlows = [];
flows.forEach((fl, i) => {
  const where = `flows[${i}]`;
  if (!isStr(fl?.id) || !isStr(fl?.title)) err(`${where} needs id and title`);
  if (!Array.isArray(fl?.steps) || fl.steps.length < 2) { err(`${where}.steps needs at least 2 steps`); return; }
  const steps = fl.steps.map((s, j) => ({ ref: resolveEndpoint(s?.node, `${where}.steps[${j}].node`), note: s?.note || '' }));
  outFlows.push({ id: fl.id, title: fl.title, description: fl.description || '', steps });
});
// Flows people requested from the map (saved by serve.mjs). Steps use stable refs —
// "route:METHOD /path" and "sym:<file>#<name>" — so they survive rebuilds; stale steps are dropped.
const customFile = path.join(outDir, 'custom-flows.json');
if (fs.existsSync(customFile)) {
  let custom = [];
  try { custom = JSON.parse(fs.readFileSync(customFile, 'utf8')).flows || []; } catch (e) { warn(`custom-flows.json is not valid JSON: ${e.message}`); }
  const routeAt = new Map(routesIn.map((r, i) => [routeKey(r), i]));
  const resolveStep = (ref) => {
    if (typeof ref !== 'string') return null;
    if (ref.startsWith('route:')) { const i = routeAt.get(ref.slice(6)); return i == null ? null : `r:${i}`; }
    if (ref.startsWith('sym:')) {
      const [p, name] = [ref.slice(4, ref.lastIndexOf('#')), ref.slice(ref.lastIndexOf('#') + 1)];
      const i = (fileByPath.get(p)?.symbols || []).findIndex((s) => s.name === name);
      return includedSet.has(p) && i >= 0 ? `s:${p}#${i}` : null;
    }
    if (ref.startsWith('n:')) return byId.has(ref.slice(2)) ? ref : null;
    if (ref.startsWith('f:')) return includedSet.has(ref.slice(2)) ? ref : null;
    return null;
  };
  let dropped = 0;
  for (const fl of custom) {
    const steps = (fl.steps || []).map((s) => ({ ref: resolveStep(s.ref), note: s.note || '' })).filter((s) => s.ref);
    dropped += (fl.steps || []).length - steps.length;
    if (steps.length >= 2 && isStr(fl.id) && !outFlows.some((x) => x.id === fl.id)) outFlows.push({ id: fl.id, title: fl.title || 'Flow', description: fl.description || '', steps, custom: true });
  }
  if (dropped) warn(`${dropped} step(s) in custom-flows.json point at code that no longer exists and were left out.`);
}
// "Start here" tour: 3-8 narrated stops (node id or file path), written by Claude in architecture.json
const outTour = [];
if (arch.tour !== undefined) {
  if (!Array.isArray(arch.tour)) err('tour must be an array of { node, title, note }');
  else arch.tour.forEach((s, i) => {
    const ref = resolveEndpoint(s?.node, `tour[${i}].node`);
    if (ref) outTour.push({ ref, title: isStr(s.title) ? s.title : '', note: isStr(s.note) ? s.note : '' });
  });
}
// "Recent work": what Claude just changed, per task, framed against what the user asked for
// (floorplan/recent-work.json, rewritten on every make/update). Stale refs are warnings, never errors.
let outRecent = null;
const recentFile = path.join(outDir, 'recent-work.json');
if (fs.existsSync(recentFile)) {
  let rw = null;
  try { rw = JSON.parse(fs.readFileSync(recentFile, 'utf8')); } catch (e) { warn(`recent-work.json is not valid JSON: ${e.message}`); }
  const routeIdx = new Map(routesIn.map((r, i) => [routeKey(r), i]));
  const resolveRecent = (ref) => {
    if (!isStr(ref)) return null;
    const s = ref.trim().replace(/^\.\//, '').replace(/^(route:|file:)/, '');
    if (/^n:/.test(s)) return byId.has(s.slice(2)) ? s : null;
    if (/^f:/.test(s)) return includedSet.has(s.slice(2)) ? s : null;
    if (byId.has(s)) return 'n:' + s;
    if (includedSet.has(s)) return 'f:' + s;
    const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(s);
    if (m && routeIdx.has(`${m[1].toUpperCase()} ${m[2]}`)) return `r:${routeIdx.get(`${m[1].toUpperCase()} ${m[2]}`)}`;
    return null;
  };
  if (rw && !Array.isArray(rw.tasks)) warn('recent-work.json needs a "tasks" array (an empty one clears the highlights)');
  else if (rw) {
    const tasks = [], items = [], missing = [];
    rw.tasks.forEach((t, ti) => {
      if (!isStr(t?.title)) return warn(`recent-work.json tasks[${ti}] needs a title`);
      tasks.push({ title: t.title, request: isStr(t.request) ? t.request : '', summary: isStr(t.summary) ? t.summary : '', ...(isStr(t.status) ? { status: t.status } : {}) });
      for (const it of Array.isArray(t.items) ? t.items : []) {
        const id = resolveRecent(it?.ref);
        if (!id) { missing.push(it?.ref); continue; }
        items.push({ id, task: tasks.length - 1, change: it.change === 'new' ? 'new' : 'changed', note: isStr(it.note) ? it.note : '' });
      }
    });
    if (missing.length) warn(`recent-work.json: ${missing.length} ref(s) aren't on the map and were left out (use a file path, a node id or "METHOD /path"): ${missing.slice(0, 5).map(String).join(', ')}${missing.length > 5 ? '…' : ''}`);
    outRecent = { updatedAt: isStr(rw.updatedAt) ? rw.updatedAt : fs.statSync(recentFile).mtime.toISOString(), tasks, items };
  }
}
const notes = new Map();
annotations.forEach((a, i) => {
  if (!isStr(a?.path) || !isStr(a?.note)) return err(`annotations[${i}] needs path and note`);
  if (!includedSet.has(a.path)) return err(`annotations[${i}].path "${a.path}" is not an included file`);
  notes.set(a.path, { note: a.note, tags: isStrArr(a.tags) ? a.tags : undefined });
});
for (const ep of arch.project?.entrypoints || []) if (!includedSet.has(ep)) warn(`project.entrypoints "${ep}" is not an included file`);

// ---------- names + descriptions (floorplan/descriptions/*.json) ----------
const descDir = path.join(outDir, 'descriptions');
const fileDesc = new Map(), routeDesc = new Map();
const routeKeys = new Set(routesIn.map(routeKey));
let staleFiles = 0, staleRoutes = 0;
const staleEx = [];
if (fs.existsSync(descDir)) {
  for (const name of fs.readdirSync(descDir).filter((n) => n.endsWith('.json')).sort()) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(descDir, name), 'utf8')); } catch (e) { err(`descriptions/${name} is not valid JSON: ${e.message}`); continue; }
    for (const [p, v] of Object.entries(d.files || {})) {
      if (!v || typeof v !== 'object') { err(`descriptions/${name}: files["${p}"] must be { name, description }`); continue; }
      if (!includedSet.has(p)) { staleFiles++; if (staleEx.length < 3) staleEx.push(p); continue; }
      fileDesc.set(p, { name: isStr(v.name) ? v.name.trim() : null, d: isStr(v.description) ? v.description.trim() : null, review: isStr(v.review) ? v.review : null });
    }
    for (const [k, v] of Object.entries(d.routes || {})) {
      if (!v || typeof v !== 'object') { err(`descriptions/${name}: routes["${k}"] must be { name, description }`); continue; }
      if (!routeKeys.has(k)) { staleRoutes++; continue; }
      routeDesc.set(k, { name: isStr(v.name) ? v.name.trim() : null, d: isStr(v.description) ? v.description.trim() : null, review: isStr(v.review) ? v.review : null });
    }
  }
}
if (staleFiles) warn(`${staleFiles} described file(s) no longer exist or aren't included (e.g. ${staleEx.join(', ')}). Remove them from descriptions/.`);
if (staleRoutes) warn(`${staleRoutes} described route(s) no longer match a route in the scan; remove or re-key them.`);

// ---------- fixed names (floorplan/names.json) ----------
// The owner's own names, and optionally descriptions, for parts, files and endpoints. Applied last, so an entry
// wins over architecture.json, descriptions/*.json and plan.json, and no rebuild or refresh changes it. Each text is
// a string, or one per language ({ "en": "…", "de": "…" }): the map's language, else English, else the first given.
const namesFile = path.join(outDir, 'names.json');
const fixedParts = new Map(), fixedFiles = new Map(), fixedRoutes = new Map();
const LANG_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const fixedText = (v, where, required) => {
  if (v === undefined || v === null) { if (required) err(`${where} is required`); return null; }
  if (typeof v === 'string') { if (!v.trim()) err(`${where} is empty`); return v.trim() || null; }
  if (typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length) { err(`${where} must be a string, or one per language like { "en": "…", "de": "…" }`); return null; }
  for (const [code, s] of Object.entries(v)) {
    if (!LANG_CODE.test(code)) err(`${where}: "${code}" is not a language code (like "en" or "de")`);
    else if (typeof s !== 'string' || !s.trim()) err(`${where}.${code} must be a non-empty string`);
  }
  const ok = (c) => LANG_CODE.test(c) && typeof v[c] === 'string' && v[c].trim();
  const pick = ok(lang) ? lang : ok('en') ? 'en' : Object.keys(v).find(ok);
  return pick ? v[pick].trim() : null;
};
let namesTable = null;
if (fs.existsSync(namesFile)) {
  try { namesTable = JSON.parse(fs.readFileSync(namesFile, 'utf8')); } catch (e) { err(`names.json is not valid JSON: ${e.message}`); }
  if (namesTable !== null && (typeof namesTable !== 'object' || Array.isArray(namesTable))) { err('names.json must be an object with "parts", "files" and/or "routes"'); namesTable = null; }
}
if (namesTable) {
  const SECTIONS = ['parts', 'files', 'routes'];
  for (const k of Object.keys(namesTable)) if (!SECTIONS.includes(k) && k !== '$schema') err(`names.json: unknown section "${k}"${didYouMean(k, SECTIONS)}`);
  // what the last refresh saw move or go away (.cache/changes.json) beats a guess by spelling
  let changes = null;
  try { changes = JSON.parse(fs.readFileSync(path.join(outDir, '.cache', 'changes.json'), 'utf8')); } catch {}
  const movedTo = new Map([...(changes?.files?.moved || []), ...(changes?.routes?.moved || [])].map((m) => [m.from, m.to]));
  const gone = new Set([...(changes?.files?.deleted || []), ...(changes?.routes?.removed || [])]);
  const suggest = (k, onMap, options) => onMap(movedTo.get(k)) ? ` — did you mean "${movedTo.get(k)}"? (it moved there)` : gone.has(k) ? ' (it was deleted)' : didYouMean(k, options());
  const unknownFile = (p) => fileByPath.has(p) ? ` is a file that is not on the map (category ${fileByPath.get(p).category})` : ` is not a file on the map${suggest(p, (x) => includedSet.has(x), () => [...includedSet])}`;
  const sections = [
    ['parts', fixedParts, (k) => byId.has(k), (k) => ` is not a part in architecture.json${didYouMean(k, ids)}`, 'part ids'],
    ['files', fixedFiles, (k) => includedSet.has(k), unknownFile, 'file paths'],
    ['routes', fixedRoutes, (k) => routeKeys.has(k), (k) => ` is not an endpoint on the map${suggest(k, (x) => routeKeys.has(x), () => [...routeKeys])}`, '"METHOD /path"'],
  ];
  for (const [key, into, known, unknown, keyedBy] of sections) {
    const sec = namesTable[key];
    if (sec === undefined) continue;
    if (!sec || typeof sec !== 'object' || Array.isArray(sec)) { err(`names.json: "${key}" must be an object keyed by ${keyedBy}`); continue; }
    for (const [k, v] of Object.entries(sec)) {
      const where = `names.json ${key}["${k}"]`;
      if (!known(k)) { err(where + unknown(k)); continue; }
      if (!v || typeof v !== 'object' || Array.isArray(v)) { err(`${where} must be { "name": "…", "description": "…" }`); continue; }
      const name = fixedText(v.name, `${where}.name`, true), d = fixedText(v.description, `${where}.description`, false);
      if (name) into.set(k, { name, d, fixed: d ? 'all' : 'name' });
    }
  }
}
// a fixed description also settles a "review" flag: the AI doesn't rewrite what the owner wrote
for (const [p, fx] of fixedFiles) { const cur = fileDesc.get(p); fileDesc.set(p, { name: fx.name, d: fx.d || cur?.d || null, review: fx.d ? null : cur?.review || null, fixed: fx.fixed }); }
for (const [k, fx] of fixedRoutes) { const cur = routeDesc.get(k); routeDesc.set(k, { name: fx.name, d: fx.d || cur?.d || null, review: fx.d ? null : cur?.review || null, fixed: fx.fixed }); }

// ---------- stats ----------
const unassigned = included.filter((f) => owner.get(f.path) === 'unassigned');
const stats = new Map([...ids, 'unassigned'].map((id) => [id, { files: 0, loc: 0, langs: {}, repos: new Set() }]));
for (const f of included) {
  let id = owner.get(f.path);
  while (id) {
    const s = stats.get(id);
    s.files++; s.loc += f.loc; s.langs[f.lang || f.category] = (s.langs[f.lang || f.category] || 0) + f.loc;
    if (f.repo !== null) s.repos.add(f.repo);
    id = id === 'unassigned' ? null : byId.get(id)?.parent;
  }
}

// ---------- targets (floorplan/targets.json): who writes where ----------
// The places the app writes to or reads from (a database, a service, a file, an API, a queue), which parts write
// and which only read, and whether a target allows one writer only. The build checks the list, draws write and read
// connections from each part to the target's box (its "external" node), and notes the calls the scan saw into that
// box that the list doesn't mention. Those never count as writers on their own: the list stays the owner's word.
const TARGET_KINDS = ['database', 'service', 'file', 'api', 'queue', 'other'];
const POLICIES = ['single-writer', 'any'];
const targetsFile = path.join(outDir, 'targets.json');
let targetList = null;
if (fs.existsSync(targetsFile)) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(targetsFile, 'utf8')); } catch (e) { err(`targets.json is not valid JSON: ${e.message}`); }
  if (raw !== null) {
    targetList = Array.isArray(raw) ? raw : Array.isArray(raw?.targets) ? raw.targets : null;
    if (!targetList) err('targets.json must be a list of targets, or { "targets": [ … ] }');
  }
}
const outTargets = [];
// the parts that hold an item, nearest first: a file's part and its parents, or a node's parents (shared with rules.json)
const lineage = (item) => {
  const out = [];
  let id = item.startsWith('f:') ? owner.get(item.slice(2)) : byId.get(item.slice(2))?.parent;
  while (id && id !== 'unassigned' && !out.includes(id)) { out.push(id); id = byId.get(id)?.parent; }
  return out;
};
const inside = (x, y) => x === y || (y.startsWith('n:') && lineage(x).includes(y.slice(2)));
// a glob that takes in every file of a part stands for the part, so "api/**" draws one line from the API
const cover = (paths) => {
  const hit = new Map();
  for (const p of paths) for (const id of lineage('f:' + p)) hit.set(id, (hit.get(id) || 0) + 1);
  const out = [];
  for (const p of paths) {
    const whole = lineage('f:' + p).filter((id) => hit.get(id) === stats.get(id)?.files).pop();
    const item = whole ? 'n:' + whole : 'f:' + p;
    if (!out.includes(item)) out.push(item);
  }
  return out;
};
// a path that the last refresh saw move (.cache/changes.json) is suggested by where it went, not by spelling
let movedTo = new Map();
try { movedTo = new Map((JSON.parse(fs.readFileSync(path.join(outDir, '.cache', 'changes.json'), 'utf8')).files?.moved || []).map((m) => [m.from, m.to])); } catch {}
if (targetList?.length) {
  const resolveParts = (list, where) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) { err(`${where} must be a list of part ids, paths or globs`); return []; }
    const out = [];
    list.forEach((s, j) => {
      const w = `${where}[${j}]`;
      if (!isStr(s)) return err(`${w} must be a part id, a path or a glob`);
      if (byId.has(s)) return out.push({ ref: s, items: ['n:' + s] });
      const g = compileGlob(s);
      const hits = included.filter((f) => g.test(f.path)).map((f) => f.path);
      if (hits.length) return out.push({ ref: s, items: cover(hits) });
      if (fileByPath.has(s)) return err(`${w} "${s}" is a file that is not on the map (category ${fileByPath.get(s).category})`);
      err(`${w} "${s}" is neither a part id nor a path or glob that matches a file on the map${includedSet.has(movedTo.get(s)) ? ` — did you mean "${movedTo.get(s)}"? (it moved there)` : didYouMean(s, [...ids, ...includedSet])}`);
    });
    return out;
  };
  // one writer, however it's listed: an entry inside another entry (a file of a listed part, or a repeat) adds none
  const within = (a, b) => a.items.every((x) => b.items.some((y) => inside(x, y)));
  const distinct = (entries) => {
    const kept = [];
    for (const e of entries) {
      if (kept.some((k) => within(e, k))) continue;
      for (let i = kept.length - 1; i >= 0; i--) if (within(kept[i], e)) kept.splice(i, 1);
      kept.push(e);
    }
    for (const e of entries) if (!kept.includes(e)) e.in = kept.find((k) => within(e, k)).ref;
    return kept;
  };
  const seenIds = new Set();
  targetList.forEach((t, i) => {
    const where = `targets.json targets[${i}]${isStr(t?.id) ? ` ("${t.id}")` : ''}`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return err(`${where} must be an object`);
    if (!isStr(t.id)) err(`${where}.id is required`);
    else if (!/^[A-Za-z0-9_.\-]+$/.test(t.id)) err(`${where}.id may only use letters, digits, "_", "-" and "."`);
    else if (seenIds.has(t.id)) err(`${where}.id duplicates an earlier target`);
    seenIds.add(t.id);
    const name = fixedText(t.name, `${where}.name`, true);
    if (!TARGET_KINDS.includes(t.kind)) err(`${where}.kind "${t.kind}" must be one of ${TARGET_KINDS.join(', ')}${didYouMean(String(t.kind), TARGET_KINDS)}`);
    if (!POLICIES.includes(t.policy)) err(`${where}.policy "${t.policy}" must be "single-writer" or "any"${didYouMean(String(t.policy), POLICIES)}`);
    if (t.external !== undefined && !byId.has(t.external)) err(`${where}.external "${t.external}" is not a node in architecture.json${didYouMean(String(t.external), nodes.filter((n) => n?.kind === 'external').map((n) => n.id).concat(ids))}`);
    if (t.writers === undefined) err(`${where}.writers is required (an empty list for a target nothing writes to)`);
    const writers = resolveParts(t.writers, `${where}.writers`), readers = resolveParts(t.readers, `${where}.readers`);
    const note = fixedText(t.note, `${where}.note`, false);
    const writerCount = distinct(writers).length;
    outTargets.push({
      id: t.id, name: name || t.id, kind: t.kind, policy: t.policy, ...(note ? { note } : {}),
      node: byId.has(t.external) ? 'n:' + t.external : null, writers, readers, writerCount,
      conflict: t.policy === 'single-writer' && writerCount > 1, undeclared: [],
    });
  });
  // draw them: part -> target, as a write or a read
  for (const t of outTargets) if (t.node) for (const [list, k] of [[t.writers, 'write'], [t.readers, 'read']]) for (const e of list) for (const x of e.items) if (!inside(x, t.node)) addLink(x, t.node, k, { label: t.name });
  // calls into a target's box the scan saw (web requests to its hosts, imports of its packages) from a part the list
  // doesn't name, tests left out; the HTTP method, where the code shows it, says whether it writes or reads
  const seen = [];
  for (const e of scan.extEdges) { if (!includedSet.has(e.from)) continue; const m = pkgMatchers.find((pm) => pm.globs.some((g) => g.test(e.pkg))); if (m) seen.push({ file: e.from, node: 'n:' + m.id, line: 1, method: null }); }
  for (const h of scan.hosts) { if (!includedSet.has(h.from)) continue; const m = hostMatchers.find((hm) => hm.globs.some((g) => g.test(h.host))); if (m) seen.push({ file: h.from, node: 'n:' + m.id, line: h.line || 1, method: h.method || null }); }
  const isTest = (p) => TEST_FILE.test(p) || lineage('f:' + p).some((id) => byId.get(id)?.kind === 'test');
  for (const node of new Set(outTargets.map((t) => t.node).filter(Boolean))) {
    const listed = outTargets.filter((t) => t.node === node).flatMap((t) => [...t.writers, ...t.readers].flatMap((e) => e.items));
    const byPart = new Map();
    for (const c of seen) {
      if (c.node !== node || isTest(c.file) || listed.some((y) => inside('f:' + c.file, y))) continue;
      const part = owner.get(c.file) && owner.get(c.file) !== 'unassigned' ? 'n:' + owner.get(c.file) : 'f:' + c.file;
      if (!byPart.has(part)) byPart.set(part, []);
      const calls = byPart.get(part);
      if (!calls.some((x) => x.file === c.file && x.line === c.line && x.method === c.method)) calls.push({ file: c.file, line: c.line, method: c.method });
    }
    const undeclared = [...byPart].map(([part, calls]) => ({
      part, dir: calls.some((c) => /^(POST|PUT|PATCH|DELETE)$/.test(c.method)) ? 'write' : calls.some((c) => /^(GET|HEAD)$/.test(c.method)) ? 'read' : 'unknown',
      calls: calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    }));
    for (const t of outTargets) if (t.node === node) t.undeclared = undeclared;
  }
}

// ---------- rules and decisions (floorplan/rules.json) ----------
// The project's rules ("one writer per target", "the AI delivers data, the code decides") and its dated decisions
// ("since 26 Oct the lead merges when CI is green"), each with the place it is written down, hung on the parts, files,
// endpoints and targets they apply to. Floorplan never makes one up: the file is written from what the project
// documents, and the build only checks it, like targets.json (an unknown ref is an error with a "did you mean"), and
// resolves each ref to its cards. A rule with no refs applies to the whole project. A retired rule keeps its history;
// one that still names places is a minor Health finding (lib/health.mjs). The map shows the list under a Rules button
// and on each card the rules that apply to it (ui/38-rules.js); MAP.md gets a Rules section.
const RULE_KINDS = ['rule', 'decision'];
const RULE_STATUSES = ['active', 'retired'];
const RULE_FIELDS = ['id', 'kind', 'title', 'text', 'applies', 'source', 'since', 'until', 'status', 'tags'];
const rulesFile = path.join(outDir, 'rules.json');
let ruleList = null;
if (fs.existsSync(rulesFile)) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(rulesFile, 'utf8')); } catch (e) { err(`rules.json is not valid JSON: ${e.message}`); }
  if (raw !== null) {
    ruleList = Array.isArray(raw) ? raw : Array.isArray(raw?.rules) ? raw.rules : null;
    if (!ruleList) err('rules.json must be a list of rules, or { "rules": [ … ] }');
  }
}
const outRules = [];
if (ruleList?.length) {
  const routeIdx = new Map(routesIn.map((r, i) => [routeKey(r), i]));
  const targetIds = outTargets.map((t) => t.id);
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const date = (v, where) => {
    if (v === undefined || v === null) return null;
    if (!isStr(v) || !DATE.test(v) || Number.isNaN(Date.parse(v))) { err(`${where} "${v}" must be a date like 2026-10-25`); return null; }
    return v;
  };
  // where a rule applies: a part id, "METHOD /path", a file path or glob (a glob that covers a whole part stands for
  // the part), or a target id, which puts the rule on the target's box. A part id wins over a target with the same id.
  const resolveRef = (s, w) => {
    if (!isStr(s)) { err(`${w} must be a part id, a file path or glob, "METHOD /path" or a target id`); return []; }
    if (byId.has(s)) return ['n:' + s];
    const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(s.trim());
    if (m && routeIdx.has(`${m[1].toUpperCase()} ${m[2]}`)) return [`r:${routeIdx.get(`${m[1].toUpperCase()} ${m[2]}`)}`];
    const g = compileGlob(s);
    const hits = included.filter((f) => g.test(f.path)).map((f) => f.path);
    if (hits.length) return cover(hits);
    if (targetIds.includes(s)) return ['t:' + s];
    if (fileByPath.has(s)) { err(`${w} "${s}" is a file that is not on the map (category ${fileByPath.get(s).category})`); return []; }
    err(`${w} "${s}" is neither a part id, a path or glob that matches a file on the map, "METHOD /path" nor a target id${includedSet.has(movedTo.get(s)) ? ` — did you mean "${movedTo.get(s)}"? (it moved there)` : didYouMean(s, [...ids, ...targetIds, ...routeIdx.keys(), ...includedSet])}`);
    return [];
  };
  const seenIds = new Set();
  ruleList.forEach((r, i) => {
    const where = `rules.json rules[${i}]${isStr(r?.id) ? ` ("${r.id}")` : ''}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return err(`${where} must be an object`);
    // a misspelt field would silently change what a rule means ("apply" instead of "applies" reads as "everywhere")
    for (const k of Object.keys(r)) if (!RULE_FIELDS.includes(k) && k !== '$schema') err(`${where}: unknown field "${k}"${didYouMean(k, RULE_FIELDS)}`);
    if (!isStr(r.id)) err(`${where}.id is required`);
    else if (!/^[A-Za-z0-9_.\-]+$/.test(r.id)) err(`${where}.id may only use letters, digits, "_", "-" and "."`);
    else if (seenIds.has(r.id)) err(`${where}.id duplicates an earlier rule`);
    seenIds.add(r.id);
    if (!RULE_KINDS.includes(r.kind)) err(`${where}.kind "${r.kind}" must be "rule" or "decision"${didYouMean(String(r.kind), RULE_KINDS)}`);
    const title = fixedText(r.title, `${where}.title`, true), text = fixedText(r.text, `${where}.text`, true);
    if (!isStr(r.source)) err(`${where}.source is required: where the rule is written down (a file and its section, a decision log, who said it and when)`);
    const since = date(r.since, `${where}.since`), until = date(r.until, `${where}.until`);
    if (r.status !== undefined && !RULE_STATUSES.includes(r.status)) err(`${where}.status "${r.status}" must be "active" or "retired"${didYouMean(String(r.status), RULE_STATUSES)}`);
    if (r.tags !== undefined && !isStrArr(r.tags)) err(`${where}.tags must be an array of strings`);
    let items = [];
    if (r.applies !== undefined && !Array.isArray(r.applies)) err(`${where}.applies must be a list of part ids, file paths or globs, "METHOD /path" or target ids (an empty list means the whole project)`);
    else for (const [j, s] of (r.applies || []).entries()) for (const item of resolveRef(s, `${where}.applies[${j}]`)) if (!items.includes(item)) items.push(item);
    outRules.push({
      id: isStr(r.id) ? r.id : `rule-${i}`, kind: RULE_KINDS.includes(r.kind) ? r.kind : 'rule', title: title || '', text: text || '',
      source: isStr(r.source) ? r.source.trim() : '', since, until, status: r.status === 'retired' ? 'retired' : 'active',
      ...(isStrArr(r.tags) && r.tags.length ? { tags: r.tags } : {}), items,
    });
  });
}

// ---------- schedules (the scan + floorplan/schedules.json): what a clock starts ----------
// The scan finds schedules in the files that hold them (GitHub Actions, Vercel crons, n8n triggers, crontabs, ofelia
// labels; lib/schedules.mjs). floorplan/schedules.json adds what the scan can't see and, by id, overrides a find field by
// field (a better title, the parts it runs, "enabled": false). Refs in `runs` are checked like rules.json; a `calls`
// that names an endpoint on the map counts as a run too. Each plan gets its cron in words in the map's language
// (lib/cron-text.mjs), the start minutes of one day for the Clock's strip, and an `event` edge from its trigger to what
// it runs when both are on the map. The map shows them under a Clock button (ui/28-clock.js); MAP.md gets a section.
const SCHEDULE_FIELDS = ['id', 'title', 'cron', 'human', 'tz', 'trigger', 'runs', 'calls', 'note', 'source', 'enabled'];
const schedulesFile = path.join(outDir, 'schedules.json');
let scheduleList = null;
if (fs.existsSync(schedulesFile)) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(schedulesFile, 'utf8')); } catch (e) { err(`schedules.json is not valid JSON: ${e.message}`); }
  if (raw !== null) {
    scheduleList = Array.isArray(raw) ? raw : Array.isArray(raw?.schedules) ? raw.schedules : null;
    if (!scheduleList) err('schedules.json must be a list of schedules, or { "schedules": [ … ] }');
  }
}
const outSchedules = [];
{
  const routeIdx = new Map(routesIn.map((r, i) => [routeKey(r), i]));
  const targetIds = outTargets.map((x) => x.id);
  const targetBox = new Map(outTargets.map((x) => [x.id, x.node]));
  const allPaths = new Set(filesAll.map((f) => f.path));
  const tw = (k, vars) => fill(words[k] ?? k, vars);
  // what a plan runs: a part id, "METHOD /path", a file path or glob, or a target id (the rule's own form, "t:<id>")
  const resolveRun = (s, w) => {
    if (!isStr(s)) { err(`${w} must be a part id, a file path or glob, "METHOD /path" or a target id`); return []; }
    if (byId.has(s)) return ['n:' + s];
    const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(s.trim());
    if (m && routeIdx.has(`${m[1].toUpperCase()} ${m[2]}`)) return [`r:${routeIdx.get(`${m[1].toUpperCase()} ${m[2]}`)}`];
    const g = compileGlob(s);
    const hits = included.filter((f) => g.test(f.path)).map((f) => f.path);
    if (hits.length) return cover(hits);
    if (targetIds.includes(s)) return ['t:' + s];
    if (fileByPath.has(s)) { err(`${w} "${s}" is a file that is not on the map (category ${fileByPath.get(s).category})`); return []; }
    err(`${w} "${s}" is neither a part id, a path or glob that matches a file on the map, "METHOD /path" nor a target id${includedSet.has(movedTo.get(s)) ? ` — did you mean "${movedTo.get(s)}"? (it moved there)` : didYouMean(s, [...ids, ...targetIds, ...routeIdx.keys(), ...includedSet])}`);
    return [];
  };
  // what starts a plan: a part, a file on the map or an endpoint, as its card; a file the scan saw but the map doesn't
  // show (a workflow or crontab is config) stays as its path, so the plan still says where it comes from
  const resolveTrigger = (s, w) => {
    if (!isStr(s)) { err(`${w} must be a part id, a file path or "METHOD /path"`); return null; }
    const v = s.trim().replace(/^\.\//, '');
    if (byId.has(v)) return 'n:' + v;
    if (includedSet.has(v)) return 'f:' + v;
    const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(v);
    if (m && routeIdx.has(`${m[1].toUpperCase()} ${m[2]}`)) return `r:${routeIdx.get(`${m[1].toUpperCase()} ${m[2]}`)}`;
    if (allPaths.has(v)) return v;
    err(`${w} "${s}" is neither a part id, a scanned file nor "METHOD /path"${includedSet.has(movedTo.get(v)) ? ` — did you mean "${movedTo.get(v)}"? (it moved there)` : didYouMean(v, [...ids, ...allPaths, ...routeIdx.keys()])}`);
    return null;
  };
  const merged = new Map();
  for (const s of Array.isArray(scan.schedules) ? scan.schedules : []) merged.set(s.id, { ...s, kind: s.kind || null, found: true, trigger: s.trigger ? (includedSet.has(s.trigger) ? 'f:' + s.trigger : s.trigger) : null, runs: [] });
  const seenIds = new Set();
  (scheduleList || []).forEach((e, i) => {
    const where = `schedules.json schedules[${i}]${isStr(e?.id) ? ` ("${e.id}")` : ''}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return err(`${where} must be an object`);
    for (const k of Object.keys(e)) if (!SCHEDULE_FIELDS.includes(k) && k !== '$schema') err(`${where}: unknown field "${k}"${didYouMean(k, SCHEDULE_FIELDS)}`);
    if (!isStr(e.id)) return err(`${where}.id is required`);
    if (!/^[A-Za-z0-9_.\-]+$/.test(e.id)) err(`${where}.id may only use letters, digits, "_", "-" and "."`);
    if (seenIds.has(e.id)) err(`${where}.id duplicates an earlier schedule`);
    seenIds.add(e.id);
    const base = merged.get(e.id);
    const over = {};
    // a new plan needs a title and a cron (or words); an override of a find needs only what it changes
    const title = fixedText(e.title, `${where}.title`, !base);
    if (title) over.title = title;
    if (e.cron !== undefined) { if (!isStr(e.cron)) err(`${where}.cron must be a cron expression like "30 2 * * *"`); else { over.cron = e.cron.trim(); over.interval = undefined; } }
    const human = fixedText(e.human, `${where}.human`, false);
    if (human) over.human = human;
    if (!base && !isStr(e.cron) && !human) err(`${where} needs "cron" (five fields, like "30 2 * * *") or "human" (the schedule in words)`);
    if (e.tz !== undefined) {
      if (!isStr(e.tz)) err(`${where}.tz must be a time zone name like "Europe/Berlin"`);
      else { over.tz = e.tz.trim(); try { new Intl.DateTimeFormat('en', { timeZone: e.tz.trim() }); } catch { warn(`${where}.tz "${e.tz}" is not a time zone this Node knows; shown as written`); } }
    }
    if (e.trigger !== undefined) { const ref = resolveTrigger(e.trigger, `${where}.trigger`); if (ref) over.trigger = ref; }
    if (e.runs !== undefined) {
      if (!Array.isArray(e.runs)) err(`${where}.runs must be a list of part ids, file paths or globs, "METHOD /path" or target ids`);
      else { over.runs = []; e.runs.forEach((s, j) => { for (const item of resolveRun(s, `${where}.runs[${j}]`)) if (!over.runs.includes(item)) over.runs.push(item); }); }
    }
    if (e.calls !== undefined) { if (!isStr(e.calls)) err(`${where}.calls must be text, like "POST /reports/run" or a command`); else over.calls = e.calls.trim(); }
    const note = fixedText(e.note, `${where}.note`, false);
    if (note) over.note = note;
    if (e.source !== undefined) { if (!isStr(e.source)) err(`${where}.source must be text: where the schedule is written down`); else over.source = e.source.trim(); }
    if (e.enabled !== undefined) { if (typeof e.enabled !== 'boolean') err(`${where}.enabled must be true or false`); else over.enabled = e.enabled; }
    merged.set(e.id, { ...(base || { id: e.id, kind: null, found: false, runs: [] }), ...over, declared: true });
  });
  for (const s of merged.values()) {
    const where = s.found && !s.declared ? `${s.source} ("${s.id}")` : `schedules.json ("${s.id}")`;
    const parsed = s.cron ? parseCron(s.cron) : null;
    if (s.cron && !parsed) warn(`${where}: cron "${s.cron}" is not a five-field cron expression (minute hour day month weekday); shown as written`);
    const interval = isInterval(s.interval) ? s.interval : null;
    const enabled = s.enabled !== false;
    const human = s.human || (parsed ? cronWords(parsed, tw, lang) : null) || (interval ? intervalWords(interval, tw) : null) || s.cron || '';
    const times = !enabled ? [] : parsed ? cronTimes(parsed) : intervalTimes(interval);
    // an endpoint the plan calls is on the map: that's what it runs
    const runs = [...s.runs];
    for (const call of String(s.calls || '').split(' · ')) {
      const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(call.trim());
      const r = m && routeIdx.has(`${m[1].toUpperCase()} ${m[2]}`) ? `r:${routeIdx.get(`${m[1].toUpperCase()} ${m[2]}`)}` : null;
      if (r && !runs.includes(r)) runs.push(r);
    }
    outSchedules.push({
      id: s.id, title: s.title || s.id, cron: s.cron || null, tz: s.tz || null, human, trigger: s.trigger || null, runs,
      calls: s.calls || null, note: s.note || null, source: s.source || null, kind: s.kind || null, found: !!s.found, enabled, times,
    });
    // the clock on the board: an event from the trigger to each thing it runs, when both have a card
    const from = s.trigger && /^[nfr]:/.test(s.trigger) ? s.trigger : null;
    if (!enabled || !from) continue;
    for (const item of runs) {
      const to = item.startsWith('t:') ? targetBox.get(item.slice(2)) : item;
      if (to) addLink(from, to, 'event', { label: s.cron ? `cron ${s.cron}` : human, w: 1 });
    }
  }
}

// ---------- layers (floorplan/layers.json): system, setup and content ----------
// Which files are the system the owner could one day publish, which are the setup of this one installation (key
// names, ids, paths, calendars) and which are the owner's content (customers, amounts, mails). Each file takes the
// layer of the first pattern it matches, in the order of the list, else the default ("system" unless set); a part
// takes the layer more than half of its files have, else "mixed". With layers, Health also checks what would keep
// the system from being published (lib/layers.mjs). Its private word list lives outside the repo: it's read here and
// handed to Health, and no word from it is written anywhere.
const layersFile = path.join(outDir, 'layers.json');
let layers = null; // { list, def, layerOf, words, wordsStatus, wordsFile }
if (fs.existsSync(layersFile)) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(layersFile, 'utf8')); } catch (e) { err(`layers.json is not valid JSON: ${e.message}`); }
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) err('layers.json must be an object: { "layers": [ … ], "default": "system" }');
  else if (raw !== undefined) {
    const FIELDS = ['layers', 'default', 'privateWords'];
    for (const k of Object.keys(raw)) if (!FIELDS.includes(k) && k !== '$schema') err(`layers.json: unknown field "${k}"${didYouMean(k, FIELDS)}`);
    if (!Array.isArray(raw.layers) || !raw.layers.length) err('layers.json "layers" must be a list of layers, like [{ "id": "config", "patterns": ["config/**"] }]');
    const list = [];
    (Array.isArray(raw.layers) ? raw.layers : []).forEach((l, i) => {
      const where = `layers.json layers[${i}]${isStr(l?.id) ? ` ("${l.id}")` : ''}`;
      if (!l || typeof l !== 'object' || Array.isArray(l)) return err(`${where} must be an object`);
      if (!LAYER_IDS.includes(l.id)) return err(`${where}.id ${l.id === undefined ? 'is required, one' : `"${l.id}" must be one`} of ${LAYER_IDS.join(', ')}${didYouMean(String(l.id ?? ''), LAYER_IDS)}`);
      if (list.some((x) => x.id === l.id)) return err(`${where}.id duplicates an earlier layer`);
      if (!isStrArr(l.patterns) || l.patterns.some((p) => !p.trim())) err(`${where}.patterns must be a list of globs, relative to the codebase root (an empty list is fine)`);
      const name = fixedText(l.name, `${where}.name`, false), description = fixedText(l.description, `${where}.description`, false);
      list.push({ id: l.id, ...(name ? { name } : {}), ...(description ? { description } : {}), patterns: isStrArr(l.patterns) ? l.patterns.filter((p) => p.trim()) : [], where });
    });
    // a pattern that matches nothing is likely a typo, or code that moved
    for (const l of list) l.patterns.forEach((p, j) => { const g = compileGlob(p); if (!filesAll.some((f) => g.test(f.path))) warn(`${l.where}.patterns[${j}] "${p}" matches no file`); });
    const def = raw.default === undefined ? 'system' : raw.default;
    if (!LAYER_IDS.includes(def)) err(`layers.json default "${def}" must be one of ${LAYER_IDS.join(', ')}${didYouMean(String(def), LAYER_IDS)}`);
    else if (!list.some((x) => x.id === def)) list.push({ id: def, patterns: [] }); // the default needs no patterns of its own
    // the private word list: a path relative to the codebase root, or absolute (~ is the home folder); a blueprint has no code to check
    let words = null, wordsStatus = 'unset', wordsFile = null;
    if (raw.privateWords !== undefined && !isStr(raw.privateWords)) err('layers.json privateWords must be the path to your private word list (relative to the codebase root, or absolute)');
    else if (isStr(raw.privateWords) && !scan.blueprint) {
      const abs = path.resolve(root, raw.privateWords.replace(/^~(?=$|[\\/])/, () => os.homedir()));
      let text = null;
      try { text = fs.readFileSync(abs, 'utf8'); } catch {}
      if (text === null) {
        wordsStatus = 'missing';
        warn(`layers.json privateWords: there is no file at ${raw.privateWords}, so the private-word check was skipped. Keep the list outside the repo, one word or name per line.`);
      } else {
        const parsed = parseWords(text);
        words = parsed.words;
        wordsStatus = words.length ? 'checked' : 'empty';
        if (parsed.short) warn(`the private word list has ${parsed.short} entr${parsed.short === 1 ? 'y' : 'ies'} under two characters, left out (they would match almost anywhere)`);
        // inside the project, the list must at least be ignored by git; floorplan/ ignores itself
        const rel = path.relative(root, abs);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          wordsFile = toPosix(rel);
          const inMapDir = !path.relative(outDir, abs).startsWith('..');
          if (!inMapDir && git(path.dirname(abs), ['check-ignore', '-q', abs]) === null) warn(`layers.json privateWords points inside the project (${wordsFile}), and git doesn't ignore it. Keep the word list outside the repo, so it's never committed or shared.`);
        }
      }
    }
    layers = { list, def: LAYER_IDS.includes(def) ? def : 'system', words, wordsStatus, wordsFile };
    layers.layerOf = layerAssigner(list, layers.def);
  }
}
// how many files of each layer every part holds, its own and its children's
const layerCounts = new Map();
if (layers) for (const f of included) {
  const l = layers.layerOf(f.path), seen = new Set();
  for (let id = owner.get(f.path); id && !seen.has(id); id = id === 'unassigned' ? null : byId.get(id)?.parent) {
    seen.add(id);
    if (!layerCounts.has(id)) layerCounts.set(id, {});
    layerCounts.get(id)[l] = (layerCounts.get(id)[l] || 0) + 1;
  }
}
const layerOfPart = (id) => (layerCounts.has(id) ? { layer: majority(layerCounts.get(id)), layers: layerCounts.get(id) } : {});

// ---------- operations (floorplan/ops.json): what the owner's tooling reports about the running system ----------
// A status, version and last runs per part, file, endpoint or target, written by the owner's own scripts (a cron, a
// pipeline), never by the build or the AI, which know nothing about what runs. Like recent work it's an overlay: a ref
// that isn't on the map is left out with a warning, a bad field is a warning, and a file older than a day is reported,
// so a machine-written file never breaks a build. The map shows it under an Ops switch (ui/27-ops.js).
const OPS_STATUSES = ['ok', 'warn', 'down', 'unknown'];
const OPS_STALE_MS = 24 * 60 * 60 * 1000;
let outOps = null;
const opsFile = path.join(outDir, 'ops.json');
if (fs.existsSync(opsFile)) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(opsFile, 'utf8')); } catch (e) { warn(`ops.json is not valid JSON: ${e.message}`); }
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) { warn('ops.json must be an object: { "asOf": "…", "items": [ … ] }'); raw = null; }
  if (raw) {
    // when the file was written: required, and the file's own modification time when it's missing or unreadable
    let asOf = isStr(raw.asOf) && !Number.isNaN(Date.parse(raw.asOf)) ? raw.asOf : null;
    if (!asOf) { warn(`ops.json ${isStr(raw.asOf) ? `"asOf" "${raw.asOf}" is not a date (ISO 8601, like 2026-11-01T04:00:00+01:00)` : 'needs "asOf", the time it was written (ISO 8601)'}; using the file's modification time`); asOf = fs.statSync(opsFile).mtime.toISOString(); }
    const stale = Date.now() - Date.parse(asOf) > OPS_STALE_MS;
    if (stale) warn(`ops.json is stale: as of ${asOf}, more than 24 hours ago. Check that the script that writes it still runs.`);
    const routeIdx = new Map(routesIn.map((r, i) => [routeKey(r), i]));
    const targetBox = new Map(outTargets.map((x) => [x.id, x.node]));
    const resolveOps = (ref) => {
      if (!isStr(ref)) return null;
      const s = ref.trim().replace(/^\.\//, '').replace(/^(route:|file:)/, '');
      if (/^n:/.test(s)) return byId.has(s.slice(2)) ? s : null;
      if (/^f:/.test(s)) return includedSet.has(s.slice(2)) ? s : null;
      if (byId.has(s)) return 'n:' + s;
      if (includedSet.has(s)) return 'f:' + s;
      const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(s);
      if (m && routeIdx.has(`${m[1].toUpperCase()} ${m[2]}`)) return `r:${routeIdx.get(`${m[1].toUpperCase()} ${m[2]}`)}`;
      return targetBox.get(s) || null; // a target's box; a target without one has nothing to mark
    };
    const items = [], missing = [], bad = [];
    const oneLine = (v) => String(v).split('\n')[0].trim().slice(0, 300);
    if (!Array.isArray(raw.items)) warn('ops.json needs an "items" list');
    else raw.items.forEach((it, i) => {
      const where = `ops.json items[${i}]`;
      if (!it || typeof it !== 'object' || Array.isArray(it)) return bad.push(`${where} must be an object with a "ref"`);
      const id = resolveOps(it.ref);
      if (!id) return missing.push(it.ref === undefined ? `${where} (no ref)` : String(it.ref));
      if (it.status !== undefined && !OPS_STATUSES.includes(it.status)) bad.push(`${where}.status "${it.status}" is not one of ${OPS_STATUSES.join(', ')}; shown as unknown`);
      const out = { id, ref: it.ref.trim(), status: OPS_STATUSES.includes(it.status) ? it.status : 'unknown' };
      for (const k of ['version', 'lastRun', 'lastOk', 'lastError', 'note']) {
        if (it[k] === undefined || it[k] === null || it[k] === '') continue;
        if (typeof it[k] !== 'string' && typeof it[k] !== 'number') { bad.push(`${where}.${k} must be text`); continue; }
        if (/^last(Run|Ok)$/.test(k) && Number.isNaN(Date.parse(String(it[k])))) bad.push(`${where}.${k} "${oneLine(it[k])}" is not a date (ISO 8601)`);
        if (oneLine(it[k])) out[k] = oneLine(it[k]);
      }
      if (it.metrics !== undefined) {
        if (!it.metrics || typeof it.metrics !== 'object' || Array.isArray(it.metrics)) bad.push(`${where}.metrics must be an object of label → number or short text`);
        else {
          const metrics = {};
          for (const [k, v] of Object.entries(it.metrics).slice(0, 12)) if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') metrics[oneLine(k).slice(0, 40)] = typeof v === 'string' ? oneLine(v).slice(0, 80) : v;
          if (Object.keys(metrics).length) out.metrics = metrics;
        }
      }
      items.push(out);
    });
    if (missing.length) warn(`ops.json: ${missing.length} ref(s) aren't on the map and were left out (use a node id, a file path, "METHOD /path" or a target id with a box): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
    for (const b of bad.slice(0, 10)) warn(b);
    if (bad.length > 10) warn(`ops.json: ${bad.length - 10} more field(s) with problems`);
    const counts = Object.fromEntries(OPS_STATUSES.map((s) => [s, items.filter((x) => x.status === s).length]));
    outOps = { asOf, source: isStr(raw.source) ? oneLine(raw.source) : null, stale, counts, items };
  }
}

// ---------- report ----------
const pct = included.length ? (unassigned.length / included.length) * 100 : 0;
const report = [];
if (errors.length) {
  report.push(`✗ ${errors.length} error(s) in ${path.relative(root, archFile)}${scan.blueprint ? ' or plan.json' : ''}${['names.json', 'targets.json', 'rules.json', 'schedules.json', 'layers.json'].filter((f) => errors.some((e) => e.startsWith(f))).map((f) => ` or ${f}`).join('')}:`);
  for (const e of errors) report.push(`  - ${e}`);
}
if (warnings.length) {
  report.push(`! ${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, 40)) report.push(`  - ${w}`);
}
report.push('');
report.push(`ASSIGNMENT  ${included.length} files (${include.join('+')}), ${unassigned.length} unassigned (${pct.toFixed(1)}%)`);
for (const n of nodes.filter((n) => n?.id && !n.parent)) {
  const s = stats.get(n.id);
  report.push(`  ${n.id.padEnd(28)} ${String(s.files).padStart(5)} files ${scan.blueprint ? '' : `${fmtNum(s.loc).padStart(6)} loc  `}[${n.kind}]`);
}
if (unassigned.length) {
  const byDir = new Map();
  for (const f of unassigned) { const d = f.path.split('/').slice(0, -1).join('/') || '.'; byDir.set(d, (byDir.get(d) || 0) + 1); }
  report.push(`  unassigned, by directory:`);
  for (const [d, c] of [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) report.push(`    ${String(c).padStart(4)}  ${d}/`);
}
const byKind = {};
for (const l of links.values()) byKind[l.k] = (byKind[l.k] || 0) + 1;
report.push(`LINKS  ${[...links.values()].length} (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')})`);
const describedFiles = included.filter((f) => fileDesc.get(f.path)?.d || f.desc).length;
const describedRoutes = routesIn.filter((r) => routeDesc.get(routeKey(r))?.d || r.desc).length;
const noSummary = nodes.filter((n) => n?.id && !isStr(n.summary) && !fixedParts.get(n.id)?.d).map((n) => n.id);
const reviewCount = [...fileDesc.values(), ...routeDesc.values()].filter((d) => d.review).length;
report.push(`DESCRIPTIONS  files ${describedFiles}/${included.length} · routes ${describedRoutes}/${routesIn.length} · modules ${nodes.length - noSummary.length}/${nodes.length}${reviewCount ? ` · ${reviewCount} need review (code changed)` : ''}`);
if (noSummary.length) report.push(`  modules without a summary: ${noSummary.slice(0, 12).join(', ')}${noSummary.length > 12 ? '…' : ''}`);
if (describedFiles < included.length || describedRoutes < routesIn.length || reviewCount) report.push(`  Run describe.mjs to get worksheets for the ${included.length - describedFiles} file(s) and ${routesIn.length - describedRoutes} route(s) still missing descriptions.`);
const nFixed = fixedParts.size + fixedFiles.size + fixedRoutes.size;
if (nFixed) report.push(`NAMES  ${nFixed} fixed in names.json (${[[fixedParts.size, 'part'], [fixedFiles.size, 'file'], [fixedRoutes.size, 'endpoint']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(', ')})`);

if (errors.length) { console.log(report.join('\n')); console.log('\nFix the errors above and run build again.'); process.exit(1); }
if (args.check) { console.log(report.join('\n')); process.exit(0); }

// ---------- write graph.json + index.html ----------
const graph = {
  schema: 'floorplan/graph@1',
  meta: {
    generatedAt: new Date().toISOString(), scanAt: scan.generatedAt, rootName: scan.rootName, root: scan.root,
    audience, agent, lang,
    ...(scan.blueprint ? { blueprint: { source: scan.blueprint.source, stack: scan.blueprint.stack, assumptions: scan.blueprint.assumptions } } : {}),
    repos: scan.repos.map(({ path: p, name, branch, head, remote }) => ({ path: p, name, branch, head, remote })),
    counts: { files: included.length, loc: included.reduce((s, f) => s + f.loc, 0), unassigned: unassigned.length },
  },
  project: arch.project,
  nodes: [
    ...nodes.map((n) => {
      const fx = fixedParts.get(n.id);
      return {
        id: n.id, parent: n.parent || null, label: fx?.name || n.label, kind: n.kind, summary: fx?.d || n.summary || '', details: n.details || '',
        tags: n.tags || [], paths: n.paths || [], packages: n.packages || [], hosts: n.hosts || [],
        stats: { ...stats.get(n.id), repos: [...stats.get(n.id).repos] },
        ...(fx ? { fixed: fx.fixed } : {}),
        ...layerOfPart(n.id),
      };
    }),
    ...(unassigned.length ? [{ id: 'unassigned', parent: null, label: words['unassigned.label'], kind: 'misc', summary: words['unassigned.summary'], details: '', tags: [], paths: [], packages: [], hosts: [], stats: { ...stats.get('unassigned'), repos: [...stats.get('unassigned').repos] }, ...layerOfPart('unassigned') }] : []),
  ],
  files: included.map((f) => {
    const d = fileDesc.get(f.path);
    return {
      p: f.path, n: owner.get(f.path), r: f.repo, l: f.lang || f.category, loc: f.loc,
      name: d?.name || f.name || fallbackFileName(f.path), d: d?.d || f.desc || f.doc || '', ...(d?.d || f.desc ? {} : { auto: true }),
      ...(f.doc ? { doc: f.doc } : {}),
      ...(f.tooLarge ? { tooLarge: true } : {}),
      ...(d?.review ? { review: d.review } : {}),
      ...(d?.fixed ? { fixed: d.fixed } : {}),
      ...(f.h ? { h: f.h, sig: f.sig } : {}),
      ...(f.symbols ? { s: f.symbols.map((s) => [s.name, s.kind, s.line, s.default ? 1 : 0, s.doc || '']) } : {}),
      ...(notes.has(f.path) ? notes.get(f.path) : {}),
      ...(layers ? { layer: layers.layerOf(f.path) } : {}),
    };
  }),
  routes: routesIn.map((r) => {
    const d = routeDesc.get(routeKey(r));
    return { f: r.file, m: r.method, p: r.path, l: r.line, h: r.handler || null, name: d?.name || r.name || fallbackRouteName(r), d: d?.d || r.desc || r.doc || '', ...(d?.d || r.desc ? {} : { auto: true }), ...(d?.review ? { review: d.review } : {}), ...(d?.fixed ? { fixed: d.fixed } : {}), ...(r.doc ? { doc: r.doc } : {}), ...(r.access ? { access: r.access } : {}), ...(r.who ? { who: r.who } : {}), ...(r.publicBecause ? { publicBecause: r.publicBecause } : {}) };
  }),
  links: [...links.values()],
  flows: outFlows,
  tour: outTour,
  ...(outTargets.length ? { targets: outTargets } : {}),
  // the project's rules and decisions, each resolved to the cards it applies to (a target as "t:<id>")
  ...(outRules.length ? { rules: outRules } : {}),
  // what a clock starts: the scan's finds and schedules.json, merged, each with its words and the start minutes of a day
  ...(outSchedules.length ? { schedules: outSchedules } : {}),
  // the layers as the map shows them (never the private words, which only Health gets)
  ...(layers ? { layers: {
    list: layers.list.map(({ where, ...l }) => ({ ...l, files: included.filter((f) => layers.layerOf(f.path) === l.id).length })),
    default: layers.def, mixed: [...layerCounts.values()].filter((c) => majority(c) === 'mixed').length,
  } } : {}),
  ...(outRecent?.items.length ? { recent: outRecent } : {}),
  // what the owner's tooling reports about the running system (never in MAP.md: it changes with every run)
  ...(outOps?.items.length ? { ops: outOps } : {}),
};
// extension hooks, computed from the finished graph plus the raw scan
// a blueprint has no code to check, so its Health is a design review of the plan (computed after screens)
if (!scan.blueprint) try { graph.health = buildHealth({ graph, scan, arch, root, layers }); } catch (e) { warn(`health check failed: ${e.message}`); graph.health = { issues: [] }; }
try { graph.screens = buildScreens({ graph, scan, arch, root }); } catch (e) { warn(`screen detection failed: ${e.message}`); graph.screens = []; }
if (scan.blueprint) try { graph.health = buildPlanHealth({ graph, scan }); } catch (e) { warn(`design review failed: ${e.message}`); graph.health = { issues: [] }; }
fs.mkdirSync(outDir, { recursive: true });
const trackedWarning = keepOutOfGit(outDir, gitMode);
fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify(graph, null, 0));

// The page's own words, in the chosen language: {{t:key}} in viewer.html's markup is filled in here, and the
// table goes into the page for t() in its scripts (only this language, so the map stays one self-contained file).
const template = fs.readFileSync(path.join(SKILL_DIR, 'assets', 'viewer.html'), 'utf8')
  .replace(/\{\{t:([\w.-]+)\}\}/g, (_, k) => (k in words ? escapeHtml(words[k]) : fail(`viewer.html uses "${k}", which assets/lang/en.json doesn't have`)))
  .replace('__FLOORPLAN_HTML_LANG__', lang)
  .replace('/*__FLOORPLAN_STRINGS__*/null', () => JSON.stringify({ lang, strings: words }).replace(/<\/(script)/gi, '<\\/$1').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
// The layout engine (elkjs 0.9.3) and fonts (Inter, JetBrains Mono) are bundled in assets/vendor/ and
// inlined, so the map makes no outside requests and works offline.
const vendor = path.join(SKILL_DIR, 'assets', 'vendor');
const elkTag = `<script>${fs.readFileSync(path.join(vendor, 'elk.bundled.js'), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`;
const FONT_RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};
const fontCss = [['Inter', 'inter'], ['JetBrains Mono', 'jetbrains-mono']].flatMap(([family, file]) => Object.entries(FONT_RANGES).map(([subset, range]) =>
  `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:100 900;unicode-range:${range};src:url(data:font/woff2;base64,${fs.readFileSync(path.join(vendor, 'fonts', `${file}-${subset}-wght-normal.woff2`)).toString('base64')}) format("woff2")}`)).join('\n');
const graphQuery = fs.readFileSync(path.join(SKILL_DIR, 'assets', 'graph-query.js'), 'utf8');
const page = (g) => template
  .replace('/*__GRAPH_QUERY__*/', () => graphQuery.replace(/<\/script/gi, '<\\/script'))
  .replace('<!--__ELK_SCRIPT__-->', () => elkTag)
  .replace('/*__FONTS__*/', () => fontCss)
  .replace('/*__FLOORPLAN_DATA__*/null', () => JSON.stringify(g).replace(/<\/(script)/gi, '<\\/$1').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'))
  .replace(/__FLOORPLAN_TITLE__/g, () => escapeHtml(fill(words['app.title'], { name: arch.project.name })))
  .replace(/__FLOORPLAN_LOGO__/g, () => dataUri('logo.png'))
  .replace(/__FLOORPLAN_FAVICON__/g, () => dataUri('favicon.png'))
  .replace('<!--__UI_EXTENSIONS__-->', () => uiScripts);
const uiDir = path.join(SKILL_DIR, 'assets', 'ui');
const uiScripts = fs.existsSync(uiDir) ? fs.readdirSync(uiDir).filter((n) => n.endsWith('.js')).sort().map((n) => `<script>/* ui/${n} */\n${fs.readFileSync(path.join(uiDir, n), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`).join('\n') : '';
const html = page(graph);
fs.writeFileSync(path.join(outDir, 'index.html'), html);
// --artifact: a copy to publish to the Claude app, without this machine's absolute path (editor links)
if (args.artifact) fs.writeFileSync(path.join(outDir, 'artifact.html'), page({ ...graph, meta: { ...graph.meta, root: null, agent: 'claude' } }));
// Self-contained helpers next to the map: ask questions through the Claude Code CLI or Codex (serve.mjs)
// and the graph lookups it hands to them (query.mjs). They need only Node, not this skill.
fs.writeFileSync(path.join(outDir, 'query.mjs'), `${graphQuery}
// ---- cli ----
${fs.readFileSync(path.join(SKILL_DIR, 'assets', 'query-cli.mjs'), 'utf8')}`);
fs.copyFileSync(path.join(SKILL_DIR, 'assets', 'serve.mjs'), path.join(outDir, 'serve.mjs'));
// a blueprint can be changed from the map: serve.mjs redraws it with this skill's plan.mjs and build.mjs
if (scan.blueprint) { fs.mkdirSync(path.join(outDir, '.cache'), { recursive: true }); fs.writeFileSync(path.join(outDir, '.cache', 'skill.json'), JSON.stringify({ dir: SKILL_DIR })); }
// MAP.md: the map as plain text for AI workers (lib/mapmd.mjs), in the map's language. It is written only when its text
// changes, not when only its "as of" line would, so a rebuild that changes nothing leaves the file (and a git diff of
// it) alone, also a day or a commit later.
const MAP_INPUTS = ['architecture.json', 'plan.json', 'names.json', 'targets.json', 'rules.json', 'schedules.json', 'layers.json', 'custom-flows.json'];
const mapFile = path.join(outDir, 'MAP.md');
let mapNote;
try {
  const inputs = [...MAP_INPUTS.filter((f) => fs.existsSync(path.join(outDir, f))), ...(fs.existsSync(descDir) && fs.readdirSync(descDir).some((n) => n.endsWith('.json')) ? ['descriptions/'] : [])];
  const mapText = buildMapMd(graph, { words, dir: toPosix(path.relative(root, outDir)) || '.', inputs });
  let state = 'written';
  try { state = withoutStamp(fs.readFileSync(mapFile, 'utf8')) === withoutStamp(mapText) ? 'unchanged' : 'updated'; } catch {}
  if (state !== 'unchanged') fs.writeFileSync(mapFile, mapText);
  mapNote = `${toPosix(path.relative(root, mapFile))} ${state} (${mapText.split('\n').length - 1} lines): the map as text for AI workers`;
} catch (e) { mapNote = `! could not write ${toPosix(path.relative(root, mapFile))}: ${e.message}`; }
// the logo and tab icon are inlined so the map stays one self-contained file
function dataUri(name) { return 'data:image/png;base64,' + fs.readFileSync(path.join(SKILL_DIR, 'assets', name)).toString('base64'); }
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

const hs = graph.health?.summary;
if (hs && (hs.high || hs.medium || hs.low)) {
  report.push(`${scan.blueprint ? 'DESIGN REVIEW' : 'HEALTH'}  ${hs.high} important · ${hs.medium} worth fixing · ${hs.low} minor`);
  for (const i of graph.health.issues.filter((x) => x.severity !== 'low' && x.group !== 'publish').slice(0, 8)) report.push(`  [${i.severity}] ${i.title}`);
}
if (graph.screens?.length) report.push(`SCREENS  ${graph.screens.length} detected`);
const nConflicts = outTargets.filter((t) => t.conflict).length;
if (outTargets.length) report.push(`TARGETS  ${outTargets.length}${nConflicts ? ` (${nConflicts} with more than one writer)` : ''}`);
if (graph.rules) {
  const n = graph.rules.filter((r) => r.kind === 'rule').length, m = graph.rules.length - n, k = graph.rules.filter((r) => r.status === 'retired').length;
  report.push(`RULES  ${n} rule${n === 1 ? '' : 's'}, ${m} decision${m === 1 ? '' : 's'}${k ? ` · ${k} retired` : ''}`);
} else report.push(`RULES  none${fs.existsSync(rulesFile) ? ' (nothing in rules.json)' : ' (no rules.json)'}`);
if (graph.schedules) {
  const list = graph.schedules, found = list.filter((s) => s.found).length, off = list.filter((s) => !s.enabled).length;
  // the next start of the day, each plan's clock read in its own time zone
  const minuteNow = (tz) => { try { const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()); return (+p.find((x) => x.type === 'hour').value % 24) * 60 + +p.find((x) => x.type === 'minute').value; } catch { return null; } };
  let next = null;
  for (const s of list) {
    if (!s.times.length) continue;
    const now = minuteNow(s.tz);
    if (now === null) continue;
    const at = s.times.find((x) => x >= now) ?? s.times[0];
    const wait = at >= now ? at - now : 24 * 60 - now + at;
    if (!next || wait < next.wait) next = { wait, at, s };
  }
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  report.push(`SCHEDULES  ${list.length} (${found} found, ${list.length - found} declared)${off ? ` · ${off} off` : ''}${next ? ` · next: ${hhmm(next.at)}${next.s.tz ? ` ${next.s.tz}` : ''} ${next.s.title}` : ''}`);
} else report.push(`SCHEDULES  none${fs.existsSync(schedulesFile) ? ' (nothing in schedules.json, nothing found in the code)' : ' (nothing found in the code, no schedules.json)'}`);
if (graph.layers) {
  const nMixed = graph.layers.mixed;
  report.push(`LAYERS  ${graph.layers.list.map((l) => `${l.id} ${l.files}`).join(' · ')} files on the map${nMixed ? ` (${nMixed} part${nMixed === 1 ? '' : 's'} mixed)` : ''}`);
}
const pub = graph.health?.publish;
if (pub) {
  const unchecked = { missing: 'no word list at the path in layers.json', unset: 'no "privateWords" in layers.json', empty: 'the word list is empty' }[pub.words];
  report.push(`PUBLISHABILITY  ${pub.system} finding${pub.system === 1 ? '' : 's'} in system, ${pub.config} in config${unchecked ? `; private words not checked (${unchecked})` : ''}`);
  for (const i of graph.health.issues.filter((x) => x.group === 'publish')) report.push(`  [${i.severity}] ${i.title}`);
}
if (lang !== 'en') report.push(`LANGUAGE  ${words['lang.name']} (${lang}): the map's buttons, panels and glossary`);
report.push(graph.recent
  ? `RECENT WORK  ${graph.recent.items.length} card(s) highlighted across ${graph.recent.tasks.length} task(s)`
  : `RECENT WORK  none highlighted${fs.existsSync(recentFile) ? '' : ' (no recent-work.json)'}`);
if (graph.ops) {
  const o = graph.ops;
  report.push(`OPS  ${o.stale ? `stale: as of ${o.asOf} (more than 24 hours ago) · ` : ''}${o.items.length} item${o.items.length === 1 ? '' : 's'}: ${OPS_STATUSES.map((s) => `${o.counts[s]} ${s}`).join(' · ')}${o.stale ? '' : ` (as of ${o.asOf})`}`);
} else report.push(`OPS  none${fs.existsSync(opsFile) ? ' (nothing in ops.json is on the map)' : ' (no ops.json)'}`);
report.push(`MAP.MD  ${mapNote}`);
// point future Claude Code sessions in this project at the map. Codex has no personal, uncommitted
// equivalent (AGENTS.md is shared with the team), so a map built by Codex leaves the project's notes alone.
if (agent === 'codex') report.push('AGENT  Codex: questions on the map run through Codex');
else if (scan.blueprint) report.push('BLUEPRINT  planned, not built yet: drawn from floorplan/plan.json');
else if (!args['no-claude-md']) report.push(`CLAUDE.LOCAL.MD  ${writeClaudeMd(root, outDir, { add: !!args['claude-md'], git: gitMode })}`);
report.push(trackedWarning ? `GIT  ! ${trackedWarning}` : gitMode === 'inputs' ? `GIT  "git": "inputs": ${path.basename(outDir)}/ ignores only what it generates; its inputs and MAP.md can be committed` : 'GIT  floorplan/ is kept out of git (it ignores itself)');
report.push('');
report.push(`✓ wrote ${path.relative(root, path.join(outDir, 'index.html'))} (${fmtNum(Math.round(html.length / 1024))} KB) and graph.json`);
if (pct > 10) report.push(`  Unassigned is ${pct.toFixed(0)}%: add nodes or globs for the directories above (or "ignore" them) and rebuild.`);
console.log(report.join('\n'));
