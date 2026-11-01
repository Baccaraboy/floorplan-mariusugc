#!/usr/bin/env node
// Prints whether a floorplan already exists here and how stale it is. Never fails.
// usage: node status.mjs [root]
import fs from 'node:fs';
import path from 'node:path';
import { git, mapDir, LEGACY_MAP_DIR, isMapDir, gitModeOf } from './lib/common.mjs';

try {
  const root = path.resolve(process.argv[2] || '.');
  const legacy = !fs.existsSync(path.join(root, 'floorplan')) && isMapDir(path.join(root, LEGACY_MAP_DIR));
  if (legacy) console.log(`(a map from before the rename is in ${LEGACY_MAP_DIR}/; the next scan, build or refresh moves it to floorplan/)`);
  const dir = legacy ? path.join(root, LEGACY_MAP_DIR) : mapDir(root, { migrate: false });
  const graphFile = path.join(dir, 'graph.json');
  const hasArch = fs.existsSync(path.join(dir, 'architecture.json'));
  // "git": "inputs" commits the map's inputs and MAP.md (the map as text), so a worker starts from that file
  const inputs = gitModeOf(dir) === 'inputs';
  const hasMapMd = fs.existsSync(path.join(dir, 'MAP.md'));
  const readFirst = inputs ? `"git": "inputs": ${hasMapMd ? 'read floorplan/MAP.md first (the map as text). ' : ''}After a build, the inputs${hasMapMd ? ' and MAP.md' : ''} are for the user to commit; don't commit them yourself.` : '';
  if (!fs.existsSync(graphFile)) {
    // a fresh clone has the inputs but no scan, graph or page: refresh.mjs scans and builds from them
    if (inputs && hasArch) {
      console.log(`the map's inputs are here ("git": "inputs" in architecture.json) but no map is built on this computer: run refresh.mjs, which scans and builds from them.${hasMapMd ? ' Read floorplan/MAP.md first for the structure of the project.' : ''}`);
      process.exit(0);
    }
    const hasPlan = fs.existsSync(path.join(dir, 'plan.json'));
    console.log(hasPlan ? 'a blueprint was started (plan.json) but never drawn: write architecture.json if it is missing, then run plan.mjs and build.mjs.' : hasArch ? 'architecture.json exists but was never built: run build.mjs.' : 'none: no floorplan here yet (fresh run).');
    process.exit(0);
  }
  const g = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  if (g.meta.blueprint) {
    console.log(`a blueprint (planned, not built${g.meta.blueprint.source ? `, from ${g.meta.blueprint.source}` : ''}) built ${g.meta.generatedAt}: ${g.meta.counts.files} planned files, ${g.nodes.length} nodes.\nTo change the plan, edit floorplan/plan.json and architecture.json, then run refresh.mjs (it redraws from plan.json). If the code now exists and the user wants a map of it, run refresh.mjs --from-code.${readFirst ? `\n${readFirst}` : ''}`);
    process.exit(0);
  }
  const lines = [`map built ${g.meta.generatedAt} covering ${g.meta.counts.files} files, ${g.nodes.length} nodes.`];
  for (const r of g.meta.repos || []) {
    const abs = path.join(root, r.path);
    const head = git(abs, ['rev-parse', 'HEAD']);
    if (!head || !r.head) { lines.push(`  ${r.path}: not a git repo now`); continue; }
    const changed = head === r.head ? [] : (git(abs, ['diff', '--name-only', r.head, head]) || '').split('\n').filter(Boolean);
    const dirty = (git(abs, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length;
    lines.push(`  ${r.path}: ${head === r.head ? 'same commit' : `${changed.length} file(s) changed since ${r.head.slice(0, 7)}`}${dirty ? `, ${dirty} uncommitted` : ''}`);
    if (changed.length) lines.push(`    e.g. ${changed.slice(0, 6).map((p) => (r.path === '.' ? p : `${r.path}/${p}`)).join(', ')}`);
  }
  lines.push('A map exists: update it with refresh.mjs (only changed files cost tokens) rather than starting over.');
  if (readFirst) lines.push(readFirst);
  console.log(lines.join('\n'));
} catch (e) {
  console.log(`status unavailable (${e.message})`);
}
