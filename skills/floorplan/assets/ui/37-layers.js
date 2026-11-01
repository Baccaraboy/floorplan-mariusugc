// Layers: graph.layers (from floorplan/layers.json) sorts every file into the system the owner could publish, the
// setup of this one installation and the owner's content; a part takes the layer more than half of its files have,
// else "mixed". This adds a Layers switch to the top bar. Switched on, every box gets a ring and a tag in its layer's
// colour (theme colours, light and dark, apart from the colours of the connections), rows in the details panel get a
// tag, and the codebase panel's legend has a row per layer that shows only that layer, fading the rest. The details
// of a file or a part name its layer either way. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const L = SC && SC.graph.layers;
  if (!L || !Array.isArray(L.list) || !L.list.length) return;
  const { h, t, tn } = SC;

  SC.icons.layers = '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>';

  const style = document.createElement('style');
  style.textContent = `
    #btn-layers.on { background: rgba(var(--ink), .1); color: var(--text); }
    .card.ly-system { --ly: var(--layer-system); } .card.ly-config { --ly: var(--layer-config); } .card.ly-content { --ly: var(--layer-content); }
    /* a one-writer target with more writers (35-targets.js) keeps its red ring */
    .card.ly:not(.tg-conflict) { box-shadow: inset 0 0 0 2px var(--ly), var(--shadow-card); }
    .node:hover .card.ly:not(.tg-conflict) { box-shadow: inset 0 0 0 2px var(--ly), var(--shadow-lift); }
    .node.sel .card.ly:not(.tg-conflict) { box-shadow: inset 0 0 0 2px var(--ly), 0 0 0 1.5px rgba(var(--ink), .5), 0 0 0 6px rgba(var(--ink), .05), var(--shadow-lift); }
    /* mixed: a dashed ring, so it reads without the colour too */
    .card.ly-mixed { --ly: transparent; outline: 2px dashed var(--layer-mixed); outline-offset: -2px; }
    .ly-tag { pointer-events: none; animation: fadeIn .55s var(--ease) both; }
    .ly-tag rect { fill: var(--surface); stroke: var(--ly); stroke-width: 1.5; }
    .ly-tag.mixed rect { stroke-dasharray: 3 2; }
    .ly-tag text { font: 600 11px Inter, system-ui, sans-serif; fill: var(--text-2); dominant-baseline: central; }
    svg.dim .node:not(.hl) .ly-tag { opacity: .28; }
    /* showing one layer only: the rest fades, as the selection does */
    .node.ly-out .card { box-shadow: none; outline-color: transparent; }
    .node.ly-out .card > *, .node.ly-out .ly-tag { opacity: .2; transition: opacity .3s var(--ease); }
    html.wk .node.ly-out .card > * { opacity: 1; }
    html.wk .node.ly-out foreignObject { opacity: .2; }
    .edge.ly-out { opacity: .12; }
    .ly-pill { flex: none; align-self: flex-start; margin-top: 1px; font-size: 11px; font-weight: 500; line-height: 16px; color: var(--text-2); border-radius: 999px; padding: 1px 8px; box-shadow: inset 0 0 0 1.5px var(--ly); white-space: nowrap; }
    .ly-pill.mixed { box-shadow: none; outline: 1.5px dashed var(--layer-mixed); outline-offset: -1.5px; }
    .ly-intro { color: var(--text-3); font-size: 12.5px; line-height: 1.55; margin: 0 0 8px; }
    .ly-row.on { background: rgba(var(--ink), .07); }
    .ly-foot { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin-top: 8px; }
    .ly-foot a { color: var(--text); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
  `;
  document.head.appendChild(style);

  // ---------- words and colours ----------
  const NAME = { system: t('layers.name.system'), config: t('layers.name.config'), content: t('layers.name.content'), mixed: t('layers.name.mixed') };
  const HINT = { system: t('layers.hint.system'), config: t('layers.hint.config'), content: t('layers.hint.content'), mixed: t('layers.hint.mixed') };
  const byId = new Map(L.list.map((l) => [l.id, l]));
  const nameOf = (id) => byId.get(id)?.name || NAME[id] || id;
  const hintOf = (id) => byId.get(id)?.description || HINT[id] || '';
  const color = (id) => `var(--layer-${id})`;

  // ---------- which layer an item is in ----------
  const entity = (id) => String(id).replace(/^x:(in|out):/, '');
  const fileLayer = (p) => SC.files.get(p)?.layer || L.default;
  /** How many files of each layer an item holds: a file (and its endpoints and exports) one, a part or folder all of its own. */
  function counts(id) {
    id = entity(id);
    if (/^[fm]:/.test(id)) return SC.files.has(id.slice(2)) ? { [fileLayer(id.slice(2))]: 1 } : null;
    if (id.startsWith('r:')) { const r = SC.routes[+id.slice(2)]; return r ? { [fileLayer(r.f)]: 1 } : null; }
    if (id.startsWith('s:')) return { [fileLayer(id.slice(2, id.lastIndexOf('#')))]: 1 };
    if (id.startsWith('n:')) return SC.nodes.get(id.slice(2))?.layers || null;
    if (id.startsWith('d:')) { const c = {}; for (const f of SC.info(id).d?.files || []) { const l = f.layer || L.default; c[l] = (c[l] || 0) + 1; } return c; }
    return null;
  }
  // the build's rule, for the folders the map groups files into: the layer more than half of the files have, else mixed
  const majority = (c) => {
    const top = Object.entries(c || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const total = top.reduce((s, [, n]) => s + n, 0);
    return !total ? null : top[0][1] * 2 > total ? top[0][0] : 'mixed';
  };
  const layerOf = (id) => (entity(id).startsWith('n:') ? SC.nodes.get(entity(id).slice(2))?.layer || null : majority(counts(id)));

  // ---------- state: switched on, and the one layer shown ----------
  let on = !!SC.store.get('layers', false);
  let only = SC.store.get('layers-only', null);
  if (only !== 'mixed' && !byId.has(only)) only = null;
  /** Whether an item stays bright while one layer is shown: it holds a file of that layer, or (for mixed) sits in a mixed part. */
  const shows = (id) => {
    if (!only) return true;
    if (only === 'mixed') return SC.chain(entity(id)).some((x) => x !== 'root' && layerOf(x) === 'mixed');
    return (counts(id)?.[only] || 0) > 0;
  };

  // ---------- the map: a ring and a tag on each box, and fading what isn't shown ----------
  const NS = 'http://www.w3.org/2000/svg';
  const measure = document.createElement('canvas')?.getContext?.('2d');
  const textW = (s) => { if (!measure) return s.length * 6.6; measure.font = '600 11px Inter, system-ui, sans-serif'; return measure.measureText(s).width; };
  const TAGGED = /^[nmfd]:/; // parts, folders and files; endpoints and exports share their file's layer
  const CLASSES = ['ly', 'ly-system', 'ly-config', 'ly-content', 'ly-mixed'];
  /** A tag on the box's top edge, near its right end: the layer's name with a dot, outside the card so the box keeps its size. */
  function tag(l, width, delay) {
    const label = nameOf(l), w = Math.ceil(textW(label)) + 28;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `ly-tag${l === 'mixed' ? ' mixed' : ''}`);
    g.setAttribute('transform', `translate(${Math.max(12, width - w - 24)},-10)`);
    g.innerHTML = `<rect width="${w}" height="20" rx="10" style="--ly:${color(l)}"/><circle cx="12" cy="10" r="3.5" style="fill:${color(l)}"/><text x="21" y="10">${h(label)}</text>`;
    if (delay) g.style.animationDelay = delay;
    return g;
  }
  function paint() {
    const size = new Map((SC.state.layout?.children || []).map((c) => [c.id, c]));
    for (const [id, g] of SC.state.chipEls || []) {
      const card = g.querySelector('.card');
      card?.classList.remove(...CLASSES);
      g.querySelector('.ly-tag')?.remove();
      g.classList.remove('ly-out');
      if (!on) continue;
      const l = layerOf(id);
      if (l && card) card.classList.add('ly', `ly-${l}`);
      if (l && TAGGED.test(id) && size.has(id)) g.appendChild(tag(l, size.get(id).width, card?.style.getPropertyValue('--d')));
      if (!shows(id)) g.classList.add('ly-out');
    }
    for (const { g, pg, e } of (SC.state.edgeEls || new Map()).values()) {
      const out = on && !!only && !(shows(e.a) && shows(e.b));
      g.classList.toggle('ly-out', out);
      pg?.classList.toggle('ly-out', out);
    }
  }
  SC.on('render', paint);

  // ---------- the switch ----------
  const btn = SC.addHeaderButton({ id: 'btn-layers', label: t('layers.button'), icon: 'layers', title: t('layers.button.title'), onClick: () => setOn(!on) });
  const showState = () => { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); };
  showState();
  function setOn(v) { on = !!v; SC.store.set('layers', on); showState(); paint(); SC.refreshPanel(); }
  /** Shows only one layer, or every layer again when it's the one already shown; switches the colours on if they're off. */
  function setOnly(id) {
    only = only === id ? null : id;
    SC.store.set('layers-only', only);
    if (!on) return setOn(true);
    paint(); SC.refreshPanel();
  }

  // ---------- the panels: the legend, and the layer of what's selected ----------
  const row = (id, count) => `<a class="row ly-row${only === id ? ' on' : ''}" data-ly="${h(id)}" title="${h(t('layers.only'))}"><span class="dot" style="background:${color(id)}"></span><span class="rt"><div class="rn">${h(nameOf(id))}</div>${hintOf(id) ? `<div class="rd">${h(hintOf(id))}</div>` : ''}${SC.technical() && byId.get(id)?.patterns?.length ? `<div class="rp">${h(t('layers.patterns', { list: byId.get(id).patterns.join(', ') }))}</div>` : ''}</span>${count ? `<span class="rc">${h(count)}</span>` : ''}</a>`;
  const bind = (el) => {
    if (!el) return;
    el.querySelectorAll('[data-ly]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); setOnly(a.dataset.ly); }));
    el.querySelector('[data-ly-all]')?.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); if (only) setOnly(only); });
  };
  // the legend sits near the top of the codebase panel while the colours are on, and at its end while they're off
  SC.addPanelSection('overview', () => ({
    top: on,
    html: `<div class="sec"><h3>${t('layers.title')} <span class="c">${L.list.length}</span></h3><p class="ly-intro">${t('layers.intro')}</p>
      <div class="list">${L.list.map((l) => row(l.id, tn('count.file', l.files))).join('')}${L.mixed ? row('mixed', tn('layers.parts', L.mixed)) : ''}</div>
      ${!on ? `<div class="ly-foot">${t('layers.switchOn')}</div>` : only ? `<div class="ly-foot">${h(t('layers.showing', { name: nameOf(only) }))} <a data-ly-all>${t('layers.all')}</a></div>` : ''}</div>`,
    bind,
  }));
  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string') return '';
    const c = counts(id), l = layerOf(id);
    if (!c || !l) return '';
    const parts = Object.entries(c).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const mix = /^[nd]:/.test(entity(id)) && parts.length > 1
      ? `<div class="bar">${parts.map(([x, n]) => `<span style="flex:${n};background:${color(x)}"></span>`).join('')}</div><div class="legend-row">${parts.map(([x, n]) => `<span><span class="dot" style="background:${color(x)}"></span>${h(t('layers.count', { n, name: nameOf(x) }))}</span>`).join('')}</div>`
      : '';
    return { top: true, html: `<div class="sec"><h3>${t('layers.panel')}</h3><div class="list">${row(l)}</div>${mix}</div>`, bind };
  });
  // with the colours on, every part and file listed in the details panel shows its layer too
  SC.on('panel', () => {
    if (!on) return;
    for (const r of document.querySelectorAll('#panel .row[data-go]')) {
      const l = r.querySelector('.ly-pill') ? null : layerOf(r.dataset.go);
      if (l) r.insertAdjacentHTML('beforeend', `<span class="ly-pill${l === 'mixed' ? ' mixed' : ''}" style="--ly:${color(l)}">${h(nameOf(l))}</span>`);
    }
  });

  window.FloorplanLayers = { list: L.list, layerOf, only: setOnly, set: setOn };
})();
