// Schedules the scan finds in a codebase, for the Clock (graph.schedules): what a clock starts, not a person. Five
// forms, each read from the files the owner already has, with no parser beyond what a few lines of looking need:
//   - GitHub Actions: `on.schedule[].cron` in .github/workflows/*.yml;
//   - Vercel: `crons[].{ path, schedule }` in vercel.json (the path is the endpoint the cron calls);
//   - n8n workflows: a *.json with "nodes" and a Schedule Trigger or Cron node; the rule becomes a cron expression
//     where cron can say it exactly, else an interval; an HTTP Request node says what the workflow calls;
//   - crontab files (crontab, *.cron, *.crontab, cron.d/*): `m h dom mon dow command`, with CRON_TZ and TZ;
//   - ofelia labels in docker-compose files: `ofelia.job-exec.<name>.schedule` (and job-run) with its command.
// Every find is { id, title, cron | interval, tz?, source, kind, calls?, trigger }, with `source` and `trigger` the file
// it came from; `enabled: false` marks a trigger the source itself switches off. Ids are built from the kind and the
// name, so an owner can override a find by id in floorplan/schedules.json. Nothing here reads secrets: it looks at
// schedules and the addresses they call, never at tokens, and a command is kept as it stands.
import { parseCron } from './cron-text.mjs';

const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
const VERCEL = /(^|\/)vercel\.json$/;
const CRONTAB = /(^|\/)(crontab(\.txt)?|[^/]+\.cron(tab)?|cron\.d\/[^/]+)$/;
const COMPOSE = /(^|\/)(docker-)?compose[^/]*\.ya?ml$/;
const N8N_HINT = /"n8n-nodes-base\.(scheduleTrigger|cron)"/;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const humanize = (s) => { const w = String(s).replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim(); return w.charAt(0).toUpperCase() + w.slice(1); };
const stem = (p) => p.split('/').pop().replace(/\.[^.]+$/, '');
const unquote = (s) => String(s).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const pad = (n) => String(n).padStart(2, '0');

/** Every schedule in a codebase: `files` are the scan's { path, bytes, tooLarge? }, `read(path)` returns a file's text or null. */
export function scanSchedules(files, read) {
  const out = [];
  for (const f of files) {
    if (f.tooLarge) continue;
    const p = f.path;
    let kind = null;
    if (WORKFLOW.test(p)) kind = 'github-actions';
    else if (VERCEL.test(p)) kind = 'vercel';
    else if (CRONTAB.test(p)) kind = 'crontab';
    else if (COMPOSE.test(p)) kind = 'ofelia';
    else if (p.endsWith('.json')) kind = 'n8n';
    if (!kind) continue;
    let src;
    try { src = read(p); } catch { src = null; }
    if (typeof src !== 'string' || !src) continue;
    if (kind === 'n8n' && !N8N_HINT.test(src)) continue;
    const finds = { 'github-actions': githubActions, vercel, crontab, ofelia, n8n }[kind](src, p);
    for (const s of finds) out.push({ ...s, kind, source: p, trigger: p });
  }
  // one id each: a second find with the same name gets -2, -3 …
  const seen = new Map();
  for (const s of out) {
    const base = s.id;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n > 1) s.id = `${base}-${n}`;
  }
  return out;
}

// ---------- GitHub Actions ----------
// `on:` → `schedule:` → lines `- cron: '30 2 * * *'`; the workflow's `name:` is the title. Times are UTC.
function githubActions(src, p) {
  const lines = src.split('\n');
  const name = lines.map((l) => /^name:\s*(.+?)\s*$/.exec(l)?.[1]).find(Boolean);
  const title = name ? unquote(name) : humanize(stem(p));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)schedule:\s*(#.*)?$/.exec(lines[i]);
    if (!head) continue;
    const indent = head[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      // the list may sit deeper than `schedule:` or, as YAML allows, at the same indent
      const ind = /^(\s*)/.exec(l)[1].length;
      if (ind < indent || (ind === indent && !/^\s*-/.test(l))) break;
      const m = /\bcron:\s*(['"]?)([^'"#}\]]+?)\1\s*[}\]]?\s*(#.*)?$/.exec(l);
      if (m) out.push({ id: `actions-${slug(stem(p))}`, title, cron: m[2].trim(), tz: 'UTC' });
    }
  }
  return out;
}

// ---------- Vercel ----------
// `crons: [{ path, schedule }]`: Vercel calls the path with GET at the schedule, in UTC.
function vercel(src, p) {
  let json;
  try { json = JSON.parse(src); } catch { return []; }
  const out = [];
  for (const c of Array.isArray(json?.crons) ? json.crons : []) {
    if (!c || typeof c.path !== 'string' || typeof c.schedule !== 'string') continue;
    const path = c.path.split(/[?#]/)[0] || '/';
    const last = path.split('/').filter(Boolean).pop() || 'cron';
    out.push({ id: `vercel-${slug(path)}`, title: humanize(last), cron: c.schedule.trim(), tz: 'UTC', calls: `GET ${path}` });
  }
  return out;
}

// ---------- crontab ----------
// `m h dom mon dow command`, or `@daily command`; in cron.d/ a user name sits before the command. CRON_TZ= or TZ=
// lines set the zone for the entries below them.
function crontab(src, p) {
  const inCronD = /(^|\/)cron\.d\//.test(p);
  const out = [];
  let tz = null;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const env = /^(?:export\s+)?(CRON_TZ|TZ)\s*=\s*(.+)$/.exec(line);
    if (env) { tz = unquote(env[2]) || null; continue; }
    if (/^[A-Za-z_][\w]*\s*=/.test(line)) continue;
    let cron, rest;
    const at = /^(@\w+)\s+(.+)$/.exec(line);
    if (at) { if (at[1] === '@reboot') continue; cron = at[1]; rest = at[2]; }
    else {
      const m = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
      if (!m || !parseCron(m[1])) continue;
      cron = m[1]; rest = m[2];
    }
    if (inCronD) { const u = /^[a-z_][\w-]*\s+(.+)$/.exec(rest); if (u) rest = u[1]; }
    const command = rest.trim();
    const program = programOf(command);
    out.push({ id: `cron-${slug(program)}`, title: program, cron, ...(tz ? { tz } : {}), calls: command });
  }
  return out;
}
const WRAPPERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'php', 'ruby', 'perl', 'npx', 'flock', 'timeout', 'nice', 'env', 'sudo', 'docker', 'exec', 'run']);
/** The program a cron line runs, by its file name: past `cd … &&`, variables, flags and interpreters like node or bash. */
function programOf(command) {
  const last = command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter((s) => s && !/^cd\s/.test(s)).pop() || command;
  const words = last.split(/\s+/).filter((w) => !/^[A-Za-z_]\w*=/.test(w) && !/^[-<>|&]/.test(w) && !/^\d*>/.test(w));
  let i = 0;
  while (i < words.length - 1 && WRAPPERS.has(words[i].split('/').pop())) i++;
  return (words[i] || command).split('/').pop() || command;
}

// ---------- ofelia (docker-compose labels) ----------
// `ofelia.job-exec.<name>.schedule` and `.command` on a service (map or list form); the service is where it runs.
function ofelia(src, p) {
  const jobs = new Map();
  let service = null;
  for (const raw of src.split('\n')) {
    const svc = /^ {2}([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(raw);
    if (svc) { service = svc[1]; continue; }
    const m = /ofelia\.job-(exec|run|local|service-run)\.([\w.-]+?)\.(schedule|command)\s*[:=]\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const key = `${service}|${m[2]}`;
    if (!jobs.has(key)) jobs.set(key, { service, name: m[2] });
    jobs.get(key)[m[3]] = unquote(m[4]).replace(/["']$/, '');
  }
  const out = [];
  for (const j of jobs.values()) {
    if (!j.schedule) continue;
    const when = goCron(j.schedule);
    if (!when) continue;
    out.push({ id: `ofelia-${slug(j.name)}`, title: j.service ? `${humanize(j.name)} (${j.service})` : humanize(j.name), ...when, ...(j.command ? { calls: j.command } : {}) });
  }
  return out;
}
/** ofelia's Go cron: "@every 5m", "@hourly", 5 fields, or 6 with seconds first. As { cron } or { interval }, or null. */
function goCron(s) {
  const every = /^@every\s+(.+)$/.exec(s.trim());
  if (every) {
    let seconds = 0;
    for (const m of every[1].matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s|ms)/g)) seconds += Number(m[1]) * { h: 3600, m: 60, s: 1, ms: 0 }[m[2]];
    seconds = Math.round(seconds);
    if (!seconds) return null;
    if (seconds === 3600) return { cron: '0 * * * *' };
    if (seconds % 3600 === 0 && 24 % (seconds / 3600) === 0) return { cron: `0 */${seconds / 3600} * * *` };
    if (seconds % 60 === 0 && 60 % (seconds / 60) === 0) return { cron: `*/${seconds / 60} * * *` };
    if (seconds % 3600 === 0) return { interval: { every: seconds / 3600, unit: 'hours' } };
    if (seconds % 60 === 0) return { interval: { every: seconds / 60, unit: 'minutes' } };
    return { interval: { every: seconds, unit: 'seconds' } };
  }
  const parts = s.trim().split(/\s+/);
  if (parts.length === 6 && parseCron(parts.slice(1).join(' '))) return { cron: parts.slice(1).join(' ') };
  return parseCron(s) ? { cron: s.trim() } : null;
}

// ---------- n8n ----------
// A workflow export: "nodes" with a Schedule Trigger (rule.interval[]) or the older Cron node (triggerTimes.item[]),
// the workflow's name as the title, its timezone setting, and the HTTP Request nodes as what it calls.
function n8n(src, p) {
  let json;
  try { json = JSON.parse(src); } catch { return []; }
  if (!json || !Array.isArray(json.nodes)) return [];
  const title = typeof json.name === 'string' && json.name.trim() ? json.name.trim() : humanize(stem(p));
  const tz = typeof json.settings?.timezone === 'string' && json.settings.timezone !== 'DEFAULT' ? json.settings.timezone : null;
  const calls = [];
  for (const n of json.nodes) {
    if (n?.type !== 'n8n-nodes-base.httpRequest' || typeof n.parameters?.url !== 'string') continue;
    const path = urlPath(n.parameters.url);
    if (!path) continue;
    const method = String(n.parameters.method || n.parameters.requestMethod || 'GET').toUpperCase();
    const call = `${method} ${path}`;
    if (!calls.includes(call)) calls.push(call);
  }
  const out = [];
  const add = (when, disabled) => { if (when) out.push({ id: `n8n-${slug(title)}`, title, ...when, ...(tz ? { tz } : {}), ...(calls.length ? { calls: calls.join(' · ') } : {}), ...(disabled ? { enabled: false } : {}) }); };
  for (const n of json.nodes) {
    if (n?.type === 'n8n-nodes-base.scheduleTrigger') {
      const items = Array.isArray(n.parameters?.rule?.interval) ? n.parameters.rule.interval : [{}];
      for (const it of items.length ? items : [{}]) add(scheduleRule(it), n.disabled === true);
    } else if (n?.type === 'n8n-nodes-base.cron') {
      const items = Array.isArray(n.parameters?.triggerTimes?.item) ? n.parameters.triggerTimes.item : [{}];
      for (const it of items.length ? items : [{}]) add(cronRule(it), n.disabled === true);
    }
  }
  return out;
}
/** The path of an n8n URL: "https://host/x?y", "/x", or "={{ $env.BASE }}/x" (expressions are dropped). */
function urlPath(url) {
  let s = url.trim().replace(/^=/, '').replace(/\{\{[\s\S]*?\}\}/g, '').trim();
  const abs = /^https?:\/\/[^/\s]*(\/.*)?$/i.exec(s);
  if (abs) s = abs[1] || '/';
  if (!s.startsWith('/')) return null;
  return s.split(/[?#]/)[0] || '/';
}
const num = (v, d) => (Number.isInteger(v) && v >= 0 ? v : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);
/** A Schedule Trigger rule as { cron } where cron says it exactly, else { interval }; null for one that says nothing. */
function scheduleRule(it) {
  const field = it?.field || 'days';
  const hour = num(it?.triggerAtHour, 0), minute = num(it?.triggerAtMinute, 0);
  const at = `${pad(hour)}:${pad(minute)}`;
  if (field === 'cronExpression') {
    const expr = String(it?.expression || '').trim();
    const parts = expr.split(/\s+/);
    if (parts.length === 6 && parseCron(parts.slice(1).join(' '))) return { cron: parts.slice(1).join(' ') };
    return expr ? { cron: expr } : null;
  }
  if (field === 'seconds') return { interval: { every: num(it?.secondsInterval, 30) || 30, unit: 'seconds' } };
  if (field === 'minutes') { const n = num(it?.minutesInterval, 5) || 5; return 60 % n === 0 ? { cron: `*/${n} * * * *` } : { interval: { every: n, unit: 'minutes' } }; }
  if (field === 'hours') { const n = num(it?.hoursInterval, 1) || 1; return 24 % n === 0 ? { cron: `${minute} ${n === 1 ? '*' : `*/${n}`} * * *` } : { interval: { every: n, unit: 'hours', at } }; }
  if (field === 'days') { const n = num(it?.daysInterval, 1) || 1; return n === 1 ? { cron: `${minute} ${hour} * * *` } : { interval: { every: n, unit: 'days', at } }; }
  if (field === 'weeks') {
    const n = num(it?.weeksInterval, 1) || 1;
    const days = (Array.isArray(it?.triggerAtDay) ? it.triggerAtDay : [0]).map((d) => num(d, 0) % 7);
    return n === 1 ? { cron: `${minute} ${hour} * * ${[...new Set(days)].sort().join(',') || '0'}` } : { interval: { every: n, unit: 'weeks', at } };
  }
  if (field === 'months') { const n = num(it?.monthsInterval, 1) || 1; return n === 1 ? { cron: `${minute} ${hour} ${num(it?.triggerAtDayOfMonth, 1) || 1} * *` } : { interval: { every: n, unit: 'months', at } }; }
  return null;
}
/** The older Cron node's trigger times: everyMinute, everyHour, everyDay, everyWeek, everyMonth, everyX or custom. */
function cronRule(it) {
  const mode = it?.mode || 'everyDay';
  const hour = num(it?.hour, 14), minute = num(it?.minute, 0);
  if (mode === 'custom') return it?.cronExpression ? scheduleRule({ field: 'cronExpression', expression: it.cronExpression }) : null;
  if (mode === 'everyMinute') return { cron: '* * * * *' };
  if (mode === 'everyHour') return { cron: `${minute} * * * *` };
  if (mode === 'everyDay') return { cron: `${minute} ${hour} * * *` };
  if (mode === 'everyWeek') return { cron: `${minute} ${hour} * * ${num(it?.weekday, 1) % 7}` };
  if (mode === 'everyMonth') return { cron: `${minute} ${hour} ${num(it?.dayOfMonth, 1) || 1} * *` };
  if (mode === 'everyX') {
    const n = num(it?.value, 6) || 6, unit = it?.unit === 'minutes' ? 'minutes' : 'hours';
    if (unit === 'minutes') return 60 % n === 0 ? { cron: `*/${n} * * * *` } : { interval: { every: n, unit } };
    return 24 % n === 0 ? { cron: `0 */${n} * * *` } : { interval: { every: n, unit, at: '00:00' } };
  }
  return null;
}
