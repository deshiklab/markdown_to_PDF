/* End-to-end test: focus mode (hide chrome, show only the active tool).
   Drives shell.js directly through a JSDOM window with a minimal page that
   has the focus buttons already mounted. */
import jsdomPkg from 'jsdom';
const { JSDOM } = jsdomPkg;

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window; globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement; globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.File = window.File; globalThis.FileReader = window.FileReader; globalThis.Blob = window.Blob;
globalThis.FormData = window.FormData;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} });
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.DocumentFragment = window.DocumentFragment;

const document = window.document;
const body = document.body;

/* The shell needs these DOM elements to be present when it wires up. */
body.innerHTML = `
  <header class="site-header"></header>
  <main>
    <section class="intro"></section>
    <nav class="tool-nav" id="toolNav">
      <div class="tool-nav-scroll">
        <div class="tool-tablist" role="tablist">
          <button class="tool-tab is-active" data-tool="pdf-lab" id="tab-pdf-lab">PDF Lab</button>
          <button class="tool-tab" data-tool="sign" id="tab-sign">Sign</button>
        </div>
      </div>
    </nav>
    <div class="page-strip" id="pageStrip" hidden></div>
    <div class="tool-panels" id="toolPanels">
      <section class="tool-panel is-active" id="panel-pdf-lab"></section>
      <section class="tool-panel" id="panel-sign" hidden></section>
    </div>
  </main>
  <footer class="site-footer"></footer>
  <button id="focusToggle">Focus</button>
  <button id="focusExit" hidden>Exit</button>
`;

await import('file:///home/user/markdown_to_PDF/src/page.js').catch(() => {});
const shell = await import('file:///home/user/markdown_to_PDF/src/shell.js');

const focusToggle = document.querySelector('#focusToggle');
const focusExit = document.querySelector('#focusExit');

shell.startShell({ loaders: {} });

console.log('body.dataset.focus:', body.dataset.focus);
console.log('focus exit hidden initially:', focusExit?.hidden);

/* Click the Focus button. */
focusToggle.click();
console.log('--- after focus on ---');
console.log('body.dataset.focus:', body.dataset.focus);
if (body.dataset.focus !== 'on') { console.error('[FAIL] focus not on'); process.exit(1); }
if (!focusToggle.hidden) { console.error('[FAIL] focus toggle should be hidden in focus mode'); process.exit(1); }
if (focusExit.hidden) { console.error('[FAIL] focus exit should be visible in focus mode'); process.exit(1); }
console.log('[OK] focus toggle hides entry and shows exit');

/* Press Esc to exit. */
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
console.log('--- after Esc ---');
console.log('body.dataset.focus:', body.dataset.focus);
if (body.dataset.focus === 'on') { console.error('[FAIL] Esc did not exit focus'); process.exit(1); }
console.log('[OK] Esc exits focus mode');

/* Click Focus, then switch tabs. */
focusToggle.click();
const otherTab = document.querySelector('[data-tool="sign"]');
otherTab.click();
console.log('--- focus on, then tab switch ---');
console.log('body.dataset.focus:', body.dataset.focus);
if (body.dataset.focus === 'on') { console.error('[FAIL] tab switch should exit focus'); process.exit(1); }
console.log('[OK] tab switch exits focus mode');

/* Click Focus, then click the Exit button. */
focusToggle.click();
focusExit.click();
console.log('--- focus on, then exit button ---');
console.log('body.dataset.focus:', body.dataset.focus);
if (body.dataset.focus === 'on') { console.error('[FAIL] exit button did not work'); process.exit(1); }
console.log('[OK] exit-focus button works');

/* Hashchange should also exit focus. */
focusToggle.click();
window.location.hash = '#/sign';
window.dispatchEvent(new window.Event('hashchange'));
console.log('--- focus on, then hashchange ---');
console.log('body.dataset.focus:', body.dataset.focus);
if (body.dataset.focus === 'on') { console.error('[FAIL] hashchange should exit focus'); process.exit(1); }
console.log('[OK] hashchange exits focus mode');

console.log('\nAll focus-mode tests passed.');
process.exit(0);
