// Who writes where: graph.targets (from floorplan/targets.json) lists the databases, services, files, APIs and queues
// the app writes to or reads from, which parts write and which only read, and whether a target allows one writer only.
// This adds the Targets button and panel (each target with its writers and readers as tiles that go to the map), a
// section on the codebase panel and on a selected box, and marks a one-writer target with more writers in red on the
// map, with the writes into it. The connections themselves are drawn by the viewer (kinds "write" and "read"). Talks
// to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const targets = (SC && SC.graph.targets) || [];
  if (!targets.length) return;
  const { h, t, tn } = SC;

  SC.icons.target = '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>';

  const style = document.createElement('style');
  style.textContent = `
    #btn-targets .badge { background: var(--sev-high); color: var(--on-sev-text); }
    .tg-t { padding: 12px 14px; border-radius: 16px; background: rgba(var(--ink), .04); margin-bottom: 8px; }
    .tg-t:last-child { margin-bottom: 0; }
    .tg-t.conflict { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--sev-high) 70%, transparent); }
    .tg-h { display: flex; gap: 9px; align-items: center; font-weight: 600; line-height: 1.4; }
    .tg-k { margin-left: auto; color: var(--text-3); font-size: 12px; font-weight: 400; white-space: nowrap; }
    .tg-p { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin: 4px 0 0 17px; }
    .tg-n { color: var(--text-2); font-size: 12.5px; line-height: 1.55; margin: 6px 0 0 17px; }
    .tg-alarm { margin: 8px 0 0 17px; padding: 8px 10px; border-radius: 12px; background: color-mix(in srgb, var(--sev-high) 12%, transparent); font-size: 12.5px; line-height: 1.5; }
    .tg-alarm b { display: block; color: var(--sev-high); font-weight: 600; }
    .tg-g { color: var(--text-3); font-size: 12px; margin: 10px 0 2px 17px; }
    .tg-t .list { margin-left: 8px; }
    .tg-a { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0 0 17px; }
    .tg-a .btn { height: 30px; padding: 0 12px; font-size: 12.5px; gap: 6px; }
    .tg-a .btn svg.i { width: 14px; height: 14px; }
    .node .card.tg-conflict, .node:hover .card.tg-conflict { box-shadow: inset 0 0 0 2px var(--sev-high), var(--shadow-card); }
    .node.sel .card.tg-conflict { box-shadow: inset 0 0 0 2px var(--sev-high), 0 0 0 1.5px rgba(var(--ink), .5), 0 0 0 6px rgba(var(--ink), .05); }
  `;
  document.head.appendChild(style);

  // ---------- words ----------
  const KIND = { database: t('targets.kind.database'), service: t('targets.kind.service'), file: t('targets.kind.file'), api: t('targets.kind.api'), queue: t('targets.kind.queue'), other: t('targets.kind.other') };
  const POLICY = { 'single-writer': t('targets.policy.single'), any: t('targets.policy.any') };
  const DIR = { write: t('targets.dir.write'), read: t('targets.dir.read'), unknown: t('targets.dir.unknown') };
  const conflicts = targets.filter((x) => x.conflict);
  const conflictText = (x) => (x.writerCount === 2 ? t('targets.conflictTwo') : t('targets.conflictMany', { n: x.writerCount }));
  const headline = () => (conflicts.length ? tn('targets.conflicts', conflicts.length) : tn('targets.count', targets.length));
  const accent = () => (conflicts.length ? 'var(--sev-high)' : 'var(--k-write)');

  // ---------- boards ----------
  /** One target on its own board: its box, every writer and reader, and the parts that call it without being listed. */
  function showTarget(x) {
    const items = [];
    const add = (id, note) => { if (SC.exists(id) && !items.some((i) => i.id === id)) items.push({ id, note }); };
    if (x.node) add(x.node, x.conflict ? `${POLICY[x.policy]} · ${conflictText(x)}` : POLICY[x.policy] || '');
    for (const e of x.writers) for (const id of e.items) add(id, t('targets.note.writes', { name: x.name }));
    for (const e of x.readers) for (const id of e.items) add(id, t('targets.note.reads', { name: x.name }));
    for (const u of x.undeclared || []) add(u.part, t('targets.note.undeclared', { name: x.name }));
    closeList();
    SC.showBoard({ kind: t('targets.board'), icon: 'target', title: x.name, question: [KIND[x.kind], POLICY[x.policy], x.note].filter(Boolean).join(' · '), items });
  }
  /** A writer or reader listed as a glob that matches several places: those places on one board. */
  function showEntry(x, e, list) {
    closeList();
    SC.showBoard({ kind: t('targets.board'), icon: 'target', title: x.name, question: e.ref, items: e.items.map((id) => ({ id, note: t(list === 'w' ? 'targets.note.writes' : 'targets.note.reads', { name: x.name }) })) });
  }

  // ---------- html ----------
  const tile = (e, color, ti, list, j) => {
    if (e.items.length === 1) {
      const id = e.items[0];
      if (!SC.exists(id)) return '';
      const i = SC.info(id);
      return `<a class="row" data-go="${h(id)}" title="${h(i.path || e.ref)}"><span class="dot" style="background:${color}"></span><span class="rt"><div class="rn">${h(i.name)}</div><div class="rp">${h(e.ref)}</div></span></a>`;
    }
    return `<a class="row" data-tg-many="${ti}:${list}:${j}"><span class="dot" style="background:${color}"></span><span class="rt"><div class="rn">${h(e.ref)}</div><div class="rd">${h(tn('targets.matches', e.items.length))}</div></span></a>`;
  };
  const undeclaredTile = (u) => {
    if (!SC.exists(u.part)) return '';
    const i = SC.info(u.part);
    const how = [...new Set(u.calls.map((c) => c.method).filter(Boolean))];
    return `<a class="row" data-go="${h(u.part)}"><span class="dot" style="background:var(--sev-low)"></span><span class="rt"><div class="rn">${h(i.name)}</div><div class="rd">${h(DIR[u.dir] || DIR.unknown)}${how.length ? ` · ${h(how.join(', '))}` : ''}</div><div class="rp">${h(u.calls.slice(0, 3).map((c) => `${c.file}:${c.line}`).join(' · '))}</div></span></a>`;
  };
  function targetHtml(x, ti) {
    const box = x.node && SC.exists(x.node) ? SC.info(x.node) : null;
    const writers = x.writers.map((e, j) => tile(e, x.conflict ? 'var(--sev-high)' : 'var(--k-write)', ti, 'w', j)).filter(Boolean);
    const readers = x.readers.map((e, j) => tile(e, 'var(--k-read)', ti, 'r', j)).filter(Boolean);
    const others = (x.undeclared || []).map(undeclaredTile).filter(Boolean);
    return `<div class="tg-t${x.conflict ? ' conflict' : ''}">
        <div class="tg-h"><span class="dot" style="background:${x.conflict ? 'var(--sev-high)' : 'var(--k-write)'}"></span><span>${h(x.name)}</span><span class="tg-k">${h(KIND[x.kind] || x.kind)}</span></div>
        <div class="tg-p">${h(POLICY[x.policy] || x.policy)}${box && box.name !== x.name ? ` · ${h(box.name)}` : ''}</div>
        ${x.note ? `<div class="tg-n">${h(x.note)}</div>` : ''}
        ${x.conflict ? `<div class="tg-alarm"><b>${h(conflictText(x))}</b>${t('targets.conflictHint')}</div>` : ''}
        <div class="tg-g">${t('targets.writers')}</div>${writers.length ? `<div class="list">${writers.join('')}</div>` : `<div class="tg-n">${t('targets.noWriters')}</div>`}
        ${readers.length ? `<div class="tg-g">${t('targets.readers')}</div><div class="list">${readers.join('')}</div>` : ''}
        ${others.length ? `<div class="tg-g">${t('targets.undeclared')}</div><div class="list">${others.join('')}</div>` : ''}
        ${box ? `<div class="tg-a"><button class="btn soft" data-tg-show="${ti}">${SC.iconI('search')}${t('common.showOnMap')}</button></div>` : `<div class="tg-n">${t('targets.noBox')}</div>`}
      </div>`;
  }
  const listHtml = () => `<div class="sec">
        <div class="ph"><span class="ico" style="--c:${accent()}">${SC.icon('target')}</span><span class="kindlabel">${t('targets.title')}</span></div>
        <h2 class="pt">${h(headline())}</h2>
        <p class="pd">${t('targets.intro')}</p>
        <div class="actions"><button class="btn soft" data-tg-back>${SC.iconI('left')}${t('targets.back')}</button></div>
      </div>
      <div class="sec"><h3>${t('targets.title')} <span class="c">${targets.length}</span></h3>${targets.map(targetHtml).join('')}</div>`;
  const bind = (el) => {
    if (!el) return;
    el.querySelector('[data-tg-back]')?.addEventListener('click', closeList);
    el.querySelectorAll('[data-tg-open]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openList(); }));
    el.querySelectorAll('[data-tg-show]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); showTarget(targets[+b.dataset.tgShow]); }));
    el.querySelectorAll('[data-tg-many]').forEach((a) => a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const [ti, list, j] = a.dataset.tgMany.split(':');
      const x = targets[+ti];
      showEntry(x, (list === 'w' ? x.writers : x.readers)[+j], list);
    }));
  };

  // ---------- the panel, from the header button ----------
  let isOpen = false, openedAt = null;
  const where = () => JSON.stringify([SC.state.selected, SC.state.container]);
  const showing = () => !!document.querySelector?.('#panel [data-tg-back]');
  function openList() { isOpen = true; openedAt = where(); SC.showPanel(listHtml(), bind); }
  function closeList() { if (isOpen) { isOpen = false; SC.closePanel(); } }
  const btn = SC.addHeaderButton({
    id: 'btn-targets', label: t('targets.button'), icon: 'target', title: conflicts.length ? `${t('targets.button.title')}: ${headline()}` : t('targets.button.title'),
    onClick: () => (isOpen && showing() ? closeList() : openList()),
  });
  if (conflicts.length) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = String(conflicts.length);
    btn.appendChild(b);
  }
  // selecting something else on the map while the list is open shows that item instead
  SC.on('panel', () => { if (isOpen && openedAt && where() !== openedAt) isOpen = false; });

  // ---------- codebase panel and a selected box ----------
  SC.addPanelSection('overview', () => ({
    html: `<div class="sec"><h3>${t('targets.title')} <span class="c">${targets.length}</span></h3><div class="list"><a class="row" data-tg-open>
        <span class="dot" style="background:${accent()}"></span>
        <span class="rt"><div class="rn">${h(headline())}</div><div class="rd">${h(targets.slice(0, 4).map((x) => x.name).join(' · '))}${targets.length > 4 ? ' …' : ''}</div></span>
        <span class="rc">${SC.iconI('right')}</span></a></div></div>`,
    bind,
  }));
  // a target's own box shows its writers and readers; a part or file shows what it writes to and reads from
  const holds = (e, id) => e.items.some((y) => y === id || SC.chain(y).includes(id));
  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string') return '';
    const own = targets.map((x, ti) => [x, ti]).filter(([x]) => x.node === id);
    const rows = [];
    targets.forEach((x) => {
      if (x.node === id) return;
      const go = x.node && SC.exists(x.node) ? `data-go="${h(x.node)}"` : 'data-tg-open';
      const row = (key, color) => `<a class="row" ${go}><span class="dot" style="background:${color}"></span><span class="rt"><div class="rn">${h(x.name)}</div><div class="rd">${h(t(key, { name: x.name }))} · ${h(POLICY[x.policy] || '')}</div></span></a>`;
      if (x.writers.some((e) => holds(e, id))) rows.push(row('targets.note.writes', x.conflict ? 'var(--sev-high)' : 'var(--k-write)'));
      if (x.readers.some((e) => holds(e, id))) rows.push(row('targets.note.reads', 'var(--k-read)'));
    });
    if (!own.length && !rows.length) return '';
    return {
      html: `<div class="sec"><h3>${t('targets.title')}</h3>${own.map(([x, ti]) => targetHtml(x, ti)).join('')}${rows.length ? `<div class="list">${rows.join('')}</div>` : ''}</div>`,
      bind,
    };
  });

  // ---------- the map: a one-writer target with more writers, and the writes into it, in red ----------
  const red = new Set(conflicts.map((x) => x.node).filter(Boolean));
  const entity = (id) => String(id).replace(/^x:(in|out):/, '');
  if (red.size) SC.on('render', () => {
    for (const [id, g] of SC.state.chipEls || []) if (red.has(entity(id))) g.querySelector('.card')?.classList.add('tg-conflict');
    for (const { g, pg, e } of (SC.state.edgeEls || new Map()).values()) {
      if (e.k !== 'write' || !red.has(entity(e.b))) continue;
      g.style.color = 'var(--sev-high)';
      if (pg) pg.style.color = 'var(--sev-high)';
    }
  });

  window.FloorplanTargets = { list: targets, show: showTarget, open: openList };
})();
