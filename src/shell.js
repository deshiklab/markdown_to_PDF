// Studio shell. Owns the tab strip, hash routing (`#/pdf-lab` etc.),
// keyboard roving focus, the panel switcher on phones, per-tab intro
// lines, and the scroll-into-view behaviour that keeps the active tab
// card fully visible after fonts load and after a resize.
//
// The shell does NOT know anything about the tools themselves — each
// tool is registered with `registerTab({ id, label, description,
//   load })` and gets a `<section>` to mount into. This keeps the
// Markdown → PDF editor independent of PDF Lab, Sign, etc. so a bug in
// one tab can't take the others down.

import { h, $, $$, on } from './lib.js';

const TAB_STRIP_ID = 'toolNavScroll';
const STRIP_FADE_LEFT = 'toolNavFadeLeft';
const STRIP_FADE_RIGHT = 'toolNavFadeRight';
const PREV_BTN_ID = 'toolNavPrev';
const NEXT_BTN_ID = 'toolNavNext';
const PANEL_ID = 'toolPanel';
const SWITCHER_ID = 'toolSwitcher';
const INTRO_ID = 'toolIntro';
const MOBILE_BREAKPOINT = 900;

const tabs = new Map();
let currentTabId = null;
let activeInstance = null;
let initialScrollAligned = false;
let pendingIntro = null;
let host = null;

export function registerTab(definition) {
  if (!definition || !definition.id) {
    throw new Error('registerTab requires a tab definition with an id.');
  }
  tabs.set(definition.id, definition);
  if (currentTabId === null) currentTabId = definition.id;
}

export function getRegisteredTabs() {
  return Array.from(tabs.values());
}

export function getCurrentTabId() {
  return currentTabId;
}

/**
 * Mount the studio shell into `root`. The root element is the
 * `app-shell` from index.html, or any element that contains the
 * `<main>` we want to add the tab strip above.
 */
export function mountStudioShell(root) {
  host = root;

  // Inject the tab strip, the panel wrapper, and the per-tab intro
  // INSIDE the existing `.studio` container so the section's padding
  // and the studio heading stay where the page chrome expects them.
  const main = $('#top', root) || $('main', root);
  if (!main) throw new Error('Studio shell needs a <main id="top"> to mount into.');

  const studio = $('#workspace', main);
  if (!studio) {
    throw new Error('Studio shell needs an element with id="workspace" inside <main>.');
  }

  // The original workbench markup is gone (the Markdown tool now
  // builds it on mount). Find the studio-heading (or the first child)
  // and insert the shell pieces after it.
  const heading = $('.studio-heading', studio);
  const anchor = heading ? heading.nextSibling : studio.firstChild;

  const intro = buildIntro();
  const strip = buildTabStrip();
  const panel = buildPanel();

  if (anchor) {
    studio.insertBefore(panel, anchor);
    studio.insertBefore(strip, panel);
    studio.insertBefore(intro, strip);
  } else {
    studio.append(intro, strip, panel);
  }

  wireStripArrows();
  wireKeyboard();
  wireResize();

  // Honour any hash in the URL, otherwise default to the first tab.
  const initial = parseHash() || currentTabId;
  switchTab(initial, { replace: true });

  // Web fonts can change card widths after first paint; re-centre then.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      initialScrollAligned = true;
      keepActiveTabVisible();
    });
  }
}

// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------

function buildTabStrip() {
  const strip = h('div', { class: 'tool-nav', role: 'navigation', 'aria-label': 'Studio tabs' }, [
    h('button', {
      class: 'tool-nav-arrow tool-nav-arrow-prev',
      id: PREV_BTN_ID,
      type: 'button',
      'aria-label': 'Scroll tabs left',
      'aria-controls': TAB_STRIP_ID,
    }, arrowLeft()),
    h('div', { class: 'tool-nav-fade tool-nav-fade-left', id: STRIP_FADE_LEFT, 'aria-hidden': 'true' }),
    h('div', { class: 'tool-nav-scroll', id: TAB_STRIP_ID, tabindex: '0', role: 'tablist' },
      Array.from(tabs.values()).map((tab) => buildTabCard(tab))
    ),
    h('div', { class: 'tool-nav-fade tool-nav-fade-right', id: STRIP_FADE_RIGHT, 'aria-hidden': 'true' }),
    h('button', {
      class: 'tool-nav-arrow tool-nav-arrow-next',
      id: NEXT_BTN_ID,
      type: 'button',
      'aria-label': 'Scroll tabs right',
      'aria-controls': TAB_STRIP_ID,
    }, arrowRight()),
  ]);

  return strip;
}

function buildTabCard(tab) {
  return h('button', {
    class: 'tool-nav-card',
    type: 'button',
    role: 'tab',
    id: `tool-tab-${tab.id}`,
    'aria-controls': PANEL_ID,
    'data-tab-id': tab.id,
    'aria-selected': 'false',
    onClick: () => switchTab(tab.id),
  }, [
    h('span', { class: 'tool-nav-card-index' }, tab.index || ''),
    h('span', { class: 'tool-nav-card-body' }, [
      h('span', { class: 'tool-nav-card-title' }, tab.label),
      tab.description ? h('span', { class: 'tool-nav-card-sub' }, tab.description) : null,
    ]),
  ]);
}

function arrowLeft() {
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    h('path', { d: 'M10 3.5 5.5 8 10 12.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  );
}

function arrowRight() {
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    h('path', { d: 'M6 3.5 10.5 8 6 12.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  );
}

function buildIntro() {
  return h('p', { class: 'tool-intro', id: INTRO_ID, 'aria-live': 'polite' });
}

function buildPanel() {
  return h('section', { class: 'tool-panel', id: PANEL_ID, role: 'tabpanel', 'aria-live': 'polite' });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * Switch to a tab by id. The previous tab's instance is given a chance
 * to teardown (so Sign can drop its canvas, PDF Lab can release pdf.js
 * documents, etc.). The new tab's `load()` is awaited and the panel is
 * filled with whatever it returns.
 */
export async function switchTab(id, { replace = false } = {}) {
  const tab = tabs.get(id);
  if (!tab) {
    console.warn(`Unknown tab id: ${id}`);
    return;
  }
  if (id === currentTabId && activeInstance) {
    // Already on this tab; still scroll the card into view and bail.
    keepActiveTabVisible();
    updateStripFades();
    return;
  }

  // URL hash sync.
  const newHash = `#${tab.id}`;
  if (window.location.hash !== newHash) {
    if (replace) {
      history.replaceState(null, '', newHash);
    } else {
      history.pushState(null, '', newHash);
    }
  }

  // Update selection state on the cards.
  for (const card of $$(`#${TAB_STRIP_ID} .tool-nav-card`)) {
    const selected = card.dataset.tabId === tab.id;
    card.setAttribute('aria-selected', selected ? 'true' : 'false');
    card.classList.toggle('is-active', selected);
  }

  // Update the intro line.
  const intro = $(`#${INTRO_ID}`);
  if (intro) {
    intro.textContent = tab.intro || tab.description || '';
  }

  // Switch the panel.
  if (activeInstance && typeof activeInstance.unmount === 'function') {
    try { activeInstance.unmount(); } catch (error) { console.warn('Tab unmount failed:', error); }
  }
  activeInstance = null;

  const panel = $(`#${PANEL_ID}`);
  if (!panel) return;
  panel.dataset.tabId = tab.id;
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  if (tab.skeleton) {
    panel.appendChild(tab.skeleton());
  }

  try {
    const instance = await tab.load(panel);
    activeInstance = instance || null;
  } catch (error) {
    console.error(`Failed to load tab ${tab.id}:`, error);
    panel.appendChild(h('div', { class: 'tool-error' }, [
      h('strong', null, 'That tool did not load.'),
      h('p', null, error && error.message ? error.message : 'Try reloading the page.'),
    ]));
  }

  currentTabId = tab.id;
  keepActiveTabVisible();
  updateStripFades();
}

// ---------------------------------------------------------------------------
// Scroll / arrow / keyboard behaviour
// ---------------------------------------------------------------------------

function wireStripArrows() {
  const strip = $(`#${TAB_STRIP_ID}`);
  const prev = $(`#${PREV_BTN_ID}`);
  const next = $(`#${NEXT_BTN_ID}`);
  if (!strip) return;
  const scrollBy = (dir) => {
    const card = strip.querySelector('.tool-nav-card');
    const step = card ? card.getBoundingClientRect().width + 12 : 160;
    strip.scrollBy({ left: step * dir, behavior: 'smooth' });
  };
  if (prev) prev.addEventListener('click', () => scrollBy(-1));
  if (next) next.addEventListener('click', () => scrollBy(1));
  strip.addEventListener('scroll', () => {
    updateStripFades();
    if (!initialScrollAligned) {
      // After the first user-driven scroll, lock the centred position.
      initialScrollAligned = true;
    }
  });
  // First-paint fade update after layout.
  requestAnimationFrame(() => updateStripFades());
}

function updateStripFades() {
  const strip = $(`#${TAB_STRIP_ID}`);
  if (!strip) return;
  const left = $(`#${STRIP_FADE_LEFT}`);
  const right = $(`#${STRIP_FADE_RIGHT}`);
  const prev = $(`#${PREV_BTN_ID}`);
  const next = $(`#${NEXT_BTN_ID}`);
  const max = strip.scrollWidth - strip.clientWidth - 1;
  const atStart = strip.scrollLeft <= 4;
  const atEnd = strip.scrollLeft >= max - 4;
  if (left) left.classList.toggle('is-active', !atStart);
  if (right) right.classList.toggle('is-active', !atEnd);
  if (prev) prev.disabled = atStart;
  if (next) next.disabled = atEnd;
}

function wireKeyboard() {
  const strip = $(`#${TAB_STRIP_ID}`);
  if (!strip) return;
  strip.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const cards = $$(`.tool-nav-card`, strip);
      const currentIndex = cards.findIndex((card) => card.dataset.tabId === currentTabId);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowRight') nextIndex = Math.min(cards.length - 1, currentIndex + 1);
      if (event.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1);
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = cards.length - 1;
      if (nextIndex !== currentIndex && cards[nextIndex]) {
        cards[nextIndex].focus();
        switchTab(cards[nextIndex].dataset.tabId);
      }
    }
  });
  window.addEventListener('hashchange', () => {
    const id = parseHash();
    if (id && id !== currentTabId) switchTab(id);
  });
}

function wireResize() {
  let raf = 0;
  const handler = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      updateStripFades();
      keepActiveTabVisible();
    });
  };
  window.addEventListener('resize', handler);
  window.addEventListener('orientationchange', handler);
}

/**
 * Centre the active tab card in the strip. Called after a tab switch,
 * after fonts load, and on resize. Aims for the centred position so
 * `scroll-snap-align: center` doesn't fight us.
 */
export function keepActiveTabVisible() {
  if (!initialScrollAligned) return; // wait for fonts/layout
  const strip = $(`#${TAB_STRIP_ID}`);
  if (!strip) return;
  const active = strip.querySelector('.tool-nav-card.is-active');
  if (!active) return;
  const stripRect = strip.getBoundingClientRect();
  const cardRect = active.getBoundingClientRect();
  const offset = (cardRect.left + cardRect.right) / 2 - (stripRect.left + stripRect.right) / 2;
  if (Math.abs(offset) < 1) return;
  strip.scrollBy({ left: offset, behavior: 'smooth' });
}

function parseHash() {
  const hash = window.location.hash || '';
  const match = hash.match(/^#([\w-]+)/);
  return match ? match[1] : null;
}


