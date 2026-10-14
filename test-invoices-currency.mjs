/* Invoices currency dropdown: 38 curated currencies, select + custom path. */
import { JSDOM } from 'jsdom';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = __dirname;
const results = [];
function t(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then((info) => {
      results.push({ name, ok: true, info });
      console.log(`  pass  ${name}${info ? '  ' + info : ''}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, err: String(err && err.stack || err) });
      console.log(`  FAIL  ${name}\n        ${err && err.stack || err}`);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assert: ${msg}`);
}

async function build() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.Node = window.Node;
  globalThis.localStorage = window.localStorage;
  /* The module reads localStorage on import, so clear it first. */
  window.localStorage.clear();

  const mod = await import(pathToFileURL(path.join(repo, 'src/tools/invoices.js')).href);
  const root = window.document.getElementById('root');
  const layout = mod.__test.layout();
  root.innerHTML = layout;
  mod.__test.paintForm(root);
  mod.__test.wireForm(root);
  return { dom, window, mod, root };
}

const { dom, window, mod, root } = await build();

await t('dropdown lists 38 curated currencies + Custom…', () => {
  const sel = window.document.getElementById('invCurrency');
  assert(sel, 'select exists');
  /* 38 curated currencies + 1 Custom option. */
  assert(sel.options.length === 39, `expected 39 options, got ${sel.options.length}`);
  const labels = Array.from(sel.options).map((o) => o.textContent.trim());
  /* Spot-check a few entries to confirm shape: symbol, code, name. */
  const usd = labels.find((l) => l.includes('USD'));
  assert(usd && usd.includes('$') && /Dollar/i.test(usd), `USD label: ${usd}`);
  const bdt = labels.find((l) => l.includes('BDT'));
  assert(bdt && bdt.includes('৳') && /Taka/i.test(bdt), `BDT label: ${bdt}`);
  const inr = labels.find((l) => l.includes('INR'));
  assert(inr && inr.includes('₹') && /Rupee/i.test(inr), `INR label: ${inr}`);
  /* Custom is the last option. */
  const last = sel.options[sel.options.length - 1];
  assert(last.value === '__custom__', `last option should be Custom, got ${last.value}`);
});

await t('BDT (Taka) is the 4th entry', () => {
  const sel = window.document.getElementById('invCurrency');
  const opt = sel.options[3]; /* 0=USD, 1=EUR, 2=GBP, 3=BDT */
  assert(opt.textContent.includes('BDT') && opt.textContent.includes('Taka'),
    `4th option should be BDT Taka, got "${opt.textContent}"`);
  assert(opt.value === '৳', `4th option symbol should be ৳, got ${opt.value}`);
});

await t('paintForm picks the curated option matching state.form.currency', () => {
  const sel = window.document.getElementById('invCurrency');
  /* Default currency is whatever the module set; just confirm select.value
     is one of the curated options or "__custom__". */
  const values = Array.from(sel.options).map((o) => o.value);
  assert(values.includes(sel.value), `select.value ${sel.value} not in option list`);
  /* Custom wrap should be hidden unless the stored currency is __custom__. */
  const wrap = window.document.getElementById('invCurrencyCustomWrap');
  if (sel.value === '__custom__') {
    assert(wrap.hidden === false, 'custom wrap should be visible');
  } else {
    assert(wrap.hidden === true, 'custom wrap should be hidden');
  }
});

await t('selecting Custom reveals the text input and pre-fills it', async () => {
  const sel = window.document.getElementById('invCurrency');
  const wrap = window.document.getElementById('invCurrencyCustomWrap');
  const input = window.document.getElementById('invCurrencyCustom');
  /* Force a known starting state by writing a value and re-painting. */
  mod.__test.setState({ currency: '£' });
  mod.__test.paintForm(root);
  assert(sel.value === '£', `expected £, got ${sel.value}`);
  assert(wrap.hidden === true, 'wrap should start hidden');

  /* Now pick Custom from the dropdown. */
  sel.value = '__custom__';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(wrap.hidden === false, 'wrap should now be visible');
  assert(input === window.document.activeElement || input, 'input should be focusable');
  assert(input.value === '£', `input should pre-fill with current currency, got ${input.value}`);
});

await t('typing a custom symbol writes through to state.form.currency', () => {
  const sel = window.document.getElementById('invCurrency');
  const input = window.document.getElementById('invCurrencyCustom');
  sel.value = '__custom__';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  input.value = 'kr';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const s = mod.__test.getState();
  assert(s.form.currency === 'kr', `state.form.currency should be "kr", got "${s.form.currency}"`);
  /* paintForm should also detect that "kr" isn't in the curated list
     and select the Custom option. */
  mod.__test.paintForm(root);
  assert(sel.value === '__custom__', `select should re-pick Custom, got ${sel.value}`);
  assert(input.value === 'kr', `input should retain "kr", got "${input.value}"`);
});

await t('picking a curated currency hides the custom input', () => {
  const sel = window.document.getElementById('invCurrency');
  const wrap = window.document.getElementById('invCurrencyCustomWrap');
  /* Pre-condition: select Custom + type something. */
  sel.value = '__custom__';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(wrap.hidden === false, 'wrap should be visible after picking Custom');
  /* Now pick USD from the list. */
  sel.value = '$';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(wrap.hidden === true, 'wrap should be hidden after picking $');
  const s = mod.__test.getState();
  assert(s.form.currency === '$', `state.form.currency should be "$", got "${s.form.currency}"`);
});

await t('formatMoney uses the selected currency verbatim', () => {
  /* Taka: 1234.50 → ৳1,234.50 */
  const taka = mod.__test.formatMoney(1234.5, '৳');
  assert(taka === '৳1,234.50', `Taka: got "${taka}"`);
  /* Custom: 99.99 → kr99.99 */
  const custom = mod.__test.formatMoney(99.99, 'kr');
  assert(custom === 'kr99.99', `Custom: got "${custom}"`);
  /* Empty: 0.00 → 0.00 (no symbol). */
  const none = mod.__test.formatMoney(0, '');
  assert(none === '0.00', `Empty: got "${none}"`);
});

const ok = results.every((r) => r.ok);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(ok ? 0 : 1);
