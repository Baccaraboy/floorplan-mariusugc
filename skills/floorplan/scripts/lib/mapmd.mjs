// MAP.md: the map as plain text, for the AI workers (Claude Code, Codex …) that start in the repo and need the
// structure before they build. build.mjs writes it next to graph.json, in the map's language: the head (project,
// state, size), every part with its key files and endpoints, who writes where, the rules and decisions, the schedules,
// the flows, what you see (what arrives at each place, and from which flow), the Health findings (a title and a count,
// never a place or a value) and the recent work. The eight sections and their order never change, and a marker
// (<!-- floorplan:parts --> …) sits right above each heading, so a program finds a section without knowing the
// language. The file stays under 1,500 lines however big the map is: the lists shrink step by step and end in "… and
// N more". Whatever comes from the code or from a person is flattened to
// one line first, so it can't add a heading, a list item or a marker of its own. The words come from the language table
// (map.* and a few keys the viewer shares), never from this file. The file is meant to be committed (with "git":
// "inputs"), so it holds nothing that changes with every edit: no lines of code, and a stamp (the day and commit it was
// written) that build.mjs leaves as it was when nothing else changed.
import { translator } from './lang.mjs';

export const MAX_LINES = 1500;

// How much of each part to show, from everything to nothing: key files and endpoints. The first step whose file fits
// wins. If even one line per part is too much, the parts after the first that fit are counted instead of listed.
const STEPS = [
  { files: 12, routes: 20 },
  { files: 8, routes: 10 },
  { files: 5, routes: 5 },
  { files: 3, routes: 3 },
  { files: 2, routes: 0 },
  { files: 1, routes: 0 },
  { files: 0, routes: 0 },
];
// The other sections have caps of their own, so together they take a third of the file at most.
const CAP = { targets: 25, listed: 12, undeclared: 6, rules: 40, places: 8, schedules: 40, flows: 10, steps: 12, outcomes: 30, seen: 12, health: 40, tasks: 10, items: 8, paths: 12 };

const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${SEPARATORS}]+`, 'g');
/** One line of plain text: line breaks, tabs and other control characters become spaces, and a comment opener is defused. */
const oneLine = (s) => String(s ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').replace(/<!--/g, '<! --').trim();
const clip = (s, max) => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};
/** Text as inline code. */
const code = (s) => {
  const v = oneLine(s);
  return v.includes('`') ? `\`\` ${v} \`\`` : `\`${v}\``;
};
/** Text for a block quote: a first character that would start a heading, a list or a quote of its own is escaped. */
const quote = (s) => oneLine(s).replace(/^[#>*+=|~`-]/, '\\$&');
const joinEntries = (entries) => entries.flatMap((e, i) => (i ? ['', ...e] : e));

/**
 * MAP.md without its "as of" line, which is the first bullet of the file. build.mjs writes MAP.md only when the rest
 * changes, so a committed file doesn't change just because a day or a commit went by, and a fresh clone that runs
 * refresh.mjs doesn't find it modified.
 */
export function withoutStamp(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => l.startsWith('- '));
  if (at > 0) lines.splice(at, 1);
  return lines.join('\n');
}

/**
 * The map as text. `graph` is what build.mjs writes to graph.json, `words` the language table of the map. `dir` is the
 * map folder as the project names it, and `inputs` the files and folders in it a person or the AI keeps.
 */
export function buildMapMd(graph, { words, dir = 'floorplan', inputs = [], maxLines = MAX_LINES } = {}) {
  const lang = graph.meta?.lang || 'en';
  const { t, tn } = translator(words, lang);
  const more = (n) => t('map.more', { n });
  const bp = !!graph.meta?.blueprint;
  const nodes = graph.nodes || [], files = graph.files || [], routes = graph.routes || [], links = graph.links || [], targets = graph.targets || [], rules = graph.rules || [], schedules = graph.schedules || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const fileAt = new Map(files.map((f) => [f.p, f]));

  // ---------- who is what ----------
  const partRef = (id) => (byId.has(id) ? `${oneLine(byId.get(id).label)} (${code(id)})` : code(id));
  /** Something a flow step or a recent change points at: n:<part>, f:<file>, r:<index of an endpoint>, s:<file>#<index of a name in it>. */
  const refText = (ref) => {
    if (typeof ref !== 'string') return '';
    if (ref.startsWith('n:')) return partRef(ref.slice(2));
    if (ref.startsWith('f:')) return code(ref.slice(2));
    if (ref.startsWith('r:')) { const r = routes[+ref.slice(2)]; return r ? code(`${r.m} ${r.p}`) : ''; }
    if (ref.startsWith('s:')) {
      const at = ref.lastIndexOf('#'), p = ref.slice(2, at), s = fileAt.get(p)?.s?.[+ref.slice(at + 1)];
      return s ? `${code(s[0])} (${code(p)})` : code(p);
    }
    return code(ref);
  };
  // a name somebody chose reads "Name: description"; one made up from the path adds nothing, so only the description shows
  const chosen = (x) => !x.auto || !!x.fixed;
  const about = (x, max = 200) => {
    const name = chosen(x) ? oneLine(x.name) : '', d = oneLine(x.d);
    return clip(name && d ? `${name}: ${d}` : name || d, max);
  };
  const withText = (head, text) => (text ? `${head} — ${text}` : head);
  const fileLine = (f) => withText(code(f.p), about(f));
  const routeLine = (r) => withText(`${code(`${r.m} ${r.p}`)} (${code(r.f)})`, about(r));
  const listOf = (label, items, cap, line) => [`- ${label}:`, ...items.slice(0, cap).map((x) => `  - ${line(x)}`), ...(items.length > cap ? [`  - ${more(items.length - cap)}`] : [])];
  const inline = (items, cap, line) => items.slice(0, cap).map(line).join(', ') + (items.length > cap ? `, ${more(items.length - cap)}` : '');

  // ---------- the parts, in tree order, with their own files most connected first ----------
  const degree = new Map();
  for (const l of links) for (const end of [l.a, l.b]) if (typeof end === 'string' && end.startsWith('f:')) degree.set(end.slice(2), (degree.get(end.slice(2)) || 0) + 1);
  const byImportance = (a, b) => (degree.get(b.p) || 0) - (degree.get(a.p) || 0) || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0);
  const filesOf = new Map(), routesOf = new Map();
  for (const f of [...files].sort(byImportance)) { if (!filesOf.has(f.n)) filesOf.set(f.n, []); filesOf.get(f.n).push(f); }
  for (const r of routes) {
    const n = fileAt.get(r.f)?.n;
    if (n === undefined) continue;
    if (!routesOf.has(n)) routesOf.set(n, []);
    routesOf.get(n).push(r);
  }
  const children = new Map();
  for (const n of nodes) if (n.parent && byId.has(n.parent)) { if (!children.has(n.parent)) children.set(n.parent, []); children.get(n.parent).push(n); }
  const ordered = [], placed = new Set();
  const place = (n) => { if (placed.has(n.id)) return; placed.add(n.id); ordered.push(n); for (const c of children.get(n.id) || []) place(c); };
  nodes.filter((n) => !n.parent || !byId.has(n.parent)).forEach(place);
  nodes.forEach(place); // a parent cycle, which the build rejects, would otherwise leave its parts out
  // a part writes or reads a target when one of its own items, or one of a part inside it, is listed there
  const lineage = (id) => { const out = []; for (let n = byId.get(id); n && !out.includes(n.id); n = byId.get(n.parent)) out.push(n.id); return out; };
  const partOf = (item) => (item.startsWith('n:') ? item.slice(2) : fileAt.get(item.slice(2))?.n);
  const touching = (side, id) => targets.filter((tg) => (tg[side] || []).some((e) => (e.items || []).some((item) => lineage(partOf(item)).includes(id))));
  const targetRef = (tg) => `${oneLine(tg.name)} (${code(tg.id)})`;

  function partLines(n, step) {
    const L = [`### ${oneLine(n.label)} (${code(n.id)})`];
    const summary = clip(oneLine(n.summary), 400);
    if (summary) L.push(`> ${quote(summary)}`);
    // no lines of code: they change with every edit, and a committed MAP.md should only change when the structure does
    L.push(`- ${t('map.kind')}: ${oneLine(n.kind)} · ${tn(bp ? 'count.plannedFile' : 'count.file', n.stats?.files ?? 0)}`);
    if (n.paths?.length) L.push(`- ${t('map.paths')}: ${inline(n.paths, CAP.paths, code)}`);
    if (graph.layers && n.layer) L.push(`- ${t('layers.panel')}: ${oneLine(n.layer)}${n.layer === 'mixed' && n.layers ? ` (${Object.entries(n.layers).map(([id, c]) => `${oneLine(id)} ${c}`).join(', ')})` : ''}`);
    if (byId.has(n.parent)) L.push(`- ${t('map.inside')}: ${partRef(n.parent)}`);
    const inside = children.get(n.id) || [];
    if (inside.length) L.push(`- ${t('map.contains')}: ${inline(inside, CAP.listed, (c) => partRef(c.id))}`);
    const writes = touching('writers', n.id), reads = touching('readers', n.id);
    if (writes.length) L.push(`- ${t('map.writes')}: ${inline(writes, CAP.listed, targetRef)}`);
    if (reads.length) L.push(`- ${t('map.reads')}: ${inline(reads, CAP.listed, targetRef)}`);
    const own = filesOf.get(n.id) || [], endpoints = routesOf.get(n.id) || [];
    if (step.files > 0 && own.length) L.push(...listOf(t('map.keyFiles'), own, step.files, fileLine));
    if (step.routes > 0 && endpoints.length) L.push(...listOf(t('map.endpoints'), endpoints, step.routes, routeLine));
    return L;
  }
  const compactLine = (n) => {
    const summary = clip(oneLine(n.summary), 100);
    return `- ${oneLine(n.label)} (${code(n.id)})${summary ? `: ${summary}` : ''} · ${tn(bp ? 'count.plannedFile' : 'count.file', n.stats?.files ?? 0)}`;
  };

  // ---------- the other sections ----------
  const entryRef = (e) => (byId.has(e.ref) ? partRef(e.ref) : code(e.ref));
  const side = (list) => (list?.length ? inline(list, CAP.listed, entryRef) : t('map.none'));
  const targetLines = (tg) => {
    const L = [`### ${oneLine(tg.name)} (${code(tg.id)})`];
    if (tg.conflict) L.push(`- ${t('map.violation', { n: tg.writerCount })}`);
    L.push(`- ${t('map.kind')}: ${oneLine(tg.kind)} · ${t('map.policy')}: ${oneLine(tg.policy)}`);
    L.push(`- ${t('targets.writers')}: ${side(tg.writers)}`);
    L.push(`- ${t('targets.readers')}: ${side(tg.readers)}`);
    if (tg.note) L.push(`- ${t('map.note')}: ${clip(oneLine(tg.note), 300)}`);
    if (tg.undeclared?.length) {
      const direction = { write: t('targets.dir.write'), read: t('targets.dir.read'), unknown: t('targets.dir.unknown') };
      L.push(...listOf(t('targets.undeclared'), tg.undeclared, CAP.undeclared, (u) => `${refText(u.part)} — ${direction[u.dir] ?? direction.unknown}`));
    }
    return L;
  };
  // a rule or decision: its kind and dates, where it applies (a target by its name), its text in one line, its source
  const byIdT = new Map(targets.map((tg) => [tg.id, tg]));
  const placeRef = (item) => (item.startsWith('t:') ? (byIdT.has(item.slice(2)) ? targetRef(byIdT.get(item.slice(2))) : code(item.slice(2))) : refText(item));
  const ruleLines = (r) => {
    const L = [`### ${oneLine(r.title)} (${code(r.id)})`];
    const facts = [r.kind === 'decision' ? t('rules.kind.decision') : t('rules.kind.rule'), r.status === 'retired' ? t('rules.retired') : '', r.since ? t('rules.since', { date: oneLine(r.since) }) : '', r.until ? t('rules.until', { date: oneLine(r.until) }) : ''].filter(Boolean);
    L.push(`- ${t('map.kind')}: ${facts.join(' · ')}`);
    L.push(`- ${t('rules.applies')}: ${r.items?.length ? inline(r.items, CAP.places, placeRef) : t('rules.everywhere')}`);
    const text = clip(oneLine(r.text), 400);
    if (text) L.push(`> ${quote(text)}`);
    if (r.source) L.push(`- ${t('rules.source')}: ${clip(oneLine(r.source), 200)}`);
    return L;
  };
  // a schedule on one line: title, cron and words (with its time zone), what starts it, what runs, what it calls
  const scheduleLine = (s) => {
    const parts = [`${oneLine(s.title)} (${code(s.id)})`];
    if (s.cron) parts.push(code(s.cron));
    const when = s.human && s.human !== s.cron ? oneLine(s.human) : '';
    if (when || s.tz) parts.push([when, s.tz ? t('clock.tz', { tz: oneLine(s.tz) }) : ''].filter(Boolean).join(', '));
    if (s.trigger) parts.push(`${t('clock.trigger')}: ${refText(s.trigger)}`);
    if (s.runs?.length) parts.push(`${t('clock.runs')}: ${inline(s.runs, CAP.places, placeRef)}`);
    if (s.calls) parts.push(`${t('clock.calls')}: ${code(s.calls)}`);
    if (s.note) parts.push(`${t('map.note')}: ${clip(oneLine(s.note), 200)}`);
    if (s.source && s.source !== s.trigger && `f:${s.source}` !== s.trigger) parts.push(`${t('clock.source')}: ${clip(oneLine(s.source), 120)}`);
    if (!s.enabled) parts.push(t('clock.off'));
    return `- ${parts.join(' · ')}`;
  };
  // what you see at a place: the sentence, the place, and an example when there is one
  const seenText = (v) => `${t('outcomes.youSee')}: ${clip(oneLine(v.text), 200)} (${refText(v.where)})${v.example ? ` · ${t('outcomes.example', { example: clip(oneLine(v.example), 100) })}` : ''}`;
  // what starts a flow: its kind, the words, where it starts, and for a clock its words and time zone
  const triggerText = (tr) => [t(`outcomes.kind.${tr.kind}`), clip(oneLine(tr.text), 200), tr.node ? refText(tr.node) : '', tr.when ? [oneLine(tr.when), tr.tz ? t('clock.tz', { tz: oneLine(tr.tz) }) : ''].filter(Boolean).join(', ') : ''].filter(Boolean).join(' · ');
  const flowLines = (fl) => {
    const L = [`### ${oneLine(fl.title) || oneLine(fl.id)} (${code(fl.id)})`];
    const description = clip(oneLine(fl.description), 300);
    if (description) L.push(`> ${quote(description)}`);
    if (fl.trigger) L.push(`- ${t('clock.trigger')}: ${triggerText(fl.trigger)}`);
    const steps = fl.steps || [];
    steps.slice(0, CAP.steps).forEach((s, i) => {
      const note = clip(oneLine(s.note), 200);
      L.push(`${i + 1}. ${refText(s.ref)}${note ? `: ${note}` : ''}${s.you_see ? ` — ${seenText(s.you_see)}` : ''}`);
    });
    if (steps.length > CAP.steps) L.push(`- ${more(steps.length - CAP.steps)}`);
    if (fl.outcome) L.push(`- ${seenText(fl.outcome)}`);
    return L;
  };
  // what you see, by place: the sentences that arrive there, each with the flow that brings it
  const flowTitle = (id) => oneLine((graph.flows || []).find((f) => f.id === id)?.title) || oneLine(id);
  const placeHead = (ref) => (ref.startsWith('f:') && fileAt.has(ref.slice(2)) && chosen(fileAt.get(ref.slice(2))) ? `${oneLine(fileAt.get(ref.slice(2)).name)} (${code(ref.slice(2))})` : refText(ref));
  const placeLines = ([ref, list]) => [
    `### ${placeHead(ref)}`,
    ...list.slice(0, CAP.seen).map((o) => `- ${clip(oneLine(o.text), 200)} (${flowTitle(o.flow)})${o.example ? ` · ${t('outcomes.example', { example: clip(oneLine(o.example), 100) })}` : ''}`),
    ...(list.length > CAP.seen ? [`- ${more(list.length - CAP.seen)}`] : []),
  ];
  // Health: a title and a count. Where the findings are, their notes and the fixes stay in graph.json and the map.
  const SEVERITIES = [['high', t('health.sev.high.word')], ['medium', t('health.sev.medium.word')], ['low', t('health.sev.low.word')]];
  const issues = [...(graph.health?.issues || [])].sort((a, b) => SEVERITIES.findIndex(([s]) => s === a.severity) - SEVERITIES.findIndex(([s]) => s === b.severity));
  const sums = graph.health?.summary || Object.fromEntries(SEVERITIES.map(([s]) => [s, issues.filter((i) => i.severity === s).length]));
  const healthSum = `${bp ? t('health.review') : t('health.title')}: ${SEVERITIES.map(([s, word]) => t('health.sevCount', { n: sums[s] || 0, word })).join(' · ')}`;
  // some titles already end in "(3 places)", in the table's own words for a count of places: say it once
  const placeForms = Object.keys(words).filter((k) => k.startsWith('count.place.')).map((k) => String(words[k]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{n\\\}/g, '\\d+'));
  const placesSuffix = new RegExp(` \\((?:${placeForms.join('|')})\\)$`);
  const findingLine = (i) => {
    const places = i.locations?.length || i.items?.length || 0;
    const word = SEVERITIES.find(([s]) => s === i.severity)?.[1] ?? oneLine(i.severity);
    return `- [${word}] ${oneLine(i.title).replace(placesSuffix, '')}${places ? ` (${tn('count.place', places)})` : ''}`;
  };
  const recent = graph.recent;
  const recentChange = (it) => withText(`${it.change === 'new' ? t('recent.new') : t('recent.changed')}: ${refText(it.id)}`, clip(oneLine(it.note), 200));
  const taskLines = (task, idx) => {
    const L = [`### ${oneLine(task.title)}`];
    const summary = clip(oneLine(task.summary), 400);
    if (summary) L.push(`> ${quote(summary)}`);
    const request = clip(oneLine(task.request), 300);
    if (request) L.push(`- ${t('recent.youAsked', { request })}`);
    const changes = (recent.items || []).filter((it) => it.task === idx);
    if (changes.length) L.push(...listOf(t('map.affected'), changes, CAP.items, recentChange));
    return L;
  };

  // ---------- the head ----------
  const date = String(graph.meta?.generatedAt || '').slice(0, 10);
  const heads = (graph.meta?.repos || []).filter((r) => r.head);
  const commit = heads.length === 1 ? heads[0].head.slice(0, 7) : heads.map((r) => `${oneLine(r.path === '.' ? r.name : r.path)} ${r.head.slice(0, 7)}`).join(', ');
  const summary = clip(oneLine(graph.project?.summary), 400);
  const counts = [tn('count.part', nodes.length), tn(bp ? 'count.plannedFile' : 'count.file', graph.meta?.counts?.files ?? files.length), tn('count.connection', links.length)].join(' · ');
  const head = [
    '<!-- floorplan:map 1 -->',
    `# ${oneLine(t('app.title', { name: oneLine(graph.project?.name) }))}`,
    '',
    t('map.notice'),
    '',
    ...(summary ? [`> ${quote(summary)}`, ''] : []),
    `- ${[t('map.asOf', { date }), commit ? t('map.commit', { commit }) : ''].filter(Boolean).join(' · ')}`,
    `- ${t('map.language', { name: oneLine(words['lang.name'] || lang), code: lang })}`,
    ...(bp ? [`- ${t('map.blueprint')}`] : []),
    `- ${counts}`,
    `- ${healthSum}`,
    ...(inputs.length ? ['', t('map.inputs', { dir: `${dir}/`, files: inputs.join(', ') })] : []),
  ];

  const section = (name, heading, body) => [`<!-- floorplan:${name} -->`, `## ${heading}`, '', ...(body.length ? body : [t('map.none')])];
  const targetsBody = [...joinEntries(targets.slice(0, CAP.targets).map(targetLines)), ...(targets.length > CAP.targets ? ['', `- ${more(targets.length - CAP.targets)}`] : [])];
  // the rules in force first, the retired ones after them, each group in the file's order
  const rulesInOrder = [...rules.filter((r) => r.status !== 'retired'), ...rules.filter((r) => r.status === 'retired')];
  const rulesBody = [...joinEntries(rulesInOrder.slice(0, CAP.rules).map(ruleLines)), ...(rules.length > CAP.rules ? ['', `- ${more(rules.length - CAP.rules)}`] : [])];
  const flows = graph.flows || [];
  const flowsBody = [...joinEntries(flows.slice(0, CAP.flows).map(flowLines)), ...(flows.length > CAP.flows ? ['', `- ${more(flows.length - CAP.flows)}`] : [])];
  const places = Object.entries(graph.outcomes || {}).filter(([, list]) => Array.isArray(list) && list.length);
  const outcomesBody = [...joinEntries(places.slice(0, CAP.outcomes).map(placeLines)), ...(places.length > CAP.outcomes ? ['', `- ${more(places.length - CAP.outcomes)}`] : [])];
  const healthBody = [...issues.slice(0, CAP.health).map(findingLine), ...(issues.length > CAP.health ? [`- ${more(issues.length - CAP.health)}`] : [])];
  const tasks = recent?.tasks || [];
  const when = String(recent?.updatedAt || '').slice(0, 10);
  const recentBody = tasks.length ? [
    ...(when ? [`- ${t('map.updated', { date: when })}`, ''] : []),
    ...joinEntries(tasks.slice(0, CAP.tasks).map(taskLines)),
    ...(tasks.length > CAP.tasks ? ['', `- ${more(tasks.length - CAP.tasks)}`] : []),
  ] : [];
  // the plans in force first, the switched-off ones after them
  const schedulesInOrder = [...schedules.filter((x) => x.enabled !== false), ...schedules.filter((x) => x.enabled === false)];
  const schedulesBody = [...schedulesInOrder.slice(0, CAP.schedules).map(scheduleLine), ...(schedules.length > CAP.schedules ? [`- ${more(schedules.length - CAP.schedules)}`] : [])];
  const rest = [
    ...section('targets', t('targets.title'), targetsBody), '',
    ...section('rules', t('rules.title'), rulesBody), '',
    ...section('schedules', t('clock.schedules'), schedulesBody), '',
    ...section('flows', t('header.flows'), flowsBody), '',
    ...section('outcomes', t('outcomes.title'), outcomesBody), '',
    ...section('health', t('health.title'), healthBody), '',
    ...section('recent', t('recent.title'), recentBody),
  ];
  const assemble = (partsBody) => [...head, '', ...section('parts', t('map.parts'), partsBody), '', ...rest];

  // ---------- fit the parts into the lines that are left ----------
  const budget = maxLines - 1; // the file ends in a line break, which a count by split('\n') reads as one more line
  let out;
  for (const step of STEPS) {
    out = assemble(joinEntries(ordered.map((n) => partLines(n, step))));
    if (out.length <= budget) break;
  }
  if (out.length > budget) {
    const room = budget - (assemble([]).length - 1);
    const lines = ordered.map(compactLine);
    const body = lines.length <= room ? lines : [...lines.slice(0, Math.max(0, room - 1)), `- ${more(lines.length - Math.max(0, room - 1))}`];
    out = assemble(body);
  }
  return `${out.join('\n')}\n`;
}
