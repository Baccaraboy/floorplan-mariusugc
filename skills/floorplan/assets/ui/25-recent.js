// Recent work: what Claude just changed (graph.recent, from floorplan/recent-work.json), framed against
// what the user asked for. Cards carry the green tag and hover note (core viewer); this adds the header
// button that lays the changed cards out on one board, and the panel sections. Talks to the viewer only
// through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const R = SC && SC.graph.recent;
  if (!R || !R.items || !R.items.length) return;
  const { h, t, tn } = SC;
  const tasks = R.tasks || [];
  const items = R.items.filter((it) => SC.exists(it.id));
  if (!items.length) return;

  SC.icons.recent = '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>';

  const style = document.createElement('style');
  style.textContent = `
    #btn-recent svg.i { color: var(--recent); }
    #btn-recent .badge { background: var(--recent); color: var(--on-recent-text); }
    .rw-task { padding: 12px 14px; border-radius: 16px; background: color-mix(in srgb, var(--recent) 6%, transparent); margin-bottom: 8px; }
    .rw-task:last-child { margin-bottom: 0; }
    .rw-tt { display: flex; gap: 9px; align-items: center; font-weight: 600; line-height: 1.4; }
    .rw-tt::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--recent); flex: none; }
    .rw-q { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin: 6px 0 0 16px; }
    .rw-q b { color: var(--text-2); font-weight: 500; }
    .rw-s { color: var(--text-2); font-size: 12.5px; line-height: 1.55; margin: 6px 0 0 16px; }
    .rw-a { display: flex; gap: 6px; margin: 10px 0 0 16px; }
    .rw-a .btn { height: 30px; padding: 0 12px; font-size: 12.5px; gap: 6px; }
    .rw-note { margin-top: 10px; padding: 10px 12px; border-radius: 14px; background: color-mix(in srgb, var(--recent) 9%, transparent); font-size: 13px; line-height: 1.55; }
    .rw-note .rw-h { color: var(--recent); font-size: 11.5px; font-weight: 600; margin-bottom: 3px; }
    .rw-when { color: var(--text-3); font-size: 12px; margin-top: 4px; }
  `;
  document.head.appendChild(style);

  const ago = (iso) => {
    const at = Date.parse(iso); if (!at) return '';
    const m = Math.round((Date.now() - at) / 60000);
    return m < 2 ? t('recent.ago.now') : m < 60 ? tn('recent.ago.minutes', m) : m < 48 * 60 ? tn('recent.ago.hours', Math.round(m / 60)) : tn('recent.ago.days', Math.round(m / 1440));
  };
  const itemsOf = (ti) => items.filter((it) => ti == null || it.task === ti);
  const changeWord = (it) => (it.change === 'new' ? t('recent.new') : t('recent.changed'));

  /** One board with just the changed cards (and how they connect), each with its note. */
  function showRecent(ti) {
    const one = ti != null ? tasks[ti] : tasks.length === 1 ? tasks[0] : null;
    SC.showBoard({
      kind: t('recent.title'), icon: 'recent',
      title: one ? one.title : t('recent.title'),
      question: one ? (one.request ? t('recent.youAsked', { request: one.request }) : '') : tasks.map((x) => x.title).join(' · '),
      answer: one ? one.summary : tasks.map((x) => `**${x.title}.** ${x.summary}`).join('\n\n'),
      items: itemsOf(ti != null ? ti : null).map((it) => ({ id: it.id, note: it.note || changeWord(it) })),
    });
  }

  const btn = SC.addHeaderButton({ id: 'btn-recent', label: t('recent.title'), icon: 'recent', title: t('recent.button.title'), onClick: () => showRecent() });
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = String(items.length);
  btn.appendChild(b);

  // codebase panel: each task, what was asked, what was done, and a way to see its cards
  SC.addPanelSection('overview', () => ({
    top: true,
    html: `<div class="sec"><h3>${t('recent.title')} <span class="c">${items.length}</span></h3>${R.updatedAt ? `<div class="rw-when">${t('recent.updated', { ago: h(ago(R.updatedAt)) })}</div>` : ''}<div style="margin-top:10px">${tasks.map((task, i) => itemsOf(i).length ? `
      <div class="rw-task"><div class="rw-tt">${h(task.title)}</div>
        ${task.request ? `<div class="rw-q"><b>${t('recent.youAskedLabel')}</b> ${h(task.request)}</div>` : ''}
        ${task.summary ? `<div class="rw-s">${h(task.summary)}</div>` : ''}
        <div class="rw-a"><button class="btn soft" data-rw="${i}">${SC.iconI('recent')}${t('recent.showCards', { cards: tn('count.card', itemsOf(i).length) })}</button></div></div>` : '').join('')}</div></div>`,
    bind: (el) => el.querySelectorAll('[data-rw]').forEach((x) => x.addEventListener('click', () => showRecent(+x.dataset.rw))),
  }));

  // a selected card that changed: the full note, and which request it was for. A part that
  // contains changes: what changed inside it, each a click away.
  SC.addPanelSection('item', (id) => {
    const key = id.startsWith('m:') ? 'f:' + id.slice(2) : id;
    const mine = items.filter((it) => it.id === key);
    const inside = items.filter((it) => it.id !== key && SC.chain(it.id).includes(key));
    if (!mine.length && !inside.length) return '';
    if (!mine.length) return { top: true, html: `<div class="sec"><h3>${t('recent.inside')} <span class="c">${inside.length}</span></h3><div class="list">${inside.map((it) => {
      const i = SC.info(it.id);
      return `<a class="row" data-go="${h(it.id)}"><span class="dot" style="background:var(--recent)"></span><span class="rt"><div class="rn">${h(i.name)}</div>${it.note ? `<div class="rd">${h(it.note)}</div>` : ''}</span></a>`;
    }).join('')}</div></div>` };
    return { top: true, html: `<div class="sec">${mine.map((it) => {
      const task = tasks[it.task] || {};
      return `<div class="rw-note"><div class="rw-h">${changeWord(it)} · ${h(task.title || t('recent.title'))}</div>${h(it.note || '')}${task.request ? `<div class="rw-q" style="margin:6px 0 0"><b>${t('recent.youAskedLabel')}</b> ${h(task.request)}</div>` : ''}</div>`;
    }).join('')}</div>` };
  });

  window.FloorplanRecent = { show: showRecent, items, tasks };
})();
