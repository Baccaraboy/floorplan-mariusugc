// floorplan graph queries, shared by the viewer (as page tools for the Claude app) and by
// floorplan/query.mjs (as a CLI that the Claude Code CLI or Codex calls). Plain script: no imports, no exports.
// Item ids: n:<node id>  f:<file path>  r:<route index>  s:<file path>#<export index>  t:<target id> (a target of
// targets.json, as rules and schedules name it)

function createGraphQuery(G) {
  const nodes = new Map(G.nodes.map((n) => [n.id, n]));
  const files = new Map(G.files.map((f) => [f.p, f]));
  const routes = G.routes || [];
  const routesByFile = new Map();
  routes.forEach((r, i) => { if (!routesByFile.has(r.f)) routesByFile.set(r.f, []); routesByFile.get(r.f).push(i); });
  const kidsOf = new Map();
  for (const n of G.nodes) if (n.parent) { if (!kidsOf.has(n.parent)) kidsOf.set(n.parent, []); kidsOf.get(n.parent).push(n.id); }

  const nodeChain = (id) => { const out = []; let n = nodes.get(id); while (n) { out.push(n.id); n = n.parent ? nodes.get(n.parent) : null; } return out; };
  /** The node ids an item lives under, deepest first. */
  function owners(id) {
    if (id.startsWith('n:')) return nodeChain(id.slice(2));
    if (id.startsWith('f:')) { const f = files.get(id.slice(2)); return f ? nodeChain(f.n) : []; }
    if (id.startsWith('r:')) { const r = routes[+id.slice(2)]; return r ? owners('f:' + r.f) : []; }
    if (id.startsWith('s:')) return owners('f:' + id.slice(2).replace(/#\d+$/, ''));
    return [];
  }
  function brief(id) {
    if (id.startsWith('n:')) { const n = nodes.get(id.slice(2)); return n && { id, type: n.kind === 'external' ? 'external' : 'module', name: n.label, description: n.summary || '' }; }
    if (id.startsWith('f:')) { const f = files.get(id.slice(2)); return f && { id, type: 'file', name: f.name, description: f.d || '', path: f.p }; }
    if (id.startsWith('r:')) { const r = routes[+id.slice(2)]; return r && { id, type: 'endpoint', name: r.name, description: r.d || '', path: `${r.m} ${r.p}` }; }
    if (id.startsWith('s:')) {
      const m = /^s:(.*)#(\d+)$/.exec(id); const f = m && files.get(m[1]); const s = f?.s?.[+m[2]];
      return s && { id, type: s[1], name: s[0], description: s[4] || '', path: `${f.p}:${s[2]}` };
    }
    return null;
  }
  const exists = (id) => !!brief(id);
  const inside = (x, container) => x === container || (container.startsWith('n:') && owners(x).includes(container.slice(2))) || (container.startsWith('f:') && (x.startsWith('r:') ? 'f:' + routes[+x.slice(2)].f === container : x.startsWith('s:') ? 'f:' + x.slice(2).replace(/#\d+$/, '') === container : false));
  const ownerItem = (endpoint) => endpoint.startsWith('f:') ? 'n:' + (files.get(endpoint.slice(2))?.n || '') : endpoint;

  /** Accepts an id, or what people naturally pass: a file path, a module id, or "GET /path". */
  function normId(id) {
    id = String(id || '').trim().replace(/^\.\//, '').replace(/\\/g, '/');
    if (brief(id)) return id;
    if (files.has(id)) return 'f:' + id;
    if (nodes.has(id)) return 'n:' + id;
    const m = /^([A-Z]+)\s+(\/\S*)$/i.exec(id);
    if (m) { const ri = routes.findIndex((r) => r.m === m[1].toUpperCase() && r.p === m[2]); if (ri >= 0) return 'r:' + ri; }
    return id;
  }

  const FILLER = new Set(['how', 'does', 'do', 'did', 'the', 'a', 'an', 'is', 'are', 'where', 'what', 'which', 'who', 'of', 'to', 'for', 'in', 'on', 'and', 'or', 'we', 'i', 'my', 'our', 'it', 'work', 'works', 'happen', 'happens', 'get', 'gets', 'with']);
  function find(query, kind, limit = 15) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const terms = words.filter((t) => !FILLER.has(t)).length ? words.filter((t) => !FILLER.has(t)) : words;
    if (!terms.length) return [];
    const pool = [];
    if (!kind || kind === 'module') for (const n of G.nodes) pool.push(['n:' + n.id, n.label, n.summary || '', n.id, 4]);
    if (!kind || kind === 'file') for (const f of G.files) pool.push(['f:' + f.p, f.name, f.d || '', f.p, 3]);
    if (!kind || kind === 'endpoint') routes.forEach((r, i) => pool.push(['r:' + i, r.name, r.d || '', `${r.m} ${r.p}`, 3]));
    if (!kind || kind === 'symbol') for (const f of G.files) (f.s || []).forEach((s, i) => pool.push([`s:${f.p}#${i}`, s[0], s[4] || '', f.p, 1]));
    // everything matching every word; if nothing does, the best partial matches
    const scored = [];
    for (const [id, name, desc, p, w] of pool) {
      const n = name.toLowerCase(), d = desc.toLowerCase(), pp = p.toLowerCase();
      let s = 0, hit = 0;
      for (const t of terms) {
        const sc = n === t ? 30 : n.startsWith(t) ? 20 : n.includes(t) ? 12 : pp.includes(t) ? 7 : d.includes(t) ? 5 : 0;
        if (sc) { s += sc; hit++; }
      }
      if (hit) scored.push([hit, s + w * 2 - n.length * 0.02, id]);
    }
    const best = Math.max(0, ...scored.map((x) => x[0]));
    const floor = best === terms.length ? best : Math.max(1, Math.ceil(terms.length / 2));
    return scored.filter((x) => x[0] >= floor).sort((a, b) => b[0] - a[0] || b[1] - a[1])
      .slice(0, Math.min(Number(limit) || 15, 40)).map(([, , id]) => brief(id));
  }

  function connections(id, max = 15) {
    const out = new Map(), inn = new Map();
    for (const l of G.links) {
      const ia = inside(l.a, id), ib = inside(l.b, id);
      if (ia === ib) continue;
      const other = ia ? l.b : l.a;
      const key = (id.startsWith('n:') ? ownerItem(other) : other) + '|' + l.k;
      const m = ia ? out : inn;
      const cur = m.get(key) || { id: key.split('|')[0], via: l.k, weight: 0, endpoints: new Set() };
      cur.weight += l.w;
      for (const [ri] of l.calls || []) if (ri != null) cur.endpoints.add(ri);
      m.set(key, cur);
    }
    const fmt = (m) => [...m.values()].sort((a, b) => b.weight - a.weight).slice(0, max).map((c) => ({
      ...brief(c.id), via: c.via, weight: c.weight,
      ...(c.endpoints.size ? { endpoints: [...c.endpoints].slice(0, 6).map((ri) => `r:${ri} ${routes[ri].m} ${routes[ri].p}`) } : {}),
    })).filter((x) => x.id);
    return { dependsOn: fmt(out), usedBy: fmt(inn) };
  }

  const unknown = (id) => new Error(`Unknown id "${id}". Use find first; ids look like n:api, f:src/app.ts, r:12, s:src/app.ts#3.`);

  // ---------- the other floors: who writes where, the rules, the clock, what is running, what you see ----------
  // Each reads only G, so a map without the file (targets.json, rules.json, schedules.json, ops.json, flows that say
  // what you see) answers with empty lists, never an error. A target is "t:<id>", as rules and schedules name it; a
  // rule or a schedule on a target reaches the target's box on the map.
  const allTargets = G.targets || [], allRules = G.rules || [], allSchedules = G.schedules || [], allFlows = G.flows || [], allOutcomes = G.outcomes || {}, opsData = G.ops || null;
  const targetById = new Map(allTargets.map((t) => [t.id, t]));
  const nameOf = (id) => (id.startsWith('t:') ? targetById.get(id.slice(2))?.name ?? id.slice(2) : brief(id)?.name ?? id);
  /** A card or a target as { id, name }; a target with its box on the map, when it has one. */
  const ref = (id) => { const t = id.startsWith('t:') ? targetById.get(id.slice(2)) : null; return { id, name: nameOf(id), ...(t?.node && exists(t.node) ? { box: t.node } : {}) }; };
  /** The chain up from an item: itself, its file (an endpoint or an export), its part and the parts above it; a target, then its box's chain. */
  function chainOf(id) {
    if (id.startsWith('t:')) { const t = targetById.get(id.slice(2)); return [id, ...(t?.node && exists(t.node) ? chainOf(t.node) : [])]; }
    const out = [id];
    if (id.startsWith('r:')) { const r = routes[+id.slice(2)]; if (r) out.push('f:' + r.f); }
    if (id.startsWith('s:')) out.push('f:' + id.slice(2).replace(/#\d+$/, ''));
    for (const n of owners(id)) if (!out.includes('n:' + n)) out.push('n:' + n);
    return out;
  }
  /** Whether y is x, or lies inside it. */
  const within = (y, x) => chainOf(y).includes(x);
  /** The box on the map a target stands on, else the card itself. */
  const boxOf = (id) => (id.startsWith('t:') ? targetById.get(id.slice(2))?.node || null : id);
  /** What the words name: a card (an id, a path, a part id or "METHOD /path") or a target (its id, or "t:<id>"); null when neither. A part wins over a target with the same id. */
  function placeOf(s) {
    const id = normId(s);
    if (exists(id)) return id;
    const t = String(s || '').trim().replace(/^t:/, '');
    return targetById.has(t) ? 't:' + t : null;
  }
  const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  /** Whether every word of the query is in one of the texts, whatever the case; an empty query matches everything. */
  function hasWords(query, ...texts) {
    const hay = texts.filter((x) => x != null).map((x) => String(Array.isArray(x) ? x.join(' ') : x).toLowerCase()).join('\n');
    return String(query || '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  /** Who writes where: every target, or those whose id, name, kind or note has every word; writers and readers as cards with names. */
  function targets(query) {
    const side = (list) => list.flatMap((e) => e.items.map((id) => ({ ...ref(id), ref: e.ref, ...(e.in ? { within: e.in } : {}) })));
    return allTargets.filter((t) => hasWords(query, t.id, t.name, t.kind, t.note)).map((t) => ({
      id: t.id, name: t.name, kind: t.kind, policy: t.policy, conflict: !!t.conflict, writerCount: t.writerCount, ...(t.note ? { note: t.note } : {}),
      box: t.node && exists(t.node) ? ref(t.node) : null, writers: side(t.writers || []), readers: side(t.readers || []),
      // calls the scan saw into the target's box from parts the list doesn't name
      ...(t.undeclared?.length ? { undeclared: t.undeclared.map((u) => ({ ...ref(u.part), direction: u.dir, calls: u.calls.length })) } : {}),
    }));
  }

  const ruleOut = (r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, ...(r.since ? { since: r.since } : {}), ...(r.until ? { until: r.until } : {}), source: r.source, text: r.text, ...(r.tags ? { tags: r.tags } : {}), everywhere: !r.items.length, appliesTo: r.items.map(ref) });
  const inForceFirst = (list) => [...list.filter((r) => r.status !== 'retired'), ...list.filter((r) => r.status === 'retired')];
  /** The item through which a rule reaches a place, nearest first: the place itself, its file, its part or a parent, or a target whose box is one of them; null when it doesn't. */
  function reachesVia(r, place) {
    const stands = new Map();
    for (const item of r.items) for (const b of [item, boxOf(item)]) if (b && !stands.has(b)) stands.set(b, item);
    for (const c of chainOf(place)) if (stands.has(c)) return stands.get(c);
    return null;
  }
  /** The rules and decisions: all of them, those with every word in id, kind, title, text or tags, or those that hold at a place (a card or a target): the ones that name it, its file, its part or a parent first, each with the card it reaches it through, then the project-wide ones. The retired ones come after the ones in force. */
  function rules(arg) {
    const s = String(arg || '').trim();
    const place = s ? placeOf(s) : null;
    if (place) {
      const here = inForceFirst(allRules).map((r) => [r, r.items.length ? reachesVia(r, place) : null]).filter(([r, via]) => via || !r.items.length);
      return [...here.filter(([, via]) => via), ...here.filter(([, via]) => !via)].map(([r, via]) => ({ ...ruleOut(r), ...(via ? { via: ref(via) } : {}) }));
    }
    return inForceFirst(allRules).filter((r) => hasWords(s, r.id, r.kind, r.title, r.text, r.tags)).map(ruleOut);
  }

  const DAY = 24 * 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  /** The minute of the day now, on the plan's own clock (its time zone, else this computer's). */
  const minuteNow = (tz) => {
    try {
      const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
      return ((+p.find((x) => x.type === 'hour').value) % 24) * 60 + +p.find((x) => x.type === 'minute').value;
    } catch { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  };
  /** The next start of the day: when, on the plan's clock, and in how many minutes; null for a plan without a daily time or switched off. */
  const nextStart = (s) => {
    if (s.enabled === false || !s.times?.length) return null;
    const now = minuteNow(s.tz);
    const at = s.times.find((x) => x >= now) ?? s.times[0];
    return { at: hhmm(at), ...(s.tz ? { tz: s.tz } : {}), inMinutes: at >= now ? at - now : DAY - now + at };
  };
  /** What starts a plan: a card when it is on the map, else the path of the workflow or crontab the scan saw. */
  const triggerOf = (s) => (!s.trigger ? null : /^[nfr]:/.test(s.trigger) && exists(s.trigger) ? ref(s.trigger) : { path: s.trigger });
  /** What a clock starts: every plan with its cron in words, its time zone, what starts it, what it runs, and the next start of the day. */
  function schedules() {
    return allSchedules.map((s) => ({
      id: s.id, title: s.title, cron: s.cron ?? null, human: s.human ?? null, tz: s.tz ?? null, enabled: s.enabled !== false, found: !!s.found, kind: s.kind ?? null,
      trigger: triggerOf(s), runs: (s.runs || []).map(ref), calls: s.calls ?? null, note: s.note ?? null, source: s.source ?? null, times: s.times || [], next: nextStart(s),
    }));
  }
  /** The cards a plan touches: its trigger and what it runs, a target by its box. */
  const cardsOf = (s) => [...(s.trigger && /^[nfr]:/.test(s.trigger) && exists(s.trigger) ? [s.trigger] : []), ...(s.runs || []).map(boxOf).filter(Boolean)];

  // the order of the list, and of "worst": down, then warn, then ok; unknown only when nothing else is known
  const RANK = { down: 0, warn: 1, ok: 2, unknown: 3 };
  const byWorst = (list) => list.slice().sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
  const worstOf = (list) => byWorst(list)[0]?.status ?? null;
  const opsItem = (it) => { const { id, ...rest } = it; return { id, name: nameOf(id), ...rest }; };
  /** What is running, as the owner's tooling last reported it: every entry worst first with the time of the report, or one place with the entries at it and inside it and the worst of them. */
  function ops(where) {
    const head = { asOf: opsData?.asOf ?? null, source: opsData?.source ?? null, stale: !!opsData?.stale };
    const items = opsData?.items || [];
    if (!given(where)) return { ...head, counts: opsData?.counts || { ok: 0, warn: 0, down: 0, unknown: 0 }, items: byWorst(items).map(opsItem) };
    const place = placeOf(where);
    if (!place) throw unknown(where);
    const box = boxOf(place);
    const mine = box ? items.filter((it) => within(it.id, box)) : [];
    return { ...head, id: place, name: nameOf(place), status: worstOf(mine), items: byWorst(mine).map(opsItem) };
  }

  const flowById = new Map(allFlows.map((f) => [f.id, f]));
  /** A sentence that arrives at a place: from which flow and step, with its example. */
  const arrival = (o) => {
    const f = flowById.get(o.flow), step = o.step != null ? f?.steps?.[o.step] : null;
    return { flow: { id: o.flow, title: f?.title ?? o.flow }, ...(step ? { step: { index: o.step, ...ref(step.ref) } } : {}), text: o.text, ...(o.example ? { example: o.example } : {}) };
  };
  const placesSeen = () => Object.entries(allOutcomes).filter(([, list]) => Array.isArray(list) && list.length);
  /** What you see, by place: what arrives at each place (a phone, a mailbox, a calendar) and from which flow and step; or at one place and the places inside it. */
  function outcomes(where) {
    let places = placesSeen();
    if (given(where)) {
      const place = placeOf(where);
      if (!place) throw unknown(where);
      const box = boxOf(place);
      places = box ? places.filter(([w]) => within(w, box)) : [];
    }
    return places.map(([w, list]) => ({ where: ref(w), arrives: list.map(arrival) }));
  }
  const seen = (v) => ({ where: ref(v.where), text: v.text, ...(v.example ? { example: v.example } : {}) });
  /** Every flow: what starts it (a clock's words when a schedule is behind it), its steps with what you see at one, and what you have in the end. A flow without those fields is just its steps. */
  function flows() {
    return allFlows.map((f) => ({
      id: f.id, title: f.title, ...(f.description ? { description: f.description } : {}), ...(f.custom ? { custom: true } : {}),
      ...(f.trigger ? { trigger: { kind: f.trigger.kind, text: f.trigger.text, ...(f.trigger.node ? { at: ref(f.trigger.node) } : {}), ...(f.trigger.schedule ? { schedule: f.trigger.schedule } : {}), ...(f.trigger.when ? { when: f.trigger.when } : {}), ...(f.trigger.tz ? { tz: f.trigger.tz } : {}), ...(f.trigger.cron ? { cron: f.trigger.cron } : {}) } } : {}),
      steps: f.steps.map((s) => ({ ...ref(s.ref), note: s.note, ...(s.you_see ? { youSee: seen(s.you_see) } : {}) })),
      ...(f.outcome ? { outcome: seen(f.outcome) } : {}),
    }));
  }
  /** The floors at a card, each only when there is something: the rules here, the targets it writes and reads (or stands for), the schedules here, its status and what you see here. */
  function floorsAt(id) {
    const res = {};
    const rulesHere = allRules.filter((r) => r.items.length && reachesVia(r, id));
    if (rulesHere.length) res.rulesHere = rulesHere.map((r) => ({ id: r.id, title: r.title }));
    // a part writes or reads a target when one of its own items, or one of a part inside it, is listed there
    const touching = (side) => allTargets.flatMap((t) => { const hit = (t[side] || []).flatMap((e) => e.items).find((y) => within(y, id)); return hit ? [{ ...ref('t:' + t.id), ...(hit !== id ? { via: ref(hit) } : {}) }] : []; });
    const written = touching('writers'), read = touching('readers');
    if (written.length) res.targetsWritten = written;
    if (read.length) res.targetsRead = read;
    const box = allTargets.filter((t) => t.node === id);
    if (box.length) res.boxOf = box.map((t) => ({ id: 't:' + t.id, name: t.name }));
    const here = allSchedules.filter((s) => s.enabled !== false && cardsOf(s).some((c) => within(c, id)));
    if (here.length) res.schedulesHere = here.map((s) => ({ id: s.id, title: s.title, when: s.human || s.cron || '' }));
    const mine = (opsData?.items || []).filter((it) => within(it.id, id));
    if (mine.length) {
      const { id: _id, ref: _ref, status: _status, ...fields } = mine.find((it) => it.id === id) || {};
      const inside = byWorst(mine.filter((it) => it.id !== id));
      res.ops = { status: worstOf(mine), ...fields, ...(inside.length ? { inside: inside.map((it) => ({ ...ref(it.id), status: it.status })) } : {}) };
    }
    const arriving = placesSeen().filter(([w]) => within(w, id)).flatMap(([, list]) => list);
    if (arriving.length) res.youSeeHere = arriving.map((o) => { const a = arrival(o); return { flow: a.flow, text: a.text, ...(a.example ? { example: a.example } : {}) }; });
    return res;
  }
  /** The floors in numbers, and how to ask for each; only the floors the project filled in, so a map without them is unchanged. */
  function floors() {
    const out = {};
    if (allTargets.length) out.targets = { count: allTargets.length, conflicts: allTargets.filter((t) => t.conflict).length, ask: 'targets [words]' };
    if (allRules.length) { const n = allRules.filter((r) => r.kind === 'rule').length; out.rules = { rules: n, decisions: allRules.length - n, retired: allRules.filter((r) => r.status === 'retired').length, ask: 'rules [words | id]' }; }
    if (allSchedules.length) {
      const found = allSchedules.filter((s) => s.found).length;
      const next = allSchedules.map((s) => [s, nextStart(s)]).filter(([, n]) => n).sort((a, b) => a[1].inMinutes - b[1].inMinutes)[0];
      out.schedules = { count: allSchedules.length, found, declared: allSchedules.length - found, off: allSchedules.filter((s) => s.enabled === false).length, ...(next ? { next: `${next[1].at}${next[0].tz ? ` ${next[0].tz}` : ''} ${next[0].title}` } : {}), ask: 'schedules' };
    }
    if (opsData?.items?.length) out.ops = { asOf: opsData.asOf, stale: !!opsData.stale, counts: opsData.counts, ask: 'ops [id]' };
    const places = placesSeen().length;
    if (places) out.outcomes = { places, ask: 'outcomes [id]' };
    return Object.keys(out).length ? out : null;
  }

  function show(id) {
    id = normId(id);
    const b = brief(id);
    if (!b) throw unknown(id);
    const parent = owners(id)[id.startsWith('n:') ? 1 : 0];
    const res = { ...b, ...(parent ? { partOf: brief('n:' + parent) && { id: 'n:' + parent, name: nodes.get(parent).label } } : {}) };
    const recent = (G.recent?.items || []).filter((x) => x.id === id);
    if (recent.length) res.recentWork = recent.map((x) => `${G.recent.tasks[x.task]?.title}: ${x.note}`);
    if (id.startsWith('n:')) {
      const n = nodes.get(id.slice(2));
      if (n.details) res.details = n.details;
      res.size = { files: n.stats.files, loc: n.stats.loc };
      res.children = (kidsOf.get(n.id) || []).map((k) => ({ id: 'n:' + k, name: nodes.get(k).label, description: nodes.get(k).summary || '' }));
      const fl = G.files.filter((f) => owners('f:' + f.p).includes(n.id)).sort((a, z) => z.loc - a.loc);
      res.files = fl.slice(0, 12).map((f) => ({ id: 'f:' + f.p, name: f.name, description: f.d || '' }));
      if (fl.length > 12) res.moreFiles = fl.length - 12;
      res.endpoints = routes.filter((r) => owners('f:' + r.f).includes(n.id)).length;
      Object.assign(res, connections(id));
    } else if (id.startsWith('f:')) {
      const f = files.get(id.slice(2));
      Object.assign(res, { loc: f.loc, module: { id: 'n:' + f.n, name: nodes.get(f.n)?.label }, ...(f.note ? { note: f.note } : {}) });
      const rs = routesByFile.get(f.p) || [];
      if (rs.length) res.endpoints = rs.slice(0, 40).map((ri) => ({ id: 'r:' + ri, method: routes[ri].m, path: routes[ri].p, name: routes[ri].name }));
      const handlers = new Set(rs.map((ri) => routes[ri].h));
      const ex = (f.s || []).map((s, i) => [s, i]).filter(([s]) => !handlers.has(s[0]));
      if (ex.length) res.exports = ex.slice(0, 30).map(([s, i]) => `s:${f.p}#${i} ${s[0]} (${s[1]})`);
      Object.assign(res, connections(id, 20));
    } else if (id.startsWith('r:')) {
      const ri = +id.slice(2), r = routes[ri];
      Object.assign(res, { method: r.m, routePath: r.p, handler: r.h, line: r.l, file: { id: 'f:' + r.f, name: files.get(r.f)?.name } });
      const callers = new Map();
      for (const l of G.links) { const n = (l.calls || []).filter(([x]) => x === ri).length; if (n) callers.set(l.a, (callers.get(l.a) || 0) + n); }
      res.calledFrom = [...callers.entries()].map(([a, n]) => ({ ...brief(a), calls: n }));
    } else {
      const m = /^s:(.*)#(\d+)$/.exec(id); const f = files.get(m[1]); const s = f.s[+m[2]];
      res.file = { id: 'f:' + f.p, name: f.name };
      res.importedBy = G.links.filter((l) => l.b === 'f:' + f.p && (l.names || []).some((nm) => nm === s[0] || (nm === 'default' && s[3]))).slice(0, 25).map((l) => brief(l.a));
    }
    // the other floors at this card, only where the project filled them in
    Object.assign(res, floorsAt(id));
    return res;
  }

  /** Shortest dependency chain from anything inside `from` to anything inside `to`. */
  function path(from, to) {
    from = normId(from); to = normId(to);
    if (!exists(from) || !exists(to)) throw new Error('Unknown id; use find first.');
    const adj = new Map();
    const add = (a, b, l) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push([b, l]); };
    for (const l of G.links) add(l.a, l.b, l);
    const starts = [...new Set([...G.links.map((l) => l.a), ...G.links.map((l) => l.b)])].filter((x) => inside(x, from));
    const isGoal = (x) => inside(x, to);
    const prev = new Map(starts.map((s) => [s, null]));
    const queue = [...starts];
    let goal = null;
    while (queue.length && !goal) {
      const x = queue.shift();
      for (const [y, l] of adj.get(x) || []) {
        if (prev.has(y)) continue;
        prev.set(y, [x, l]);
        if (isGoal(y)) { goal = y; break; }
        queue.push(y);
      }
    }
    if (!goal) return { found: false, note: `No chain of imports/calls leads from ${from} to ${to}. Try the reverse direction, or the two may only meet through a shared dependency.` };
    const hops = [];
    for (let x = goal; prev.get(x); x = prev.get(x)[0]) {
      const [p, l] = prev.get(x);
      hops.unshift({ from: brief(p), to: brief(x), via: l.k, ...(l.calls?.length ? { endpoints: l.calls.slice(0, 3).map(([ri]) => ri != null ? `r:${ri} ${routes[ri].m} ${routes[ri].p}` : '').filter(Boolean) } : {}) });
    }
    return { found: true, hops: hops.slice(0, 15) };
  }

  function overview() {
    const fl = floors();
    return {
      project: G.project.name, summary: G.project.summary || '',
      systems: G.nodes.filter((n) => !n.parent).map((n) => ({ id: 'n:' + n.id, name: n.label, kind: n.kind, description: n.summary || '', modules: (kidsOf.get(n.id) || []).map((k) => `n:${k} ${nodes.get(k).label}`) })),
      // with what starts a flow and what the owner has in the end, when the flow says so
      flows: (G.flows || []).map((f) => ({
        title: f.title, ...(f.trigger ? { startsWhen: f.trigger.text } : {}), steps: f.steps.map((s) => `${s.ref} ${s.note}`),
        ...(f.steps.some((s) => s.you_see) ? { youSee: f.steps.filter((s) => s.you_see).map((s) => `${s.you_see.where} ${s.you_see.text}`) } : {}),
        ...(f.outcome ? { inTheEnd: `${f.outcome.where} ${f.outcome.text}` } : {}),
      })),
      counts: { files: G.files.length, endpoints: routes.length },
      // the other floors in numbers, each with the query that lists it (targets, rules, schedules, ops, outcomes)
      ...(fl ? { floors: fl } : {}),
      ...(G.recent ? { recentWork: (G.recent.tasks || []).map((t, ti) => ({ title: t.title, request: t.request, summary: t.summary, changed: G.recent.items.filter((x) => x.task === ti).map((x) => `${x.id} ${x.note}`) })) } : {}),
    };
  }

  return { find, show, path, overview, targets, rules, schedules, ops, outcomes, flows, exists, brief };
}

// What an answer looks like, for both engines (JSON Schema).
const FLOORPLAN_ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short title for the answer view, at most 6 words.' },
    answer: { type: 'string', description: 'The answer in Markdown, at most ~180 words. Mention map items inline as [[id]].' },
    items: { type: 'array', description: '3-14 map items most relevant to the answer, most important first.', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', description: 'Why this item matters here, at most 15 words.' } }, required: ['id', 'note'] } },
    steps: { type: 'array', description: 'Optional ordered walkthrough when the answer is a sequence (a request path, a data flow). Empty otherwise.', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] } },
    followups: { type: 'array', description: '2-3 short follow-up questions the person might ask next.', items: { type: 'string' } },
  },
  required: ['title', 'answer', 'items'],
};

// A requested flow: an ordered walkthrough of map items (JSON Schema).
const FLOORPLAN_FLOW_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short flow title, at most 6 words, e.g. "Checkout to Stripe payment".' },
    description: { type: 'string', description: 'One sentence on what the flow shows.' },
    steps: { type: 'array', description: '3-9 steps in the order things happen, each a map item and what happens there.', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', description: 'What happens at this step, at most 18 words.' } }, required: ['id', 'note'] } },
  },
  required: ['title', 'steps'],
};

// A requested change to a blueprint: the whole updated plan.json and architecture.json, and what changed
// (JSON Schema). The documents travel as JSON text so the schema stays the same for every engine.
const FLOORPLAN_CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'What changed, 2-6 words, e.g. "Planned out payments".' },
    summary: { type: 'string', description: 'Markdown, at most ~150 words, plain words: what you added, changed or removed and why, plus any new assumptions or open questions.' },
    plan: { type: 'string', description: 'The complete updated floorplan/plan.json, as JSON text.' },
    architecture: { type: 'string', description: 'The complete updated floorplan/architecture.json, as JSON text.' },
    changes: { type: 'array', description: 'Every new or changed card: a file path, node id or "METHOD /path".', items: { type: 'object', properties: { ref: { type: 'string' }, change: { type: 'string', enum: ['new', 'changed'] }, note: { type: 'string', description: 'How this card serves the request, one plain sentence.' } }, required: ['ref', 'change', 'note'] } },
    followups: { type: 'array', description: '2-3 short changes the person might ask for next.', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'plan', 'architecture', 'changes'],
};

/** A map in another language than English ("lang" in architecture.json): the line asking the agent to write in it. */
function floorplanLanguageLine(G) {
  const code = G.meta?.lang;
  if (!code || code === 'en') return [];
  let name = code;
  try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch {}
  return [`The map is in ${name}: write every title, description, note, answer and follow-up in ${name}.`];
}

function floorplanChangeInstructions(G) {
  const src = G.meta?.blueprint?.source;
  return [
    `You change a blueprint: an interactive map of "${G.project.name}", a system that is planned but not built yet. The person looking at it asks for a change, addition or removal ("also plan out payments", "drop the admin page", "staff should sign in with Google"), and you update the plan.`,
    `Read floorplan/plan.json and floorplan/architecture.json first${src ? `, and ${src} (the PRD it was planned from) when the request touches what the PRD says` : ''}. You can look things up on the map with \`node floorplan/query.mjs find "<words>"\` and \`show <id>\`.`,
    'plan.json format: { source, stack[], assumptions[], questions[{question, about[]}], files[{path, name, description, screen?, uses[], calls["METHOD /path"], services[node ids], data[node ids]}], endpoints[{method, path, file, name, description, access: public|signed-in|team|webhook|internal, who?, publicBecause?}] }. Every endpoint\'s file is a planned file, every call matches a planned endpoint exactly, and services/data name nodes in architecture.json.',
    'architecture.json: { project, nodes[{id, label, kind, parent?, summary, paths[globs]}], edges[], flows[{id, title, steps[{node, note}]}], tour[] }. Kinds: ui service worker library feature data config test script infra external. External nodes (outside services, the database) own no files. Every planned file must fall under some node\'s paths, so add or widen globs for new folders. Flow and tour steps point at node ids or planned file paths.',
    'Change only what the request needs, the way the rest of the plan is written: same stack and conventions, plain language for everyone, real file paths. Keep every other file, endpoint, id and description exactly as it is. If the PRD or plan already decided something, follow it; record a new choice in assumptions and a real open decision in questions. If the request removes something, remove everything that only it used. If it answers one of plan.json\'s questions, remove that question, build the answer into the plan, and record it in assumptions; if it settles who may use an endpoint, set access (and who or publicBecause). Many requests come from the map\'s design review: settle exactly what it names.',
    'Reply with JSON only: {"title", "summary", "plan", "architecture", "changes", "followups"}. plan and architecture are the complete updated files as JSON text, not just the changed parts. changes lists every new or changed file, endpoint ("METHOD /path") or node id with a note on how it serves the request.',
    'Do not edit any files yourself: the map server checks your JSON, saves it and redraws the map.',
    ...floorplanLanguageLine(G),
  ].join('\n');
}

function floorplanFlowInstructions(G, engine) {
  return [
    `You build guided flows for an interactive architecture map of the codebase "${G.project.name}". A flow is an ordered walkthrough: each step is one map item (module n:..., file f:..., endpoint r:..., or export s:...) and a note on what happens there.`,
    engine === 'cli'
      ? 'Find the items with `node floorplan/query.mjs find "<words>"`, `show <id>` and `path <fromId> <toId>`; read source files when you need to confirm the order of events.'
      : 'Find the items with the tools find_items, get_item and dependency_path.',
    'Trace what the person asks for from its trigger (a user action, webhook, cron job) to its final effect (database write, external call, response).',
    'Use 3-9 steps. Prefer the most specific item that tells the story (an endpoint over its file, a file over its module), and make consecutive steps things that really call or import each other.',
    'Reply with JSON only: {"title", "description", "steps": [{"id", "note"}]}. Only use ids the map gave you.',
    ...floorplanLanguageLine(G),
  ].join('\n');
}

/**
 * The map's other floors, when the project filled them in: one line per floor saying what it holds and how to ask for it,
 * so the agent asks the map ("who may write to the orders table", "which rule holds here", "when does the report run",
 * "is the worker up", "what do I see on my phone") before it reads code. Nothing for a map without them.
 */
function floorplanFloorLines(G, engine) {
  const targets = G.targets || [], rules = G.rules || [], schedules = G.schedules || [], ops = G.ops?.items?.length ? G.ops : null;
  const places = Object.values(G.outcomes || {}).filter((l) => Array.isArray(l) && l.length).length;
  const told = (G.flows || []).some((f) => f.trigger || f.outcome); // a flow that says what starts it, or what you have in the end
  if (!targets.length && !rules.length && !schedules.length && !ops && !places && !told) return [];
  if (engine !== 'cli') return ['The map has more floors: the overview below counts them (floors), and get_item shows them at a card: the rules here, the targets it writes and reads, the schedules here, its status as the owner\'s tooling reported it, and what you see here. Answer from them when the question is about who writes where, which rule holds, when something runs, what is running or what the owner sees.'];
  const q = (cmd) => `\`node floorplan/query.mjs ${cmd}\``;
  const n = (k, v) => `${v} ${k}${v === 1 ? '' : 's'}`;
  const lines = ['The map has more floors. Ask them before you read code; `show <id>` lists them at a card (rulesHere, targetsWritten, targetsRead, schedulesHere, ops, youSeeHere), and `overview` counts them (floors):'];
  if (targets.length) { const c = targets.filter((t) => t.conflict).length; lines.push(`- ${q('targets [words]')}: who writes where, every target with its writers, readers and one-writer conflicts (${n('target', targets.length)}${c ? `, ${c} with more than one writer` : ''}).`); }
  if (rules.length) { const r = rules.filter((x) => x.kind === 'rule').length; lines.push(`- ${q('rules [words | id]')}: the rules and decisions, or those that hold at a part, file, endpoint or target, through its parents (${n('rule', r)}, ${n('decision', rules.length - r)}).`); }
  if (schedules.length) lines.push(`- ${q('schedules')}: what a clock starts, when (in words and as cron), and the next start of the day (${n('schedule', schedules.length)}).`);
  if (ops) lines.push(`- ${q('ops [id]')}: what is running, as the owner's tooling reported it at ${ops.asOf}${ops.stale ? ' (stale: more than a day old)' : ''}: a status, version, last run and last error per card.`);
  if (places) lines.push(`- ${q('outcomes [id]')} and ${q('flows')}: what you see at each place (a phone, a mailbox, a calendar; ${n('place', places)}), and what starts each flow and what you have in the end.`);
  else if (told) lines.push(`- ${q('flows')}: every flow with what starts it and what you have in the end.`);
  return lines;
}

function floorplanAskInstructions(G, engine) {
  const tools = engine === 'cli'
    ? `Query the map from the shell: \`node floorplan/query.mjs overview\`, \`node floorplan/query.mjs find "<words>" [--kind module|file|endpoint|symbol]\`, \`node floorplan/query.mjs show <id>\`, \`node floorplan/query.mjs path <fromId> <toId>\`. Every result is JSON with ids. Start with the map; read or grep source files when you need specifics the map does not have.`
    : `Use the tools find_items, get_item and dependency_path to explore the map. You cannot read source files, so answer from the map's names, descriptions, endpoints and connections, and say so when a question needs the code itself.`;
  const bp = G.meta?.blueprint;
  return [
    `You answer questions about the codebase "${G.project.name}" for someone exploring an interactive architecture map of it.`,
    `The map has cards for modules (ids n:...), files (f:<path>), HTTP endpoints (r:<number>) and exported symbols (s:<path>#<number>), each with a human-readable name and description, connected by imports and HTTP calls.`,
    tools,
    ...floorplanFloorLines(G, engine),
    bp ? `This map is a blueprint: a plan of a system that hasn't been built yet, so its files don't exist.${engine === 'cli' ? ` Instead of source files, read floorplan/plan.json${bp.source ? ` and ${bp.source} (what it was planned from)` : ''} when you need more than the map.` : ''} Answer about what would be built and why, and say plainly when the plan doesn't cover something.` : '',
    'Use a few lookups, not dozens. Then reply with JSON only: {"title", "answer", "items", "steps", "followups"}.',
    '- answer: Markdown, at most ~180 words, plain and specific. Refer to map items inline as [[id]] (they become clickable).',
    '- items: the 3-14 cards that best show the answer, most important first, each with a note (at most 15 words) on its role.',
    '- steps: an ordered walkthrough when the answer is a sequence (a request path, a data flow); otherwise [].',
    '- followups: 2-3 short follow-up questions.',
    'Only use ids that the map gave you.',
    ...floorplanLanguageLine(G),
  ].filter(Boolean).join('\n');
}
