#!/usr/bin/env node
// floorplan builder: validate floorplan/architecture.json against the scan, assign every file to a
// node, attach import/HTTP/external edges, and write floorplan/graph.json + floorplan/index.html.
//
// usage: node build.mjs [root] [--arch <file>] [--scan <file>] [--out <dir>] [--lang <code>] [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileGlob, parseArgs, fmtNum, mapDir, keepOutOfGit } from './lib/common.mjs';
import { fallbackFileName, fallbackRouteName, routeKey } from './lib/names.mjs';
import { buildHealth, TEST_FILE } from './lib/health.mjs';
import { buildPlanHealth } from './lib/blueprint.mjs';
import { buildScreens } from './lib/screens.mjs';
import { writeClaudeMd } from './lib/claudemd.mjs';
import { detectAgent } from './lib/agent.mjs';
import { languages, strings as langStrings, fill } from './lib/lang.mjs';

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

archEdges.forEach((e, i) => {
  const where = `edges[${i}]`;
  if (!EDGE_KINDS.includes(e?.kind)) err(`${where}.kind "${e?.kind}" must be one of ${EDGE_KINDS.join(', ')}${didYouMean(String(e?.kind), EDGE_KINDS)}`);
  const a = resolveEndpoint(e?.from, `${where}.from`);
  const b = resolveEndpoint(e?.to, `${where}.to`);
  if (a && b && EDGE_KINDS.includes(e.kind)) addLink(a, b, e.kind, { label: e.label, desc: e.description, w: 1 });
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
if (targetList?.length) {
  // the parts that hold an item, nearest first: a file's part and its parents, or a node's parents
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

// ---------- report ----------
const pct = included.length ? (unassigned.length / included.length) * 100 : 0;
const report = [];
if (errors.length) {
  report.push(`✗ ${errors.length} error(s) in ${path.relative(root, archFile)}${scan.blueprint ? ' or plan.json' : ''}${['names.json', 'targets.json'].filter((f) => errors.some((e) => e.startsWith(f))).map((f) => ` or ${f}`).join('')}:`);
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
      };
    }),
    ...(unassigned.length ? [{ id: 'unassigned', parent: null, label: words['unassigned.label'], kind: 'misc', summary: words['unassigned.summary'], details: '', tags: [], paths: [], packages: [], hosts: [], stats: { ...stats.get('unassigned'), repos: [...stats.get('unassigned').repos] } }] : []),
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
  ...(outRecent?.items.length ? { recent: outRecent } : {}),
};
// extension hooks, computed from the finished graph plus the raw scan
// a blueprint has no code to check, so its Health is a design review of the plan (computed after screens)
if (!scan.blueprint) try { graph.health = buildHealth({ graph, scan, arch, root }); } catch (e) { warn(`health check failed: ${e.message}`); graph.health = { issues: [] }; }
try { graph.screens = buildScreens({ graph, scan, arch, root }); } catch (e) { warn(`screen detection failed: ${e.message}`); graph.screens = []; }
if (scan.blueprint) try { graph.health = buildPlanHealth({ graph, scan }); } catch (e) { warn(`design review failed: ${e.message}`); graph.health = { issues: [] }; }
fs.mkdirSync(outDir, { recursive: true });
const trackedWarning = keepOutOfGit(outDir);
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
// the logo and tab icon are inlined so the map stays one self-contained file
function dataUri(name) { return 'data:image/png;base64,' + fs.readFileSync(path.join(SKILL_DIR, 'assets', name)).toString('base64'); }
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

const hs = graph.health?.summary;
if (hs && (hs.high || hs.medium || hs.low)) {
  report.push(`${scan.blueprint ? 'DESIGN REVIEW' : 'HEALTH'}  ${hs.high} important · ${hs.medium} worth fixing · ${hs.low} minor`);
  for (const i of graph.health.issues.filter((x) => x.severity !== 'low').slice(0, 8)) report.push(`  [${i.severity}] ${i.title}`);
}
if (graph.screens?.length) report.push(`SCREENS  ${graph.screens.length} detected`);
const nConflicts = outTargets.filter((t) => t.conflict).length;
if (outTargets.length) report.push(`TARGETS  ${outTargets.length}${nConflicts ? ` (${nConflicts} with more than one writer)` : ''}`);
if (lang !== 'en') report.push(`LANGUAGE  ${words['lang.name']} (${lang}): the map's buttons, panels and glossary`);
report.push(graph.recent
  ? `RECENT WORK  ${graph.recent.items.length} card(s) highlighted across ${graph.recent.tasks.length} task(s)`
  : `RECENT WORK  none highlighted${fs.existsSync(recentFile) ? '' : ' (no recent-work.json)'}`);
// point future Claude Code sessions in this project at the map. Codex has no personal, uncommitted
// equivalent (AGENTS.md is shared with the team), so a map built by Codex leaves the project's notes alone.
if (agent === 'codex') report.push('AGENT  Codex: questions on the map run through Codex');
else if (scan.blueprint) report.push('BLUEPRINT  planned, not built yet: drawn from floorplan/plan.json');
else if (!args['no-claude-md']) report.push(`CLAUDE.LOCAL.MD  ${writeClaudeMd(root, outDir, { add: !!args['claude-md'] })}`);
report.push(trackedWarning ? `GIT  ! ${trackedWarning}` : 'GIT  floorplan/ is kept out of git (it ignores itself)');
report.push('');
report.push(`✓ wrote ${path.relative(root, path.join(outDir, 'index.html'))} (${fmtNum(Math.round(html.length / 1024))} KB) and graph.json`);
if (pct > 10) report.push(`  Unassigned is ${pct.toFixed(0)}%: add nodes or globs for the directories above (or "ignore" them) and rebuild.`);
console.log(report.join('\n'));
