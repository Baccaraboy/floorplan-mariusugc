// Rules and decisions: graph.rules (from floorplan/rules.json) holds the rules the project documents ("one writer per
// target") and its dated decisions, each with the place it is written down, hung on the parts, files, endpoints and
// targets it applies to. This adds the Rules button and panel (the rules in force, the decisions, the ones that apply
// everywhere at the top, the retired ones dimmed at the end; a rule opens with its text, source and places, and its
// cards go on a board), a "Rules here" section on every card the rules reach (itself, its part or its parents), and a
// way in from the codebase panel. Nothing here is drawn on the map itself. Talks to the viewer only through
// window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const rules = (SC && SC.graph.rules) || [];
  if (!rules.length) return;
  const { h, t, tn } = SC;

  SC.icons.rules = '<path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h3"/>';

  const style = document.createElement('style');
  style.textContent = `
    .rl-row.rl-off { opacity: .55; }
    .rl-g { color: var(--text-3); font-size: 12px; margin: 10px 0 2px 2px; }
    .rl-g:first-child { margin-top: 0; }
    .rl-meta { color: var(--text-3); font-size: 12.5px; line-height: 1.55; margin-top: 8px; }
    .rl-src { color: var(--text-2); font-size: 12.5px; line-height: 1.55; margin-top: 6px; }
    .rl-src b { font-weight: 500; color: var(--text-3); }
    .rl-foot { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin-top: 8px; }
    .rl-foot a { color: var(--text); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
  `;
  document.head.appendChild(style);

  // ---------- words ----------
  const KIND = { rule: t('rules.kind.rule'), decision: t('rules.kind.decision') };
  const targets = SC.graph.targets || [];
  const targetOf = (item) => targets.find((x) => x.id === item.slice(2));
  /** The box on the map an item of a rule stands for: a target's box for "t:…", else the item itself; null when there is none. */
  const boxOf = (item) => (item.startsWith('t:') ? targetOf(item)?.node || null : SC.exists(item) ? item : null);
  const placeName = (item) => (item.startsWith('t:') ? targetOf(item)?.name || item.slice(2) : SC.exists(item) ? SC.info(item).name : item);
  // a day, written the way the map's language writes it (read as a local date, so it never slips a day by time zone)
  const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(SC.lang || 'en', { dateStyle: 'medium' }) : String(s || ''); };
  const when = (r) => [r.since ? t('rules.since', { date: fmtDate(r.since) }) : '', r.until ? t('rules.until', { date: fmtDate(r.until) }) : ''].filter(Boolean).join(' · ');
  const retired = (r) => r.status === 'retired';
  // a rule in violet, a decision in amber, a retired one grey; the panel's icon in the solid colour of badges
  const COLOR = { rule: 'var(--k-call)', decision: 'var(--k-queue)' };
  const color = (r) => (retired(r) ? 'var(--text-4)' : COLOR[r.kind] || COLOR.rule);
  const headline = () => {
    const n = rules.filter((r) => r.kind === 'rule').length, k = rules.filter(retired).length;
    return [tn('rules.rules', n), tn('rules.decisions', rules.length - n), k ? tn('rules.retiredCount', k) : ''].filter(Boolean).join(' · ');
  };
  // the groups of the list: project-wide rules first, then the rules and decisions in force, the retired ones last
  const groups = () => [
    ['rules.group.everywhere', rules.filter((r) => !retired(r) && !r.items.length)],
    ['rules.group.rules', rules.filter((r) => !retired(r) && r.items.length && r.kind === 'rule')],
    ['rules.group.decisions', rules.filter((r) => !retired(r) && r.items.length && r.kind === 'decision')],
    ['rules.group.retired', rules.filter(retired)],
  ].filter(([, list]) => list.length);
  /** Whether a rule reaches a card: it names the card, its part, or one of its parents (a target by its box). */
  const reaches = (r, id) => { const ch = SC.chain(id); return r.items.some((item) => { const b = boxOf(item); return !!b && ch.includes(b); }); };

  // ---------- the board and the detail panel of one rule ----------
  /** The rule's cards on one board, and its text, source and places in the panel. */
  function showRule(r) {
    const items = [];
    for (const item of r.items) { const b = boxOf(item); if (b && !items.some((x) => x.id === b)) items.push({ id: b, note: t('rules.note', { kind: KIND[r.kind], title: r.title }) }); }
    isOpen = false;
    if (items.length) SC.showBoard({ kind: KIND[r.kind], icon: 'rules', title: r.title, question: r.text, items });
    SC.showPanel(ruleHtml(r), bind);
  }
  const placeRow = (item) => {
    const b = boxOf(item);
    const name = placeName(item), i = b ? SC.info(b) : null;
    const sub = item.startsWith('t:') ? (i && i.name !== name ? i.name : b ? '' : t('rules.noBox')) : i?.path || '';
    return `<a class="row" ${b ? `data-go="${h(b)}"` : ''} title="${h(i?.path || '')}"><span class="dot" style="background:${b ? SC.colorOf(i) : 'var(--text-4)'}"></span><span class="rt"><div class="rn">${h(name)}</div>${sub ? `<div class="rp">${h(sub)}</div>` : ''}</span></a>`;
  };
  const ruleHtml = (r) => `<div class="sec">
        <div class="ph"><span class="ico" style="--c:${color(r)}">${SC.icon('rules')}</span><span class="kindlabel">${h(KIND[r.kind])}${retired(r) ? ` · ${h(t('rules.retired'))}` : ''}</span></div>
        <h2 class="pt">${h(r.title)}</h2>
        <p class="pd">${h(r.text)}</p>
        ${when(r) ? `<div class="rl-meta">${h(when(r))}</div>` : ''}
        ${r.source ? `<div class="rl-src"><b>${t('rules.source')}:</b> ${h(r.source)}</div>` : ''}
        <div class="actions"><button class="btn soft" data-rl-list>${SC.iconI('left')}${t('rules.back')}</button></div>
      </div>
      <div class="sec"><h3>${t('rules.applies')}${r.items.length ? ` <span class="c">${r.items.length}</span>` : ''}</h3>${r.items.length ? `<div class="list">${r.items.map(placeRow).join('')}</div>` : `<p class="pd">${t('rules.everywhere')}</p>`}</div>`;

  // ---------- the list ----------
  const row = (r) => `<a class="row rl-row${retired(r) ? ' rl-off' : ''}" data-rl-open="${h(r.id)}"><span class="dot" style="background:${color(r)}"></span><span class="rt"><div class="rn">${h(r.title)}</div><div class="rd">${h([KIND[r.kind], when(r), r.items.length ? tn('rules.places', r.items.length) : t('rules.everywhere')].filter(Boolean).join(' · '))}</div></span><span class="rc">${SC.iconI('right')}</span></a>`;
  const listHtml = () => `<div class="sec">
        <div class="ph"><span class="ico" style="--c:var(--on)">${SC.icon('rules')}</span><span class="kindlabel">${t('rules.title')}</span></div>
        <h2 class="pt">${h(headline())}</h2>
        <p class="pd">${t('rules.intro')}</p>
        <div class="actions"><button class="btn soft" data-rl-back>${SC.iconI('left')}${t('rules.back')}</button></div>
      </div>
      <div class="sec"><h3>${t('rules.title')} <span class="c">${rules.length}</span></h3>${groups().map(([key, list]) => `<div class="rl-g">${h(t(key))}</div><div class="list">${list.map(row).join('')}</div>`).join('')}</div>`;
  const bind = (el) => {
    if (!el) return;
    el.querySelector('[data-rl-back]')?.addEventListener('click', closeList);
    el.querySelector('[data-rl-list]')?.addEventListener('click', openList);
    el.querySelectorAll('[data-rl-all]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openList(); }));
    el.querySelectorAll('[data-rl-open]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); const r = rules.find((x) => x.id === a.dataset.rlOpen); if (r) showRule(r); }));
  };

  // ---------- the panel, from the header button ----------
  let isOpen = false, openedAt = null;
  const where = () => JSON.stringify([SC.state.selected, SC.state.container]);
  const showing = () => !!document.querySelector?.('#panel [data-rl-back]');
  function openList() { isOpen = true; openedAt = where(); SC.showPanel(listHtml(), bind); }
  function closeList() { if (isOpen) { isOpen = false; SC.closePanel(); } }
  SC.addHeaderButton({ id: 'btn-rules', label: t('rules.button'), icon: 'rules', title: `${t('rules.button.title')}: ${headline()}`, onClick: () => (isOpen && showing() ? closeList() : openList()) });
  // selecting something else on the map while the list is open shows that item instead
  SC.on('panel', () => { if (isOpen && openedAt && where() !== openedAt) isOpen = false; });

  // ---------- the codebase panel and a selected box ----------
  SC.addPanelSection('overview', () => ({
    html: `<div class="sec"><h3>${t('rules.title')} <span class="c">${rules.length}</span></h3><div class="list"><a class="row" data-rl-all>
        <span class="dot" style="background:var(--on)"></span>
        <span class="rt"><div class="rn">${h(headline())}</div><div class="rd">${h(rules.filter((r) => !retired(r)).slice(0, 4).map((r) => r.title).join(' · '))}${rules.length > 4 ? ' …' : ''}</div></span>
        <span class="rc">${SC.iconI('right')}</span></a></div></div>`,
    bind,
  }));
  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string') return '';
    const here = rules.filter((r) => reaches(r, id));
    if (!here.length) return '';
    return { html: `<div class="sec"><h3>${t('rules.here')} <span class="c">${here.length}</span></h3><div class="list">${here.map(row).join('')}</div><div class="rl-foot"><a data-rl-all>${t('rules.all')}</a></div></div>`, bind };
  });

  window.FloorplanRules = { list: rules, show: showRule, open: openList, reaches };
})();
