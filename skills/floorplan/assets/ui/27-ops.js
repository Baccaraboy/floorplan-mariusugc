// Operations: graph.ops (from floorplan/ops.json) is what the owner's own tooling reports about the running system,
// never what the build or the AI guessed: a status per part, file, endpoint or target, the version it runs, when it
// last ran and last ran well, its last error, a note and a few numbers. This adds an Ops switch to the top bar that
// gives every box with an item a status dot (a part shows the worst status inside it) and hover lines, a panel that
// lists every item worst first (a click goes to its box) with the time of the data and a warning when it's stale, and,
// on a map served by serve.mjs, a fresh copy of the file from the server every minute, so the owner's scripts can
// rewrite it without a rebuild. A static copy keeps what the build saw. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const baked = SC && SC.graph.ops;
  if (!baked || !Array.isArray(baked.items) || !baked.items.length) return;
  const { h, t, tn } = SC;

  SC.icons.ops = '<path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>';

  const style = document.createElement('style');
  style.textContent = `
    #btn-ops.on { background: rgba(var(--ink), .1); color: var(--text); }
    #btn-ops .badge { background: var(--ops-badge, var(--sev-medium)); color: var(--on-sev-text); }
    .ops-ok { --ops: var(--ok); } .ops-warn { --ops: var(--sev-medium); } .ops-down { --ops: var(--sev-high); } .ops-unknown { --ops: var(--sev-low); }
    /* the dot on a box's top right corner: a ring in the surface colour keeps it readable on the card's edge */
    .ops-dot { pointer-events: none; animation: fadeIn .55s var(--ease) both; }
    .ops-dot .ops-ring { fill: var(--surface); }
    .ops-dot .ops-core { fill: var(--ops); }
    .ops-dot.ops-down .ops-core { animation: opsPulse 1.6s ease-in-out infinite; }
    @keyframes opsPulse { 50% { opacity: .35; } }
    svg.dim .node:not(.hl) .ops-dot { opacity: .28; }
    #tooltip .ops-tip { margin-top: 9px; padding: 8px 10px; border-radius: 11px; background: color-mix(in srgb, var(--ops) 10%, transparent); }
    #tooltip .ops-th { display: flex; align-items: center; gap: 6px; color: var(--ops); font-size: 11.5px; font-weight: 600; }
    #tooltip .ops-th::before, .ops-card .ops-th::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
    .ops-tn { color: var(--text); margin-top: 3px; }
    .ops-tm { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; color: var(--text-2); font-size: 12px; }
    .ops-tm b { font-weight: 500; color: var(--text-3); }
    .ops-card { margin-top: 10px; padding: 10px 12px; border-radius: 14px; background: color-mix(in srgb, var(--ops) 9%, transparent); font-size: 13px; line-height: 1.55; }
    .ops-card:first-child { margin-top: 0; }
    .ops-card + h3 { margin-top: 16px; }
    .ops-card .ops-th { display: flex; align-items: center; gap: 6px; color: var(--ops); font-size: 11.5px; font-weight: 600; margin-bottom: 3px; }
    .ops-card .ops-tn { color: var(--text-2); font-size: 12.5px; }
    .ops-err { color: var(--sev-high); }
    .ops-meta { color: var(--text-3); font-size: 12.5px; line-height: 1.55; margin-top: 8px; }
    .ops-stale { margin-top: 10px; padding: 8px 11px; border-radius: 12px; background: var(--warn-bg); color: var(--warn-text); font-size: 12.5px; line-height: 1.5; }
    .ops-stale b { font-weight: 600; }
    .ops-sum { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin: 0 0 8px; }
    .ops-foot { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin-top: 8px; }
    .ops-foot a { color: var(--text); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
  `;
  document.head.appendChild(style);

  // ---------- words and colours ----------
  const STATUSES = ['ok', 'warn', 'down', 'unknown'];
  const STATUS = { ok: t('ops.status.ok'), warn: t('ops.status.warn'), down: t('ops.status.down'), unknown: t('ops.status.unknown') };
  const COLOR = { ok: 'var(--ok)', warn: 'var(--sev-medium)', down: 'var(--sev-high)', unknown: 'var(--sev-low)' };
  // the order of the list, and of "worst": down, then warn, then ok; unknown only when nothing else is known
  const RANK = { down: 0, warn: 1, ok: 2, unknown: 3 };
  const worst = (list) => list.map((x) => x.status).sort((a, b) => RANK[a] - RANK[b])[0] || 'unknown';
  const DAY = 24 * 60 * 60 * 1000;
  const fmtTime = (s) => { const at = Date.parse(s || ''); return Number.isNaN(at) ? String(s || '') : new Date(at).toLocaleString(SC.lang === 'en' ? undefined : SC.lang, { dateStyle: 'medium', timeStyle: 'short' }); };

  // ---------- the data: the build's copy, then the server's ----------
  const entity = (id) => String(id).replace(/^x:(in|out):/, '').replace(/^m:/, 'f:');
  const targets = SC.graph.targets || [];
  /** A ref as the owner writes it (a node id, a file path, "METHOD /path", a target id) to the id of its box, or null. */
  function resolve(ref) {
    if (typeof ref !== 'string') return null;
    const s = ref.trim().replace(/^\.\//, '').replace(/^(route:|file:)/, '');
    if (/^[nfr]:/.test(s)) return SC.exists(s) ? s : null;
    if (SC.nodes.has(s)) return 'n:' + s;
    if (SC.files.has(s)) return 'f:' + s;
    const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(s);
    if (m) { const i = SC.routes.findIndex((r) => r.m === m[1].toUpperCase() && r.p === m[2]); if (i >= 0) return 'r:' + i; }
    const tg = targets.find((x) => x.id === s);
    return tg && tg.node && SC.exists(tg.node) ? tg.node : null;
  }
  const line = (v) => (v === undefined || v === null || v === '' ? null : String(v).split('\n')[0].trim().slice(0, 300) || null);
  /** The file as the build checks it, for a copy fetched from the server: one line per field, unknown refs left out. */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
    const items = [];
    for (const it of raw.items) {
      if (!it || typeof it !== 'object') continue;
      const id = typeof it.id === 'string' && SC.exists(it.id) ? it.id : resolve(it.ref);
      if (!id) continue;
      const out = { id, ref: line(it.ref) || id, status: STATUSES.includes(it.status) ? it.status : 'unknown' };
      for (const k of ['version', 'lastRun', 'lastOk', 'lastError', 'note']) { const v = line(it[k]); if (v) out[k] = v; }
      if (it.metrics && typeof it.metrics === 'object' && !Array.isArray(it.metrics)) {
        const m = {};
        for (const [k, v] of Object.entries(it.metrics).slice(0, 12)) if (['number', 'string', 'boolean'].includes(typeof v)) m[line(k).slice(0, 40)] = typeof v === 'string' ? line(v).slice(0, 80) : v;
        if (Object.keys(m).length) out.metrics = m;
      }
      items.push(out);
    }
    const asOf = typeof raw.asOf === 'string' && !Number.isNaN(Date.parse(raw.asOf)) ? raw.asOf : null;
    return { asOf, source: line(raw.source), items };
  }
  let data = normalize(baked) || { asOf: null, source: null, items: [] };
  const isStale = () => !data.asOf || Date.now() - Date.parse(data.asOf) > DAY;
  let own = new Map(), inside = new Map(); // box -> its items; part or folder -> the items inside it
  function index() {
    own = new Map(); inside = new Map();
    for (const it of data.items) {
      if (!own.has(it.id)) own.set(it.id, []);
      own.get(it.id).push(it);
      for (const a of SC.chain(it.id).slice(1)) if (a !== 'root') { if (!inside.has(a)) inside.set(a, []); inside.get(a).push(it); }
    }
  }
  index();
  const sorted = (list) => list.slice().sort((a, b) => RANK[a.status] - RANK[b.status] || String(SC.info(a.id).name).localeCompare(String(SC.info(b.id).name)));
  const counts = () => Object.fromEntries(STATUSES.map((s) => [s, data.items.filter((x) => x.status === s).length]));
  const summary = () => t('ops.summary', counts());
  const accent = () => COLOR[worst(data.items)];

  // ---------- state: switched on ----------
  let on = !!SC.store.get('ops', true);

  // ---------- the map: a dot on each box, and the worst status inside a part ----------
  const NS = 'http://www.w3.org/2000/svg';
  const CLASSES = ['ops-dot', ...STATUSES.map((s) => 'ops-' + s)];
  // a box's own items and everything inside it: a part the owner calls ok still turns red when an endpoint in it is down
  const statusOf = (id) => { const k = entity(id), all = [...(own.get(k) || []), ...(inside.get(k) || [])]; return all.length ? worst(all) : null; };
  function dot(status, width, delay) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `ops-dot ops-${status}`);
    g.setAttribute('transform', `translate(${width - 12},0)`);
    g.innerHTML = '<circle r="7" class="ops-ring"/><circle r="4.5" class="ops-core"/>';
    if (delay) g.style.animationDelay = delay;
    return g;
  }
  function paint() {
    const size = new Map((SC.state.layout?.children || []).map((c) => [c.id, c]));
    for (const [id, g] of SC.state.chipEls || []) {
      g.querySelector('.ops-dot')?.remove();
      if (!on || /^x:/.test(id)) continue;
      const s = statusOf(id);
      if (s && size.has(id)) g.appendChild(dot(s, size.get(id).width, g.querySelector('.card')?.style.getPropertyValue('--d')));
    }
  }
  SC.on('render', paint);

  // ---------- hover: the item on a box, or what's inside a part ----------
  const details = (it) => [
    it.lastRun ? t('ops.lastRun', { time: fmtTime(it.lastRun) }) : '',
    it.lastOk ? t('ops.lastOk', { time: fmtTime(it.lastOk) }) : '',
    it.lastError ? t('ops.lastError', { error: it.lastError }) : '',
    it.note || '',
  ].filter(Boolean).map((s) => `<div class="ops-tn">${h(s)}</div>`).join('')
    + (it.metrics ? `<div class="ops-tm">${Object.entries(it.metrics).map(([k, v]) => `<span><b>${h(k)}</b> ${h(String(v))}</span>`).join('')}</div>` : '');
  const head = (it) => `${h(STATUS[it.status])}${it.version ? ` · ${h(t('ops.version', { version: it.version }))}` : ''}`;
  SC.addTipSection?.((id) => {
    if (!on) return '';
    const key = entity(id);
    const mine = own.get(key) || [], kids = inside.get(key) || [];
    let out = mine.map((it) => `<div class="ops-tip ops-${it.status}"><div class="ops-th">${head(it)}</div>${details(it)}</div>`).join('');
    if (kids.length) {
      const w = worst(kids);
      out += `<div class="ops-tip ops-${w}"><div class="ops-th">${h(t('ops.insideTip', { n: kids.length, status: STATUS[w] }))}</div><div class="ops-tn">${h(sorted(kids).slice(0, 3).map((it) => SC.info(it.id).name).join(', '))}${kids.length > 3 ? ` ${h(t('common.andMore', { n: kids.length - 3 }))}` : ''}</div></div>`;
    }
    return out;
  });

  // ---------- html ----------
  const row = (it) => {
    if (!SC.exists(it.id)) return '';
    const i = SC.info(it.id);
    const parts = [STATUS[it.status], it.version ? t('ops.version', { version: it.version }) : '', it.lastRun ? t('ops.lastRun', { time: fmtTime(it.lastRun) }) : ''].filter(Boolean);
    return `<a class="row" data-go="${h(it.id)}" title="${h(i.path || it.ref)}"><span class="dot" style="background:${COLOR[it.status]}"></span><span class="rt"><div class="rn">${h(i.name)}</div><div class="rd">${h(parts.join(' · '))}</div>${it.lastError ? `<div class="rd ops-err">${h(t('ops.lastError', { error: it.lastError }))}</div>` : ''}<div class="rp">${h(it.ref)}</div></span></a>`;
  };
  const card = (it) => `<div class="ops-card ops-${it.status}"><div class="ops-th">${head(it)}</div>${details(it)}</div>`;
  const when = () => `${h(t('ops.asOf', { time: fmtTime(data.asOf) }))}${isStale() ? ` · ${h(t('ops.stale.label'))}` : ''}`;
  const live = !!window.FLOORPLAN_SERVER && !SC.exported;
  const listHtml = () => `<div class="sec">
        <div class="ph"><span class="ico" style="--c:${accent()}">${SC.icon('ops')}</span><span class="kindlabel">${t('ops.title')}</span></div>
        <h2 class="pt">${h(tn('ops.count', data.items.length))}</h2>
        <p class="pd">${t('ops.intro')}</p>
        <div class="ops-meta">${when()}${data.source ? ` · ${h(t('ops.source', { source: data.source }))}` : ''}${live ? ` · ${t('ops.live')}` : ''}</div>
        ${isStale() ? `<div class="ops-stale"><b>${t('ops.stale.label')}</b> · ${t('ops.stale')}</div>` : ''}
        <div class="actions"><button class="btn soft" data-ops-back>${SC.iconI('left')}${t('ops.back')}</button></div>
      </div>
      <div class="sec"><h3>${t('ops.title')} <span class="c">${data.items.length}</span></h3><div class="ops-sum">${h(summary())}</div><div class="list">${sorted(data.items).map(row).join('')}</div></div>`;
  const bind = (el) => {
    if (!el) return;
    el.querySelector('[data-ops-back]')?.addEventListener('click', closeList);
    el.querySelectorAll('[data-ops-open]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openList(); }));
  };

  // ---------- the panel, and the switch in the top bar ----------
  let isOpen = false, openedAt = null;
  const where = () => JSON.stringify([SC.state.selected, SC.state.container]);
  const showing = () => !!document.querySelector?.('#panel [data-ops-back]');
  function openList() { isOpen = true; openedAt = where(); SC.showPanel(listHtml(), bind); }
  function closeList() { if (isOpen) { isOpen = false; SC.closePanel(); } }
  // selecting something else on the map while the list is open shows that item instead
  SC.on('panel', () => { if (isOpen && openedAt && where() !== openedAt) isOpen = false; });
  const btn = SC.addHeaderButton({ id: 'btn-ops', label: t('ops.button'), icon: 'ops', title: t('ops.button.title'), onClick: () => setOn(!on) });
  let badge = null;
  function showState() {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    const c = counts(), n = c.down + c.warn;
    if (badge) { badge.remove(); badge = null; }
    if (n) { badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = String(n); btn.appendChild(badge); }
    btn.style.setProperty('--ops-badge', c.down ? 'var(--sev-high)' : 'var(--sev-medium)');
  }
  showState();
  /** Switched on, the dots and hover lines show and the list opens; switched off, they go and the list closes. */
  function setOn(v) {
    on = !!v; SC.store.set('ops', on); showState(); paint();
    if (on) openList(); else if (isOpen && showing()) closeList(); else SC.refreshPanel();
  }

  // ---------- the codebase panel and a selected box ----------
  SC.addPanelSection('overview', () => ({
    top: on,
    html: `<div class="sec"><h3>${t('ops.title')} <span class="c">${data.items.length}</span></h3><div class="list"><a class="row" data-ops-open>
        <span class="dot" style="background:${accent()}"></span>
        <span class="rt"><div class="rn">${h(summary())}</div><div class="rd">${when()}</div></span>
        <span class="rc">${SC.iconI('right')}</span></a></div>${on ? '' : `<div class="ops-foot">${t('ops.switchOn')}</div>`}</div>`,
    bind,
  }));
  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string') return '';
    const key = entity(id);
    const mine = own.get(key) || [], kids = inside.get(key) || [];
    if (!mine.length && !kids.length) return '';
    const insideHtml = kids.length ? `<h3>${t('ops.inside')} <span class="c">${kids.length}</span></h3><div class="list">${sorted(kids).map(row).join('')}</div>` : '';
    return { top: true, html: `<div class="sec">${mine.length ? `<h3>${t('ops.title')} <span class="c">${mine.length}</span></h3>${mine.map(card).join('')}` : ''}${insideHtml}<div class="ops-foot"><a data-ops-open>${t('ops.all')}</a></div></div>`, bind };
  });

  // ---------- served by serve.mjs: the file as it is now, every minute ----------
  // The owner's cron rewrites ops.json between builds; the server hands out the folder's files as they are. On any
  // failure (no server, no file, bad JSON) the copy shown stays as it was. A static copy never asks.
  async function refresh() {
    let next = null;
    try {
      const r = await fetch('/ops.json', { cache: 'no-store' });
      if (r.ok) next = normalize(await r.json());
    } catch {}
    if (!next || JSON.stringify(next) === JSON.stringify(data)) return;
    data = next; index(); showState(); paint();
    if (isOpen && showing()) openList(); else SC.refreshPanel();
  }
  if (live) {
    SC.on('ready', refresh);
    setInterval(refresh, 60000);
  }

  window.FloorplanOps = { items: () => data.items, status: statusOf, set: setOn, open: openList, refresh };
})();
