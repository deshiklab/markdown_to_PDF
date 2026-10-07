/* Tab controller for the Folio suite: hash routing, lazy tool mounting,
   ARIA-correct keyboard navigation, and the mobile editor/preview switch. */
import { el, q, qa, store } from './lib.js';

const TOOL_IDS = ['markdown', 'pdf-lab', 'translate', 'convert', 'portfolio'];
const LABELS = {
  markdown: 'Markdown to PDF',
  'pdf-lab': 'PDF Lab',
  translate: 'Translate PDF',
  convert: 'Converter',
  portfolio: 'Photo Portfolio',
};

const INTRO = {
  markdown: {
    eyebrow: 'Five tools, one page',
    title: 'Markdown, meet<br /><em>your best side.</em>',
    note: 'Write a document, wrangle a PDF, translate a page, convert a stack of photos, or lay out a portfolio — all in this tab, with nothing uploaded.',
  },
  'pdf-lab': {
    eyebrow: 'PDF Lab',
    title: 'Stitch, split and stamp<br /><em>in one pass.</em>',
    note: 'Drop a few PDFs, drag pages into the order you want, pull a chapter out, or mark the whole thing DRAFT. pdf-lib does the work here in the tab.',
  },
  translate: {
    eyebrow: 'Live translate',
    title: 'Your document, read<br /><em>in another tongue.</em>',
    note: 'Text is pulled out page by page, sent to the provider you choose, and written back onto a fresh PDF you can keep — with a glossary for the words that must not move.',
  },
  convert: {
    eyebrow: 'Converter',
    title: 'Photos in, pages out —<br /><em>both directions.</em>',
    note: 'Turn camera roll shots into a tidy PDF, lift text out of a document, print every page as an image, or shrink a stack of photos before you send them.',
  },
  portfolio: {
    eyebrow: 'Photo portfolio',
    title: 'A folder of frames,<br /><em>a book worth printing.</em>',
    note: 'Choose a layout and a paper size and Folio sets your photographs into cover, plates and colophon — then exports it as one PDF.',
  },
};

const state = { active: null, mounted: new Set(), loading: new Map() };
const panelPrefs = store('panels:v1', {});

function currentHashId() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '').trim();
  const [id] = raw.split('/');
  return TOOL_IDS.includes(id) ? id : 'markdown';
}

function tabs() {
  return qa('#toolNav [data-tool]');
}

function paintActive(id) {
  document.body.dataset.tool = id;
  for (const tool of TOOL_IDS) {
    const isActive = tool === id;
    const tab = q(`#tab-${tool}`);
    const panel = q(`#panel-${tool}`);
    if (tab) {
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
      if (isActive) {
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    }
    if (panel) {
      panel.hidden = !isActive;
      panel.classList.toggle('is-active', isActive);
    }
  }
  const intro = INTRO[id] ?? INTRO.markdown;
  const introBlock = q('.intro');
  if (introBlock && introBlock.dataset.tool !== id) {
    introBlock.dataset.tool = id;
    const eyebrow = q('.eyebrow-text', introBlock);
    if (eyebrow) eyebrow.textContent = intro.eyebrow;
    const heading = q('#page-title', introBlock);
    if (heading) {
      heading.innerHTML = intro.title;
      heading.animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
    }
    const note = q('.intro-copy > p', introBlock);
    if (note) note.textContent = intro.note;
  }
  const title = id === 'markdown' ? 'Folio — Markdown to PDF, beautifully' : `Folio · ${LABELS[id]}`;
  document.title = title;
  const meta = q('meta[name="description"]');
  if (meta) meta.setAttribute('content', `Folio ${LABELS[id]} — free, private tools that run in your browser.`);
}

/** Switching tabs while scrolled deep into a long tool should not leave the
   new tool out of view, so bring the tab strip back to the top edge. */
function liftToTabs() {
  const nav = q('.tool-nav');
  if (!nav) return;
  const top = nav.getBoundingClientRect().top;
  if (top >= -4 && top <= window.innerHeight * 0.5) return;
  window.scrollTo({ top: window.scrollY + top - 8, behavior: motionOk() ? 'smooth' : 'auto' });
}

function motionOk() {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function activate(id, { focus = false } = {}) {
  const next = TOOL_IDS.includes(id) ? id : 'markdown';
  state.active = next;
  paintActive(next);
  liftToTabs();
  if (focus) q(`#tab-${next}`)?.focus({ preventScroll: true });
  return next;
}

async function mountTool(id, loaders) {
  const panel = q(`#panel-${id}`);
  if (!panel) return false;
  if (state.mounted.has(id)) return true;
  const loader = loaders?.[id];
  if (!loader) {
    panel.innerHTML = '';
    panel.append(
      el('div', { class: 'tool-notice' }, [
        el('strong', { text: 'This tool runs through the dev server.' }),
        el('p', { html: 'Opening <code>index.html</code> straight from disk keeps only the Markdown studio. Run <code>npm run dev</code> and open <code>http://localhost:5173/</code> for the full suite.' }),
      ]),
    );
    return false;
  }
  if (!state.loading.has(id)) {
    state.loading.set(
      id,
      Promise.resolve()
        .then(() => loader())
        .then(async (module) => {
          const start = module?.start ?? module?.default?.start;
          if (typeof start !== 'function') throw new Error(`${id} did not export a start() function.`);
          panel.innerHTML = '';
          await start(panel);
          state.mounted.add(id);
          window.dispatchEvent(new CustomEvent('folio:tool-mounted', { detail: { id } }));
          return true;
        })
        .catch((error) => {
          state.loading.delete(id);
          console.error(`Folio could not load the ${id} tool:`, error);
          panel.innerHTML = '';
          panel.append(
            el('div', { class: 'tool-notice is-error' }, [
              el('strong', { text: 'This tool could not start.' }),
              el('p', { text: String(error?.message ?? error) }),
              el('button', { class: 'button button-light', type: 'button', text: 'Try again' }),
            ]),
          );
          q('.tool-notice .button', panel)?.addEventListener('click', () => mountTool(id, loaders));
          return false;
        }),
    );
  }
  return state.loading.get(id);
}

function scrollNav(scroller, direction) {
  const amount = Math.max(180, Math.round(scroller.clientWidth * 0.7));
  scroller.scrollBy({ left: direction * amount, behavior: 'smooth' });
}

function buildNavArrows(nav, scroller) {
  if (q('.tool-nav-arrows', nav)) return;
  const path = { prev: '<path d="M12.5 5.5 8 10l4.5 4.5"/>', next: '<path d="M7.5 5.5 12 10l-4.5 4.5"/>' };
  const group = el('div', { class: 'tool-nav-arrows' }, [
    el('button', { type: 'button', class: 'tool-nav-arrow', 'data-nav': 'prev', 'aria-label': 'Show earlier tools', html: `<svg viewBox="0 0 20 20">${path.prev}</svg>` }),
    el('button', { type: 'button', class: 'tool-nav-arrow', 'data-nav': 'next', 'aria-label': 'Show more tools', html: `<svg viewBox="0 0 20 20">${path.next}</svg>` }),
  ]);
  group.addEventListener('click', (event) => {
    const button = event.target.closest('[data-nav]');
    if (button) scrollNav(scroller, button.dataset.nav === 'next' ? 1 : -1);
  });
  nav.append(group);
}

function updateNavEdges(scroller) {
  const nav = scroller.closest('.tool-nav');
  buildNavArrows(nav, scroller);
  const prev = q('[data-nav="prev"]', nav);
  const next = q('[data-nav="next"]', nav);
  if (prev) prev.disabled = scroller.scrollLeft < 6;
  if (next) next.disabled = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 6;
  const edge = q('.tool-nav-edge', scroller.parentElement);
  const scrollable = scroller.scrollWidth - scroller.clientWidth > 4;
  scroller.classList.toggle('is-scrollable', scrollable);
  scroller.classList.toggle('is-scrolled', scrollable && scroller.scrollLeft > 6);
  scroller.classList.toggle('is-at-end', scrollable && scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 6);
  if (edge) edge.classList.toggle('is-hidden', scroller.classList.contains('is-at-end'));
}

function wireKeyboard(loaders) {
  const nav = q('#toolNav .tool-tablist');
  if (!nav) return;
  nav.addEventListener('keydown', (event) => {
    const list = tabs();
    const index = list.indexOf(event.target.closest('.tool-tab'));
    if (index === -1) return;
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = list[(index + 1) % list.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = list[(index - 1 + list.length) % list.length];
    else if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list[list.length - 1];
    if (!next) return;
    event.preventDefault();
    const id = next.dataset.tool;
    window.location.hash = `/${id}`;
    activate(id, { focus: true });
    mountTool(id, loaders);
  });
}

/* Editor / preview switch for narrow screens — one panel at a time on phones. */
function setupPanelSwitcher() {
  const studio = q('#panel-markdown .studio');
  if (!studio || q('.panel-switch', studio)) return;
  const group = el('div', { class: 'panel-switch', role: 'group', 'aria-label': 'Choose which half of the studio to view' }, [
    el('button', { type: 'button', class: 'panel-switch-button', 'data-mode': 'both', text: 'Both' }),
    el('button', { type: 'button', class: 'panel-switch-button', 'data-mode': 'editor', text: 'Editor' }),
    el('button', { type: 'button', class: 'panel-switch-button', 'data-mode': 'preview', text: 'Preview' }),
  ]);
  q('.studio-heading', studio)?.append(group);
  const apply = (mode) => {
    studio.dataset.panelMode = mode;
    qa('.panel-switch-button', group).forEach((node) => {
      const on = node.dataset.mode === mode;
      node.classList.toggle('is-on', on);
      node.setAttribute('aria-pressed', String(on));
    });
  };
  group.addEventListener('click', (event) => {
    const node = event.target.closest('.panel-switch-button');
    if (!node) return;
    apply(node.dataset.mode);
    panelPrefs.write({ panelMode: node.dataset.mode });
  });
  const narrow = window.matchMedia('(max-width: 900px)');
  const sync = () => apply(narrow.matches ? (panelPrefs.read().panelMode ?? 'editor') : 'both');
  sync();
  narrow.addEventListener?.('change', sync);
}

export function startShell({ loaders } = {}) {
  const initial = activate(currentHashId());
  tabs().forEach((tab) => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.tool;
      window.location.hash = `/${id}`;
      activate(id);
      mountTool(id, loaders);
    });
  });
  wireKeyboard(loaders);
  setupPanelSwitcher();

  const scroller = q('#toolNav .tool-nav-scroll');
  if (scroller) {
    updateNavEdges(scroller);
    scroller.addEventListener('scroll', () => updateNavEdges(scroller), { passive: true });
    window.addEventListener('resize', () => updateNavEdges(scroller), { passive: true });
  }

  window.addEventListener('hashchange', () => {
    const id = activate(currentHashId());
    if (id !== 'markdown') mountTool(id, loaders);
  });

  document.addEventListener('click', (event) => {
  const jump = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
  if (jump && jump.getAttribute('href') === '#how-it-works' && state.active !== 'markdown') {
    event.preventDefault();
    activate('markdown');
    window.setTimeout(() => q('#how-it-works')?.scrollIntoView({ behavior: motionOk() ? 'smooth' : 'auto', block: 'start' }), 90);
    return;
  }
    const link = event.target.closest?.('[data-tool-link]');
    if (!link) return;
    event.preventDefault();
    const id = link.getAttribute('data-tool-link');
    window.location.hash = `/${id}`;
    activate(id);
    mountTool(id, loaders);
    q(`#panel-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  if (initial !== 'markdown') mountTool(initial, loaders);

  const idle = window.requestIdleCallback ?? ((fn) => window.setTimeout(fn, 1400));
  idle(() => {
    const next = TOOL_IDS.find((id) => id !== state.active && typeof loaders?.[id] === 'function');
    if (next) Promise.resolve(loaders[next]()).catch(() => {});
  });
}
