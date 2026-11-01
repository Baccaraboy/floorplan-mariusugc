// What you see: graph.outcomes turns the flows round. A flow in architecture.json can say what the owner sees at a step
// (you_see) and what they have in the end (outcome), each at a place on the map (a phone, a calendar, a database, a
// mailbox); the build indexes those sentences by place. This adds a "What you see" button and panel (every place with
// what arrives there and which flow brings it; a sentence opens the flow at that step), a "What arrives here" section on
// a place's card (and on a part that holds one), and a way in from the codebase panel. Nothing here is drawn on the
// map itself. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const index = (SC && SC.graph.outcomes) || {};
  const flows = (SC && SC.graph.flows) || [];
  const flowOf = (id) => flows.find((f) => f.id === id);
  // the places in the order the flows name them, each with its sentences; a flow an exported copy left out is skipped
  const places = Object.entries(index).map(([where, list]) => [where, (list || []).filter((o) => flowOf(o.flow))]).filter(([where, list]) => list.length && SC.exists(where));
  if (!places.length) return;
  const { h, t, tn } = SC;

  SC.icons.eye = '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';

  const style = document.createElement('style');
  style.textContent = `
    .ph .kindlabel.oc-kind { text-transform: none; }
    .oc-place { margin-top: 10px; }
    .oc-place:first-child { margin-top: 0; }
    /* a sentence wraps, where a name would be cut */
    .oc-row .rn { white-space: normal; }
    .oc-foot { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin-top: 8px; }
    .oc-foot a { color: var(--text); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
  `;
  document.head.appendChild(style);

  // ---------- words and lookups ----------
  const total = places.reduce((n, [, list]) => n + list.length, 0);
  const headline = () => tn('outcomes.count', places.length);
  /** The step a sentence belongs to: its own step, or the last step for a flow's outcome. */
  const stepOf = (o) => (o.step === undefined ? (flowOf(o.flow)?.steps.length || 1) - 1 : o.step);
  const fromText = (o) => { const f = flowOf(o.flow); return o.step === undefined ? t('outcomes.atEnd', { title: f?.title || o.flow }) : t('flowbar.step', { title: f?.title || o.flow, i: o.step + 1, n: f?.steps.length || 0 }); };
  /** Opens the flow where the sentence arrives. */
  const open = (flow, step) => SC.startFlow(flow, step === undefined || step === '' ? stepOf({ flow }) : +step);

  // ---------- the rows ----------
  const row = (o) => `<a class="row oc-row" data-oc-open="${h(o.flow)}" data-oc-step="${o.step === undefined ? '' : o.step}"><span class="dot" style="background:var(--k-data)"></span><span class="rt"><div class="rn">${h(o.text)}</div><div class="rd">${h(fromText(o))}</div>${o.example ? `<div class="rp">${h(t('outcomes.example', { example: o.example }))}</div>` : ''}</span><span class="rc">${SC.iconI('right')}</span></a>`;
  const placeRow = (where) => { const i = SC.info(where); return `<a class="row" data-go="${h(where)}" title="${h(i.path || '')}"><span class="dot" style="background:${SC.colorOf(i)}"></span><span class="rt"><div class="rn">${h(i.name)}</div>${i.path ? `<div class="rp">${h(i.path)}</div>` : ''}</span></a>`; };
  const placeBlock = ([where, list]) => `<div class="oc-place"><div class="list">${placeRow(where)}${list.map(row).join('')}</div></div>`;
  const listHtml = () => `<div class="sec">
        <div class="ph"><span class="ico" style="--c:var(--k-data)">${SC.icon('eye')}</span><span class="kindlabel oc-kind">${t('outcomes.title')}</span></div>
        <h2 class="pt">${h(headline())}</h2>
        <p class="pd">${t('outcomes.intro')}</p>
        <div class="oc-foot">${h(tn('outcomes.entries', total))}</div>
        <div class="actions"><button class="btn soft" data-oc-back>${SC.iconI('left')}${t('outcomes.back')}</button></div>
      </div>
      <div class="sec"><h3>${t('outcomes.places')} <span class="c">${places.length}</span></h3>${places.map(placeBlock).join('')}</div>`;
  const bind = (el) => {
    if (!el) return;
    el.querySelector('[data-oc-back]')?.addEventListener('click', closeList);
    el.querySelectorAll('[data-oc-all]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openList(); }));
    el.querySelectorAll('[data-oc-open]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); closeList(); open(a.dataset.ocOpen, a.dataset.ocStep); }));
  };

  // ---------- the panel, from the header button ----------
  let isOpen = false, openedAt = null;
  const where = () => JSON.stringify([SC.state.selected, SC.state.container]);
  const showing = () => !!document.querySelector?.('#panel [data-oc-back]');
  function openList() { isOpen = true; openedAt = where(); SC.showPanel(listHtml(), bind); }
  function closeList() { if (isOpen) { isOpen = false; SC.closePanel(); } }
  SC.addHeaderButton({ id: 'btn-outcomes', label: t('outcomes.button'), icon: 'eye', title: `${t('outcomes.button.title')}: ${headline()}`, onClick: () => (isOpen && showing() ? closeList() : openList()) });
  // selecting something else on the map while the list is open shows that item instead
  SC.on('panel', () => { if (isOpen && openedAt && where() !== openedAt) isOpen = false; });

  // ---------- the codebase panel and a selected box ----------
  SC.addPanelSection('overview', () => ({
    html: `<div class="sec"><h3>${t('outcomes.title')} <span class="c">${places.length}</span></h3><div class="list"><a class="row" data-oc-all>
        <span class="dot" style="background:var(--k-data)"></span>
        <span class="rt"><div class="rn">${h(headline())}</div><div class="rd">${h(places.slice(0, 4).map(([w]) => SC.info(w).name).join(' · '))}${places.length > 4 ? ' …' : ''}</div></span>
        <span class="rc">${SC.iconI('right')}</span></a></div></div>`,
    bind,
  }));
  /** What arrives at a card: at the place itself, or at a place inside it (a file of a part, a part of a part). */
  const arriving = (id) => places.filter(([w]) => SC.chain(w).includes(id)).flatMap(([, list]) => list);
  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string') return '';
    const here = arriving(id);
    if (!here.length) return '';
    return { html: `<div class="sec"><h3>${t('outcomes.here')} <span class="c">${here.length}</span></h3><div class="list">${here.map(row).join('')}</div><div class="oc-foot"><a data-oc-all>${t('outcomes.all')}</a></div></div>`, bind };
  });

  window.FloorplanOutcomes = { places, open, list: openList };
})();
