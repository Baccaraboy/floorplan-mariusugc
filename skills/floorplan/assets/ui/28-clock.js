// The Clock: graph.schedules holds what a clock starts, not a person: the schedules the scan found in the code (GitHub
// Actions, Vercel crons, n8n triggers, crontabs, ofelia labels) and the ones listed in floorplan/schedules.json, each
// with its cron in words, its time zone, what triggers it, what runs and the start minutes of one day. This adds a
// Clock switch to the top bar: switched on, every card a schedule starts (its trigger or what it runs, and the parts
// holding them) carries a small clock mark with the plans on hover, and the panel opens with a 24-hour strip (a mark
// for every start) and the list, next start first, the switched-off plans dimmed at the end. A plan opens with its
// details and puts its cards on a board. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const plans = (SC && SC.graph.schedules) || [];
  if (!plans.length) return;
  const { h, t, tn } = SC;

  SC.icons.clock = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>';

  const style = document.createElement('style');
  style.textContent = `
    #btn-clock.on { background: rgba(var(--ink), .1); color: var(--text); }
    #btn-clock .badge { background: var(--k-event); color: var(--on-sev-text); }
    /* the mark on a card's top left corner: a small clock face, ringed in the surface colour so it reads on the edge */
    .cl-mark { pointer-events: none; animation: fadeIn .55s var(--ease) both; }
    .cl-mark .cl-ring { fill: var(--surface); }
    .cl-mark .cl-face { fill: none; stroke: var(--k-event); stroke-width: 1.6; }
    .cl-mark .cl-hands { fill: none; stroke: var(--k-event); stroke-width: 1.6; stroke-linecap: round; }
    .cl-mark.cl-inside .cl-face, .cl-mark.cl-inside .cl-hands { opacity: .55; }
    svg.dim .node:not(.hl) .cl-mark { opacity: .28; }
    #tooltip .cl-tip { margin-top: 9px; padding: 8px 10px; border-radius: 11px; background: color-mix(in srgb, var(--k-event) 10%, transparent); }
    #tooltip .cl-th { display: flex; align-items: center; gap: 6px; color: var(--k-event); font-size: 11.5px; font-weight: 600; }
    #tooltip .cl-tn { color: var(--text); margin-top: 3px; }
    /* the strip: one day, hour ticks every six hours, a mark for every start, a band where a plan runs all day long */
    .cl-strip { display: block; width: 100%; height: 36px; margin: 10px 0 0; }
    .cl-strip .cl-base { stroke: rgba(var(--ink), .18); stroke-width: 1; vector-effect: non-scaling-stroke; }
    .cl-strip .cl-hour { stroke: rgba(var(--ink), .18); stroke-width: 1; vector-effect: non-scaling-stroke; }
    .cl-strip .cl-start { stroke: var(--k-event); stroke-width: 1.4; vector-effect: non-scaling-stroke; opacity: .8; }
    .cl-strip .cl-band { fill: var(--k-event); opacity: .18; }
    .cl-strip .cl-start.lit, .cl-strip .cl-band.lit { opacity: 1; stroke-width: 2.4; }
    .cl-strip.has-lit .cl-start:not(.lit), .cl-strip.has-lit .cl-band:not(.lit) { opacity: .15; }
    .cl-hours { display: flex; justify-content: space-between; color: var(--text-3); font-size: 10px; font-weight: 500; font-variant-numeric: tabular-nums; margin: 2px 0 6px; }
    .cl-cap { color: var(--text-3); font-size: 12px; line-height: 1.5; margin: 0 0 8px; }
    .cl-sum { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin: 0 0 8px; }
    .cl-row.cl-off { opacity: .55; }
    .cl-row .rc { color: var(--text-3); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .cl-cron { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px; }
    .cl-meta { color: var(--text-3); font-size: 12.5px; line-height: 1.55; margin-top: 8px; }
    .cl-src { color: var(--text-2); font-size: 12.5px; line-height: 1.55; margin-top: 6px; }
    .cl-src b { font-weight: 500; color: var(--text-3); }
    .cl-foot { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin-top: 8px; }
    .cl-foot a { color: var(--text); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
  `;
  document.head.appendChild(style);

  // ---------- words and lookups ----------
  const KIND = { 'github-actions': t('clock.kind.github-actions'), vercel: t('clock.kind.vercel'), n8n: t('clock.kind.n8n'), crontab: t('clock.kind.crontab'), ofelia: t('clock.kind.ofelia') };
  const kindOf = (s) => KIND[s.kind] || t('clock.kind.declared');
  const DAY = 24 * 60;
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const targets = SC.graph.targets || [];
  const targetOf = (item) => targets.find((x) => x.id === item.slice(2));
  /** The box on the map for something a plan runs: a target's box for "t:…", else the card itself; null when there is none. */
  const boxOf = (item) => (item.startsWith('t:') ? targetOf(item)?.node || null : SC.exists(item) ? item : null);
  const placeName = (item) => (item.startsWith('t:') ? targetOf(item)?.name || item.slice(2) : SC.exists(item) ? SC.info(item).name : item);
  /** The trigger as a card when it is on the map (a part, a file, an endpoint); a workflow or crontab the map doesn't show stays a path. */
  const triggerBox = (s) => (s.trigger && /^[nfr]:/.test(s.trigger) && SC.exists(s.trigger) ? s.trigger : null);
  const triggerName = (s) => (triggerBox(s) ? SC.info(s.trigger).name : s.trigger || '');
  const cardsOf = (s) => { const out = []; for (const b of [triggerBox(s), ...s.runs.map(boxOf)]) if (b && !out.includes(b)) out.push(b); return out; };
  const off = (s) => s.enabled === false;
  // the minute of the day now, on the plan's own clock (its time zone, else this computer's)
  const minuteNow = (tz) => {
    try {
      const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
      return ((+p.find((x) => x.type === 'hour').value) % 24) * 60 + +p.find((x) => x.type === 'minute').value;
    } catch { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  };
  /** The next start of the day: when, and how long from now. Null for a plan without a daily time, or one switched off. */
  const nextOf = (s) => {
    if (off(s) || !s.times.length) return null;
    const now = minuteNow(s.tz);
    const at = s.times.find((x) => x >= now) ?? s.times[0];
    return { at, wait: at >= now ? at - now : DAY - now + at };
  };
  /** The list's order: next start first, then the plans without a daily time, the switched-off ones last. */
  const ordered = () => {
    const key = (s) => { const n = nextOf(s); return [off(s) ? 2 : n ? 0 : 1, n ? n.wait : 0, String(s.title)]; };
    return plans.map((s) => [s, key(s)]).sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1] || a[1][2].localeCompare(b[1][2])).map(([s]) => s);
  };
  const nFound = plans.filter((s) => s.found).length;
  const headline = () => tn('clock.count', plans.length);
  const soonest = () => ordered().map((s) => [s, nextOf(s)]).find(([, n]) => n);
  const whenText = (s) => [s.human || s.cron || '', s.tz ? t('clock.tz', { tz: s.tz }) : ''].filter(Boolean).join(' · ');

  // ---------- state: switched on (off until asked, like Layers: the badge on the button says the clock has something) ----------
  let on = !!SC.store.get('clock', false);

  // ---------- the map: a mark on each card a plan touches, and on the parts holding it ----------
  const NS = 'http://www.w3.org/2000/svg';
  const entity = (id) => String(id).replace(/^x:(in|out):/, '').replace(/^m:/, 'f:');
  let own = new Map(), inside = new Map(); // card -> its plans; part or folder -> the plans inside it
  for (const s of plans) {
    if (off(s)) continue;
    for (const b of cardsOf(s)) {
      if (!own.has(b)) own.set(b, []);
      if (!own.get(b).includes(s)) own.get(b).push(s);
      for (const a of SC.chain(b).slice(1)) if (a !== 'root') { if (!inside.has(a)) inside.set(a, []); if (!inside.get(a).includes(s)) inside.get(a).push(s); }
    }
  }
  function mark(cls, delay) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `cl-mark${cls ? ' ' + cls : ''}`);
    g.setAttribute('transform', 'translate(12,0)');
    g.innerHTML = '<circle r="8" class="cl-ring"/><circle r="5.5" class="cl-face"/><path d="M0 -3.2V0.3L2.2 1.6" class="cl-hands"/>';
    if (delay) g.style.animationDelay = delay;
    return g;
  }
  function paint() {
    for (const [id, g] of SC.state.chipEls || []) {
      g.querySelector('.cl-mark')?.remove();
      if (!on || /^x:/.test(id)) continue;
      const k = entity(id);
      if (own.has(k)) g.appendChild(mark('', g.querySelector('.card')?.style.getPropertyValue('--d')));
      else if (inside.has(k)) g.appendChild(mark('cl-inside', g.querySelector('.card')?.style.getPropertyValue('--d')));
    }
  }
  SC.on('render', paint);

  // ---------- hover: the plans on a card, or inside a part ----------
  const role = (s, id) => (triggerBox(s) === id ? t('clock.note.trigger', { title: s.title }) : t('clock.note.runs', { title: s.title }));
  SC.addTipSection?.((id) => {
    if (!on) return '';
    const k = entity(id);
    const mine = own.get(k) || [], kids = inside.get(k) || [];
    let out = mine.map((s) => `<div class="cl-tip"><div class="cl-th">${h(role(s, k))}</div><div class="cl-tn">${h(whenText(s))}</div></div>`).join('');
    if (kids.length) out += `<div class="cl-tip"><div class="cl-th">${h(tn('clock.insideTip', kids.length))}</div><div class="cl-tn">${h(kids.slice(0, 3).map((s) => s.title).join(', '))}${kids.length > 3 ? ` ${h(t('common.andMore', { n: kids.length - 3 }))}` : ''}</div></div>`;
    return out;
  });

  // ---------- the strip: one day, a mark for every start ----------
  // Plans that start more often than every ten minutes fill the day: they get a band instead of 144 or more lines.
  function stripHtml() {
    const W = 1440, H = 36, top = 6, bottom = 32;
    const parts = [`<line class="cl-base" x1="0" x2="${W}" y1="${bottom}" y2="${bottom}"/>`];
    for (let hr = 0; hr <= 24; hr += 6) parts.push(`<line class="cl-hour" x1="${hr * 60}" x2="${hr * 60}" y1="${top - 4}" y2="${bottom + 4}"/>`);
    const bands = [], lines = []; // the bands go under the lines
    for (const s of ordered()) {
      if (off(s) || !s.times.length) continue;
      if (s.times.length >= 144) { bands.push(`<rect class="cl-band" data-cl="${h(s.id)}" x="0" y="${top}" width="${W}" height="${bottom - top}"/>`); continue; }
      for (const m of s.times) lines.push(`<line class="cl-start" data-cl="${h(s.id)}" x1="${m}" x2="${m}" y1="${top}" y2="${bottom}"/>`);
    }
    // the hour labels sit under the strip as text, which the stretched drawing would distort
    return `<svg class="cl-strip" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${[...parts, ...bands, ...lines].join('')}</svg><div class="cl-hours">${[0, 6, 12, 18, 24].map((hr) => `<span>${hr}</span>`).join('')}</div>`;
  }
  /** Lights a plan's marks on the strip while its row is hovered. */
  const light = (el, id) => {
    const strip = el.querySelector('.cl-strip');
    if (!strip) return;
    strip.querySelectorAll('.lit').forEach((x) => x.classList.remove('lit'));
    if (id) strip.querySelectorAll(`[data-cl="${id}"]`).forEach((x) => x.classList.add('lit')); // ids are letters, digits, "_", "-" and "." (the build checks)
    strip.classList.toggle('has-lit', !!id);
  };

  // ---------- one plan: its cards on a board, and its details in the panel ----------
  function showPlan(s) {
    const items = cardsOf(s).map((b) => ({ id: b, note: role(s, b) }));
    isOpen = false;
    if (items.length) SC.showBoard({ kind: t('clock.board'), icon: 'clock', title: s.title, question: whenText(s), items });
    SC.showPanel(planHtml(s), bind);
  }
  const placeRow = (item) => {
    const b = boxOf(item);
    const name = placeName(item), i = b ? SC.info(b) : null;
    const sub = item.startsWith('t:') ? (i && i.name !== name ? i.name : '') : i?.path || '';
    return `<a class="row" ${b ? `data-go="${h(b)}"` : ''} title="${h(i?.path || '')}"><span class="dot" style="background:${b ? SC.colorOf(i) : 'var(--text-4)'}"></span><span class="rt"><div class="rn">${h(name)}</div>${sub ? `<div class="rp">${h(sub)}</div>` : ''}</span></a>`;
  };
  const triggerRow = (s) => {
    const b = triggerBox(s), i = b ? SC.info(b) : null;
    return `<a class="row" ${b ? `data-go="${h(b)}"` : ''}><span class="dot" style="background:${b ? SC.colorOf(i) : 'var(--text-4)'}"></span><span class="rt"><div class="rn">${h(triggerName(s))}</div>${i?.path ? `<div class="rp">${h(i.path)}</div>` : ''}</span></a>`;
  };
  const planHtml = (s) => `<div class="sec">
        <div class="ph"><span class="ico" style="--c:var(--k-event)">${SC.icon('clock')}</span><span class="kindlabel">${h(t('clock.board'))}${off(s) ? ` · ${h(t('clock.off'))}` : ''}</span></div>
        <h2 class="pt">${h(s.title)}</h2>
        <p class="pd">${h(whenText(s))}</p>
        ${s.cron && s.cron !== s.human ? `<div class="cl-meta"><b>${t('clock.cron')}:</b> <span class="cl-cron">${h(s.cron)}</span></div>` : ''}
        ${s.calls ? `<div class="cl-meta"><b>${t('clock.calls')}:</b> <span class="cl-cron">${h(s.calls)}</span></div>` : ''}
        ${s.note ? `<div class="cl-src">${h(s.note)}</div>` : ''}
        <div class="cl-src">${h(kindOf(s))}${s.found && s.source ? ` · ${h(t('clock.foundIn', { file: s.source }))}` : s.source ? ` · <b>${t('clock.source')}:</b> ${h(s.source)}` : ''}</div>
        ${off(s) ? `<div class="cl-src">${h(t('clock.offHint'))}</div>` : ''}
        <div class="actions"><button class="btn soft" data-cl-list>${SC.iconI('left')}${t('clock.back')}</button></div>
      </div>
      <div class="sec"><h3>${t('clock.trigger')}</h3>${s.trigger ? `<div class="list">${triggerRow(s)}</div>` : `<p class="pd">${h(t('clock.noTrigger'))}</p>`}</div>
      <div class="sec"><h3>${t('clock.runs')}${s.runs.length ? ` <span class="c">${s.runs.length}</span>` : ''}</h3>${s.runs.length ? `<div class="list">${s.runs.map(placeRow).join('')}</div>` : `<p class="pd">${h(t('clock.nothingOnMap'))}</p>`}</div>`;

  // ---------- the list ----------
  const row = (s) => {
    const n = nextOf(s);
    const what = [triggerName(s), ...s.runs.map(placeName)].filter(Boolean).slice(0, 4).join(' → ');
    return `<a class="row cl-row${off(s) ? ' cl-off' : ''}" data-cl-open="${h(s.id)}"><span class="dot" style="background:${off(s) ? 'var(--text-4)' : 'var(--k-event)'}"></span><span class="rt"><div class="rn">${h(s.title)}</div><div class="rd">${h([whenText(s), kindOf(s)].filter(Boolean).join(' · '))}</div>${what ? `<div class="rp">${h(what)}</div>` : ''}</span><span class="rc">${off(s) ? h(t('clock.off')) : n ? hhmm(n.at) : ''}</span></a>`;
  };
  const listHtml = () => `<div class="sec">
        <div class="ph"><span class="ico" style="--c:var(--k-event)">${SC.icon('clock')}</span><span class="kindlabel">${t('clock.title')}</span></div>
        <h2 class="pt">${h(headline())}</h2>
        <p class="pd">${t('clock.intro')}</p>
        <div class="cl-sum">${h(t('clock.counts', { found: nFound, declared: plans.length - nFound }))}</div>
        ${stripHtml()}
        <div class="cl-cap">${h(t('clock.strip'))}</div>
        <div class="actions"><button class="btn soft" data-cl-back>${SC.iconI('left')}${t('clock.back')}</button></div>
      </div>
      <div class="sec"><h3>${t('clock.schedules')} <span class="c">${plans.length}</span></h3><div class="list">${ordered().map(row).join('')}</div></div>`;
  const bind = (el) => {
    if (!el) return;
    el.querySelector('[data-cl-back]')?.addEventListener('click', closeList);
    el.querySelector('[data-cl-list]')?.addEventListener('click', openList);
    el.querySelectorAll('[data-cl-all]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openList(); }));
    el.querySelectorAll('[data-cl-open]').forEach((a) => {
      a.addEventListener('click', (ev) => { ev.preventDefault(); const s = plans.find((x) => x.id === a.dataset.clOpen); if (s) showPlan(s); });
      a.addEventListener('mouseenter', () => light(el, a.dataset.clOpen));
      a.addEventListener('mouseleave', () => light(el, null));
    });
  };

  // ---------- the panel, and the switch in the top bar ----------
  let isOpen = false, openedAt = null;
  const where = () => JSON.stringify([SC.state.selected, SC.state.container]);
  const showing = () => !!document.querySelector?.('#panel [data-cl-back]');
  function openList() { isOpen = true; openedAt = where(); SC.showPanel(listHtml(), bind); }
  function closeList() { if (isOpen) { isOpen = false; SC.closePanel(); } }
  // selecting something else on the map while the list is open shows that item instead
  SC.on('panel', () => { if (isOpen && openedAt && where() !== openedAt) isOpen = false; });
  const btn = SC.addHeaderButton({ id: 'btn-clock', label: t('clock.button'), icon: 'clock', title: `${t('clock.button.title')}: ${headline()}`, onClick: () => setOn(!on) });
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = String(plans.filter((s) => !off(s)).length);
  btn.appendChild(badge);
  function showState() { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); }
  showState();
  /** Switched on, the marks show and the list opens; switched off, the marks go and the list closes. */
  function setOn(v) {
    on = !!v; SC.store.set('clock', on); showState(); paint();
    if (on) openList(); else if (isOpen && showing()) closeList(); else SC.refreshPanel();
  }

  // ---------- the codebase panel and a selected box ----------
  SC.addPanelSection('overview', () => {
    const next = soonest();
    return {
      html: `<div class="sec"><h3>${t('clock.title')} <span class="c">${plans.length}</span></h3><div class="list"><a class="row" data-cl-all>
        <span class="dot" style="background:var(--k-event)"></span>
        <span class="rt"><div class="rn">${h(headline())}</div><div class="rd">${h(next ? t('clock.next', { time: hhmm(next[1].at), title: next[0].title }) : ordered().slice(0, 3).map((s) => s.title).join(' · '))}</div></span>
        <span class="rc">${SC.iconI('right')}</span></a></div>${on ? '' : `<div class="cl-foot">${t('clock.switchOn')}</div>`}</div>`,
      bind,
    };
  });
  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string') return '';
    const k = entity(id);
    const mine = own.get(k) || [], kids = inside.get(k) || [];
    if (!mine.length && !kids.length) return '';
    const list = [...mine, ...kids.filter((s) => !mine.includes(s))];
    return { html: `<div class="sec"><h3>${t('clock.here')} <span class="c">${list.length}</span></h3><div class="list">${list.map(row).join('')}</div><div class="cl-foot"><a data-cl-all>${t('clock.all')}</a></div></div>`, bind };
  });

  window.FloorplanClock = { list: plans, show: showPlan, open: openList, set: setOn, order: ordered, next: nextOf };
})();
