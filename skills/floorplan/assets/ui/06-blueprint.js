// Blueprints: a map planned from a PRD or a description, before any code exists (graph.meta.blueprint,
// from scripts/plan.mjs). Cards get a dashed outline and the project name a "Blueprint" pill, the
// overview says what it was planned from, and every planned part offers "Build this with Claude": a
// ready prompt to build just that part, following the plan. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const BP = SC && SC.graph.meta.blueprint;
  if (!BP) return;
  const { h, t } = SC;
  const Cap = (s) => s[0].toUpperCase() + s.slice(1);
  const A = SC.agent || { name: 'Claude', app: 'Claude Code' };
  const G = SC.graph;

  document.documentElement.classList.add('blueprint');
  const style = document.createElement('style');
  style.textContent = `
    /* planned, not built: a dashed outline on every card */
    html.blueprint .card:not(.connector)::after { content: ""; position: absolute; inset: 0; border-radius: inherit; border: 2.5px dashed rgba(var(--ink), .32); pointer-events: none; }
    .bp-pill { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; margin-left: 8px; border-radius: 999px; font-size: 11px; font-weight: 500; letter-spacing: .02em; color: var(--text-2); border: 1px dashed rgba(var(--ink), .35); flex: none; }
    .bp-list { margin: 8px 0 0; padding-left: 18px; color: var(--text-2); font-size: 13px; line-height: 1.55; }
    .bp-list li + li { margin-top: 4px; }
  `;
  document.head.appendChild(style);

  // a "Blueprint" pill beside the board's title, which is redrawn on every move
  const addPill = () => {
    const k = document.querySelector('#context .k');
    if (!k || k.querySelector('.bp-pill')) return;
    k.insertAdjacentHTML('beforeend', `<span class="bp-pill" title="${h(t('blueprint.pill.title'))}">${t('blueprint.pill')}</span>`);
  };
  SC.on('render', addPill);
  SC.on('ready', addPill);

  const ACCESS = { public: t('blueprint.access.public'), 'signed-in': t('blueprint.access.signedIn'), team: t('blueprint.access.team'), webhook: t('blueprint.access.webhook'), internal: t('blueprint.access.internal') };
  /** "for signed-in users: managers of that location", or the open question when nobody decided. */
  const whoMay = (r) => !r.access ? t('blueprint.who.undecided')
    : t(r.publicBecause ? 'blueprint.who.forBecause' : 'blueprint.who.for', { who: r.access === 'signed-in' && r.who ? r.who : ACCESS[r.access] || r.access, because: (r.publicBecause || '').replace(/\.$/, '') });
  const BUILD_WITH = t('blueprint.buildWith', { name: A.name });

  SC.addPanelSection('overview', () => ({
    html: `<div class="sec"><h3>${t('blueprint.title')}</h3>
      <p class="pd">${BP.source ? t('blueprint.plannedFrom', { source: h(BP.source) }) : t('blueprint.planned')}${SC.exported ? '' : ` ${t('blueprint.pickOne', { button: h(BUILD_WITH) })}`}</p>
      ${BP.stack?.length ? `<div class="tags" style="margin-top:10px">${BP.stack.map((s) => `<span class="tag">${h(s)}</span>`).join('')}</div>` : ''}
      ${BP.assumptions?.length ? `<h3 style="margin-top:14px">${t('blueprint.assumptions')}</h3><ul class="bp-list">${BP.assumptions.map((a) => `<li>${h(a)}</li>`).join('')}</ul>` : ''}
    </div>`,
  }));

  /** The planned files inside an item (a part, a folder or one file). */
  const filesIn = (id) => G.files.filter((f) => id === 'f:' + f.p || SC.chain('f:' + f.p).includes(id));
  function buildPrompt(id) {
    const i = SC.info(id);
    const fl = filesIn(id);
    const paths = new Set(fl.map((f) => 'f:' + f.p));
    const eps = SC.routes.filter((r) => paths.has('f:' + r.f));
    const deps = new Map();
    for (const l of G.links) {
      if (!paths.has(l.a) || paths.has(l.b)) continue;
      const o = SC.info(l.b);
      if (o) deps.set(l.b, `${o.name}${l.b.startsWith('f:') ? ` (${l.b.slice(2)})` : ''}`);
    }
    // open questions from the PRD that touch this part
    const inside = (x) => x === id || paths.has(x) || (x.startsWith('r:') && paths.has('f:' + SC.routes[+x.slice(2)]?.f)) || (SC.exists(x) && SC.chain(x).includes(id));
    const questions = (G.health?.issues || []).filter((q) => q.kind === 'question' && (q.items || []).some(inside)).map((q) => q.title);
    return [
      t(BP.source ? 'blueprint.prompt.buildFrom' : 'blueprint.prompt.build', { name: i.name, project: G.project.name, source: BP.source }),
      i.desc ? `\n${t('blueprint.prompt.for', { desc: i.desc })}` : '',
      BP.stack?.length ? `\n${t('blueprint.prompt.stack', { stack: BP.stack.join('; ') })}` : '',
      `\n${t('blueprint.prompt.files')}`,
      ...fl.map((f) => `- ${f.p}: ${f.name}${f.d ? `. ${f.d}` : ''}`),
      eps.length ? `\n${t('blueprint.prompt.endpoints')}` : '',
      ...eps.map((r) => `- ${r.m} ${r.p} (${whoMay(r)}): ${r.name}${r.d ? `. ${r.d}` : ''}`),
      deps.size ? `\n${t('blueprint.prompt.relies', { deps: [...deps.values()].join('; ') })}` : '',
      questions.length ? `\n${t('blueprint.prompt.undecided')}\n${questions.map((q) => `- ${q}`).join('\n')}` : '',
      `\n${t('blueprint.prompt.before')}`,
    ].filter((x) => x !== '').join('\n');
  }

  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string') return '';
    // an endpoint: who the plan lets use it
    if (id.startsWith('r:')) {
      const r = SC.routes[+id.slice(2)];
      if (!r) return '';
      const text = !r.access ? `${t('blueprint.notDecided')}${SC.graph.health ? ` ${t('blueprint.reviewLists')}` : ''}` : `${Cap(r.access === 'signed-in' && r.who ? r.who : ACCESS[r.access] || r.access)}.${r.publicBecause ? ` ${t('blueprint.openOnPurpose', { because: r.publicBecause })}` : ''}`;
      return `<div class="sec"><h3>${t('blueprint.whoMay')}</h3><p class="pd">${h(text)}</p></div>`;
    }
    const i = SC.info(id);
    if (SC.exported || !i || (i.type === 'node' && i.n.kind === 'external') || !filesIn(id).length) return '';
    return {
      html: `<div class="sec"><h3>${t('blueprint.buildIt')}</h3><p class="pd">${t(i.type === 'file' ? 'blueprint.readyFile' : 'blueprint.readyPart', { app: h(A.app) })}</p>
        <div class="actions"><button class="btn soft" data-bp-build>${SC.iconI('spark')}${h(BUILD_WITH)}</button></div></div>`,
      bind: (el) => el.querySelector('[data-bp-build]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const prompt = buildPrompt(id);
        SC.modal({
          title: BUILD_WITH,
          html: `<p class="hc-hint">${t('blueprint.copyHint', { app: h(A.app) })}</p><pre>${h(prompt)}</pre>`,
          actions: [{ label: t('common.copyPrompt'), primary: true, icon: 'copy', onClick: () => { SC.copy(prompt); SC.toast(t('common.copiedPaste', { app: A.app })); } }],
        });
      }),
    };
  });
})();
