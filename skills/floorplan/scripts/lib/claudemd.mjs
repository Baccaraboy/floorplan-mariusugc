// Keeps a short block in the project's CLAUDE.local.md pointing future Claude Code sessions at the map, so
// "where is X / how does Y work" starts from the map instead of a fresh search of the code.
// CLAUDE.local.md is Claude Code's personal, uncommitted project memory (loaded at launch like CLAUDE.md,
// including from parent folders); the map itself isn't committed (unless the project sets "git": "inputs", which
// commits its inputs and MAP.md), so its pointer isn't either. The file
// is added to the repo's local ignore list (.git/info/exclude), which leaves tracked files untouched.
// The block sits between markers and is rewritten in place; the rest of the file is never touched.
// It's added only when the user asks for it (build.mjs --claude-md); a block that's already there is
// kept current. Put <!-- floorplan:off --> in CLAUDE.local.md to opt out.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './common.mjs';

const START = '<!-- floorplan:start -->';
const END = '<!-- floorplan:end -->';
const NAME = 'CLAUDE.local.md';

/** With "git": "inputs" the project commits MAP.md (the map as text) with its inputs, so a worker reads that first. */
const pointer = (rel) => `Read \`${rel}/MAP.md\` first: it is this map as plain text (the parts and their key files, the endpoints, who writes where, the flows, the Health findings and the recent work), and the project commits it with the map's inputs, so a fresh clone has it. Edit the inputs in \`${rel}/\`, not that file, and leave committing them to the user.

`;

function block(rel, inputs = false) {
  return `${START}
## Floorplan: map of this codebase

${inputs ? pointer(rel) : ''}\`${rel}/\` holds a map of this codebase: every module, file and endpoint with a plain-English name and a one-line description, and what connects to what. For questions like "where is X", "how does Y work" or "what uses Z", look it up before searching the code (run these from the folder this file is in):

- \`node ${rel}/query.mjs find "<words>"\`: modules, files and endpoints that match
- \`node ${rel}/query.mjs show <file path | module id | "GET /path">\`: what it is, what it uses, what uses it
- \`node ${rel}/query.mjs path <from> <to>\`: how two things connect
- \`node ${rel}/query.mjs overview\`: the whole system at a glance

When the project filled in the map's other floors (the overview counts them under \`floors\`), ask them before you grep; \`show\` lists them at a card:

- \`node ${rel}/query.mjs targets [words]\`: who writes where: every target with its writers, readers and one-writer conflicts
- \`node ${rel}/query.mjs rules [words | id]\`: the rules and decisions, or those that hold at a part, file or endpoint, through its parents
- \`node ${rel}/query.mjs schedules\`: what a clock starts, and when
- \`node ${rel}/query.mjs ops [id]\`: what is running, as the project's own tooling last reported it
- \`node ${rel}/query.mjs outcomes [id]\`: what you see at each place (a phone, a mailbox, a calendar), and from which flow
- \`node ${rel}/query.mjs flows\`: every flow with what starts it and what you have in the end

The map can lag behind recent edits, so confirm in the code before changing anything. Open it with \`node ${rel}/serve.mjs\`. After big changes, update it with the floorplan skill (the user can just ask to "update the floorplan"; only changed files are re-read).
${END}`;
}

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
/** The text with the block removed (normalized to \n), or null when there's no block. */
const stripBlock = (text) => {
  const a = text.indexOf(START), b = text.indexOf(END);
  if (a < 0 || b < a) return null;
  return [text.slice(0, a).trimEnd(), text.slice(b + END.length).trimStart()].filter(Boolean).join('\n\n').replace(/\r\n/g, '\n');
};

/** Adds CLAUDE.local.md to the enclosing repo's .git/info/exclude unless git already ignores it. */
function excludeLocally(root) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return 'not in a git repo';
  if (git(root, ['ls-files', '--', NAME])) return `${NAME} is committed in this repo; the Floorplan section will show up in it`;
  if (git(root, ['check-ignore', '-q', NAME]) !== null) return 'already ignored';
  const prefix = git(root, ['rev-parse', '--show-prefix']) || '';
  const excl = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!excl) return 'could not find .git/info/exclude';
  const file = path.resolve(root, excl);
  const line = '/' + prefix + NAME;
  const cur = read(file) || '';
  if (!cur.split(/\r?\n/).includes(line)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cur.replace(/\s*$/, cur.trim() ? '\n' : '') + `# personal Claude Code notes (added by Floorplan)\n${line}\n`);
  }
  return 'ignored locally via .git/info/exclude';
}

/** Refreshes the block, or adds it when `add` (the user asked for it); moves it out of a committed CLAUDE.md written by older versions. */
export function writeClaudeMd(root, outDir, { add = false, git: gitMode = 'none' } = {}) {
  const rel = path.relative(root, outDir).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'skipped (map is outside the codebase)';
  const had = ['CLAUDE.local.md', 'CLAUDE.md', path.join('.claude', 'CLAUDE.md')].some((f) => stripBlock(read(path.join(root, f)) ?? '') != null);
  if (!add && !had) return 'not added (offer it to the user; add it with --claude-md)';
  const notes = [];

  // older versions wrote the block into CLAUDE.md, which is usually committed: take it back out
  for (const f of [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')]) {
    const t = read(f);
    const rest = t == null ? null : stripBlock(t);
    if (rest == null) continue;
    const eol = t.includes('\r\n') ? '\r\n' : '\n';
    const tracked = !!git(path.dirname(f), ['ls-files', '--', path.basename(f)]);
    if (!rest.trim() && !tracked) fs.unlinkSync(f);
    else fs.writeFileSync(f, rest.replace(/\n/g, eol) + (rest.trim() ? eol : ''));
    notes.push(`moved the Floorplan section out of ${path.relative(root, f).replace(/\\/g, '/')}${!rest.trim() && tracked ? ' (now empty; delete it if you like)' : ''}`);
  }

  const file = path.join(root, NAME);
  const old = read(file);
  if (old?.includes('<!-- floorplan:off -->')) return 'skipped (opted out)';
  const eol = old?.includes('\r\n') ? '\r\n' : '\n';
  const text = block(rel, gitMode === 'inputs').replace(/\n/g, eol);
  let next;
  if (old == null) next = text + eol;
  else {
    const a = old.indexOf(START), b = old.indexOf(END);
    next = a >= 0 && b > a ? old.slice(0, a) + text + old.slice(b + END.length) : old.replace(/\s*$/, '') + eol + eol + text + eol;
  }
  if (next !== old) { fs.writeFileSync(file, next); notes.unshift(`${old == null ? 'created' : 'updated'} ${NAME}`); }
  else notes.unshift(`${NAME} unchanged`);
  notes.push(excludeLocally(root));
  return notes.join('; ');
}
