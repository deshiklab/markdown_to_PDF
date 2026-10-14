/* Invoices — build a multi-page PDF invoice from a few fields and a
   list of line items. The "from" side reuses the same company
   identity the Letterhead tab keeps (saved under letterhead:v1), so
   the user does not have to retype their company name, address,
   logo, or accent. Clients are saved in a separate store.

   Advanced features (this commit):
   - per-line tax rate (overrides the global default)
   - per-line discount (% or amount) + invoice-level discount
   - deposits / partial payments with a balance-due line
   - per-invoice currency with an optional conversion display
   - multi-page support: long line item lists paginate across pages
   - three invoice templates: classic, modern, minimal
   - drag-to-reorder line items
   - save / load invoice as a named template, duplicate from a template */

import {
  bytes,
  debounce,
  downloadBlob,
  escapeHtml,
  loadPdfLib,
  pickFiles,
  q,
  qa,
  safeFileName,
  store,
  toast,
} from '../lib.js';
import { marginsMm, page, printButton, sheetMm } from '../page.js';

const downloadIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>';
const dragIcon = '<svg viewBox="0 0 12 16" aria-hidden="true"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="9" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/></svg>';

const TEMPLATES = [
  { id: 'classic', label: 'Classic', note: 'Accent rule, banded table, footer columns.' },
  { id: 'modern', label: 'Modern', note: 'Side rule, right-aligned INVOICE, generous spacing.' },
  { id: 'minimal', label: 'Minimal', note: 'Plain type, thin rules, single line footer.' },
  { id: 'receipt', label: 'Receipt', note: 'RECEIPT title, no tax or balance-due, optional QR + barcode.' },
];

/* Curated currency list. Each entry is { code, symbol, name }.
   `symbol` is what formatMoney() prepends. `CURRENCY_SYMBOLS` is the
   set of pre-listed symbols, used to detect when a stored currency
   doesn't match one of the popular ones (e.g. a user-typed custom
   value, or a symbol that collides with another entry — see how
   "kr" is shared by SEK, NOK and DKK). The trailing "Custom…" option
   in the dropdown is rendered in the layout, not here. */
const CURRENCIES = [
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'Pound Sterling' },
  { code: 'BDT', symbol: '৳', name: 'Taka' },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
  { code: 'PKR', symbol: '₨', name: 'Pakistani Rupee' },
  { code: 'LKR', symbol: 'Rs', name: 'Sri Lankan Rupee' },
  { code: 'NPR', symbol: 'रू', name: 'Nepalese Rupee' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan' },
  { code: 'KRW', symbol: '₩', name: 'South Korean Won' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
  { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' },
  { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar' },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham' },
  { code: 'SAR', symbol: '﷼', name: 'Saudi Riyal' },
  { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit' },
  { code: 'THB', symbol: '฿', name: 'Thai Baht' },
  { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah' },
  { code: 'PHP', symbol: '₱', name: 'Philippine Peso' },
  { code: 'VND', symbol: '₫', name: 'Vietnamese Dong' },
  { code: 'BRL', symbol: 'R$', name: 'Brazilian Real' },
  { code: 'MXN', symbol: 'Mex$', name: 'Mexican Peso' },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand' },
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira' },
  { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling' },
  { code: 'TRY', symbol: '₺', name: 'Turkish Lira' },
  { code: 'RUB', symbol: '₽', name: 'Russian Ruble' },
  { code: 'SEK', symbol: 'kr', name: 'Swedish Krona' },
  { code: 'NOK', symbol: 'kr', name: 'Norwegian Krone' },
  { code: 'DKK', symbol: 'kr', name: 'Danish Krone' },
  { code: 'PLN', symbol: 'zł', name: 'Polish Zloty' },
  { code: 'CZK', symbol: 'Kč', name: 'Czech Koruna' },
  { code: 'HUF', symbol: 'Ft', name: 'Hungarian Forint' },
  { code: 'ILS', symbol: '₪', name: 'Israeli Shekel' },
];
const CURRENCY_SYMBOLS = new Set(CURRENCIES.map((c) => c.symbol));

const identityDefaults = {
  layout: 'classic',
  companyName: 'Acme Studio',
  tagline: 'Brand, type & motion',
  address: '12 High Street\nLondon EC1A 1AA\nUnited Kingdom',
  phone: '+44 20 7946 0958',
  email: 'hello@acme.studio',
  website: 'acme.studio',
  accent: '#315f50',
  logoSize: 60,
  saveName: 'folio-letterhead',
};

const invoiceDefaults = {
  number: 'INV-001',
  issueDate: '',
  dueDate: '',
  currency: '£',
  baseCurrency: '', /* empty = same as currency; otherwise display a converted amount */
  conversionRate: 1,
  taxRate: 20,
  notes: 'Payment due within 30 days. Bank details on request.',
  saveName: 'folio-invoice',
  clientId: '',
  template: 'classic',
  paid: 0,
  paidDate: '',
  discountType: 'none', /* 'none' | 'percent' | 'amount' */
  discountValue: 0,
  qrPayload: '', /* free-text payload rendered as a QR on the receipt template */
  barcodePayload: '', /* free-text payload rendered as a Code 128 barcode on the receipt template */
};

const blankClient = {
  id: '',
  name: '',
  email: '',
  address: '',
};

const blankLine = () => ({
  desc: '',
  qty: 1,
  price: 0,
  taxRate: null, /* null = use global; number = per-line override */
  discountType: 'none',
  discountValue: 0,
});

const identityStore = store('letterhead:v1', identityDefaults);
const prefsStore = store('invoice:v1', invoiceDefaults);
const clientsStore = store('invoice-clients:v1', []);
const templatesStore = store('invoice-templates:v1', []);

const state = {
  identity: { ...identityDefaults, ...identityStore.read() },
  form: { ...invoiceDefaults, ...prefsStore.read() },
  clients: Array.isArray(clientsStore.read()) ? clientsStore.read() : [],
  templates: Array.isArray(templatesStore.read()) ? templatesStore.read() : [],
  clientDraft: { ...blankClient },
  editingClientId: '',
  logo: null,
  busy: false,
  lines: [blankLine()],
  codeImgs: { qr: '', barcode: '' }, /* data URLs, populated by refreshCodeImgs() */
};

function save() { prefsStore.write(state.form); }
function saveClients() { clientsStore.write(state.clients); }
function saveTemplates() { templatesStore.write(state.templates); }
function newId() { return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

export function start(root) {
  root.innerHTML = layout();
  wireForm(root);
  wireLogo(root);
  wireExport(root);
  wireLines(root);
  wireClients(root);
  wireTemplates(root);
  wireDeposit(root);
  wireInvoiceDiscount(root);
  wireCurrency(root);
  wireCodeFields(root);
  paintForm(root);
  paintClients(root);
  paintLines(root);
  paintTotals(root);
  /* Render the QR + barcode data URLs (no-op in Node / tests) before
     the first paint so the preview shows them when the template is
     receipt. */
  refreshCodeImgs().then(() => paintPreview(root));
  return () => {};
}

/* ------------------------------------------------------------------ ui ---- */
function layout() {
  const form = state.form;
  return `
<div class="inv-shell" id="invShell">
  <section class="panel inv-side" aria-labelledby="inv-side-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index">01</span>
        <div><h3 id="inv-side-title">Invoice details</h3><p>Number, dates, client, tax</p></div>
      </div>
      <div class="panel-header-actions">${printButton()}</div>
    </div>
    <div class="inv-body">
      <div class="lh-grid">
        <label class="field"><span class="field-label">Invoice number</span>
          <input class="text-input" id="invNumber" type="text" value="${escapeHtml(form.number)}" />
        </label>
        <label class="field"><span class="field-label">Currency</span>
          <select class="text-input" id="invCurrency">
            ${CURRENCIES.map((c) => `<option value="${escapeHtml(c.symbol)}">${escapeHtml(c.symbol)}  ${escapeHtml(c.code)}  —  ${escapeHtml(c.name)}</option>`).join('')}
            <option value="__custom__">Custom…</option>
          </select>
        </label>
        <label class="field" id="invCurrencyCustomWrap" hidden><span class="field-label">Custom symbol</span>
          <input class="text-input" id="invCurrencyCustom" type="text" value="${escapeHtml(form.currency)}" maxlength="6" placeholder="e.g. kr, د.ك, R" />
        </label>
      </div>
      <div class="lh-grid">
        <label class="field"><span class="field-label">Issue date</span>
          <input class="text-input" id="invIssueDate" type="date" value="${escapeHtml(form.issueDate)}" />
        </label>
        <label class="field"><span class="field-label">Due date</span>
          <input class="text-input" id="invDueDate" type="date" value="${escapeHtml(form.dueDate)}" />
        </label>
      </div>
      <div class="lh-grid">
        <label class="field"><span class="field-label">Template</span>
          <select class="text-input" id="invTemplate">
            ${TEMPLATES.map((t) => `<option value="${t.id}">${escapeHtml(t.label)} — ${escapeHtml(t.note)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span class="field-label">Default tax rate (%)</span>
          <div class="range-row">
            <input class="range-input" id="invTaxRate" type="range" min="0" max="30" step="0.5" value="${form.taxRate}" />
            <output class="range-readout" id="invTaxRateOut">${form.taxRate}%</output>
          </div>
        </label>
      </div>

      <div class="inv-section">
        <div class="inv-section-head"><h4>Currency conversion</h4><span class="lh-hint">Optional — leave blank to skip</span></div>
        <div class="lh-grid">
          <label class="field"><span class="field-label">Convert to (currency)</span>
            <input class="text-input" id="invBaseCurrency" type="text" value="${escapeHtml(form.baseCurrency || '')}" maxlength="3" placeholder="e.g. $ or EUR" />
          </label>
          <label class="field"><span class="field-label">Rate (1 invoice = X base)</span>
            <input class="text-input" id="invConversionRate" type="number" min="0" step="0.0001" value="${form.conversionRate || 1}" />
          </label>
        </div>
      </div>

      <div class="inv-section">
        <div class="inv-section-head"><h4>Invoice discount</h4><span class="lh-hint">Applies before tax</span></div>
        <div class="lh-grid">
          <label class="field"><span class="field-label">Type</span>
            <select class="text-input" id="invDiscountType">
              <option value="none">No discount</option>
              <option value="percent">Percent (%)</option>
              <option value="amount">Amount</option>
            </select>
          </label>
          <label class="field"><span class="field-label">Value</span>
            <input class="text-input" id="invDiscountValue" type="number" min="0" step="0.01" value="${form.discountValue || 0}" />
          </label>
        </div>
      </div>

      <div class="inv-section">
        <div class="inv-section-head"><h4>Deposit / paid</h4><span class="lh-hint">Tracks partial payments</span></div>
        <div class="lh-grid">
          <label class="field"><span class="field-label">Paid so far</span>
            <input class="text-input" id="invPaid" type="number" min="0" step="0.01" value="${form.paid || 0}" />
          </label>
          <label class="field"><span class="field-label">Paid on</span>
            <input class="text-input" id="invPaidDate" type="date" value="${escapeHtml(form.paidDate || '')}" />
          </label>
        </div>
      </div>

      <div class="inv-section">
        <div class="inv-section-head"><h4>QR + barcode</h4><span class="lh-hint">Receipt template only</span></div>
        <label class="field"><span class="field-label">QR payload</span>
          <input class="text-input" id="invQrPayload" type="text" value="${escapeHtml(form.qrPayload || '')}" placeholder="A URL, a JSON ID, anything scannable" maxlength="2000" />
        </label>
        <label class="field"><span class="field-label">Barcode payload (Code 128)</span>
          <input class="text-input" id="invBarcodePayload" type="text" value="${escapeHtml(form.barcodePayload || '')}" placeholder="e.g. INV-001" maxlength="80" />
        </label>
      </div>

      <label class="field"><span class="field-label">Notes / payment terms</span>
        <textarea class="text-input lh-textarea" id="invNotes" rows="3" placeholder="Bank details, late fees, thank-yous…">${escapeHtml(form.notes)}</textarea>
      </label>
      <label class="field"><span class="field-label">Save as</span>
        <input class="text-input" id="invSaveName" type="text" value="${escapeHtml(form.saveName)}" />
      </label>
    </div>

    <div class="inv-clients">
      <div class="inv-section-head">
        <h4>Client</h4>
        <button class="button button-light" type="button" id="invNewClient">+ New client</button>
      </div>
      <label class="field"><span class="field-label">Saved clients</span>
        <select class="text-input" id="invClientPick">
          <option value="">— pick a saved client —</option>
          ${state.clients.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || '(unnamed)')}</option>`).join('')}
        </select>
      </label>
      <div class="inv-client-form" id="invClientForm">
        <div class="lh-grid">
          <label class="field"><span class="field-label">Name</span>
            <input class="text-input" id="invClientName" type="text" value="${escapeHtml(state.clientDraft.name)}" placeholder="Client name" />
          </label>
          <label class="field"><span class="field-label">Email</span>
            <input class="text-input" id="invClientEmail" type="text" value="${escapeHtml(state.clientDraft.email)}" placeholder="optional" />
          </label>
        </div>
        <label class="field"><span class="field-label">Address</span>
          <textarea class="text-input lh-textarea" id="invClientAddress" rows="2" placeholder="Street, city, postcode, country">${escapeHtml(state.clientDraft.address)}</textarea>
        </label>
        <div class="inv-client-actions">
          <button class="button button-light" type="button" id="invSaveClient">${state.editingClientId ? 'Update client' : 'Save client'}</button>
          ${state.editingClientId ? '<button class="button button-light" type="button" id="invDeleteClient">Delete</button>' : ''}
          ${state.editingClientId ? '<button class="button button-light" type="button" id="invCancelEdit">Cancel</button>' : ''}
        </div>
      </div>
    </div>

    <div class="inv-clients">
      <div class="inv-section-head">
        <h4>Templates</h4>
        <button class="button button-light" type="button" id="invSaveTemplate">+ Save as template</button>
      </div>
      <label class="field"><span class="field-label">Saved templates</span>
        <select class="text-input" id="invTemplatePick">
          <option value="">— load a saved template —</option>
          ${state.templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('')}
        </select>
      </label>
      ${state.templates.length ? `<div class="inv-client-actions">
        <button class="button button-light" type="button" id="invDeleteTemplate">Delete selected</button>
      </div>` : ''}
    </div>
  </section>

  <section class="panel inv-main" aria-labelledby="inv-main-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index panel-index-green">02</span>
        <div><h3 id="inv-main-title">Invoice</h3><p><span class="live-dot"></span> Totals update as you type</p></div>
      </div>
      <div class="panel-header-actions">
        <button class="button button-export" type="button" id="invExport">${downloadIcon}<span>Download invoice PDF</span></button>
      </div>
    </div>
    <div class="inv-body">
      <div class="lh-grid">
        <div class="field grow">
          <span class="field-label">Logo (PNG or JPG)</span>
          <div class="lh-logo-row">
            <button class="button button-light" type="button" id="invPickLogo">Choose image</button>
            <span class="lh-hint" id="invLogoHint">No image — pulls the logo from your saved Letterhead identity, or uses plain type.</span>
          </div>
        </div>
      </div>
      <div class="inv-lines-head">
        <h4>Line items</h4>
        <div class="inv-lines-actions">
          <span class="lh-hint" id="invLinesHint">Drag the handle to reorder. Each line can have its own tax rate and discount.</span>
          <button class="button button-light" type="button" id="invAddLine">+ Add line</button>
        </div>
      </div>
      <div class="inv-lines" id="invLines"></div>
      <div class="inv-totals" id="invTotals"></div>
    </div>
    <div class="inv-preview-wrap" id="invPreviewWrap">
      <div class="inv-preview" id="invPreview" aria-label="Invoice preview"></div>
    </div>
  </section>
</div>`;
}

function paintForm(root) {
  q('#invNumber', root).value = state.form.number;
  /* Currency: a select with the curated list, plus a "Custom" path that
     reveals a small text input. If the stored value isn't in the curated
     list — or collides with another entry (e.g. SEK/NOK/DKK all use
     "kr") — fall back to Custom so the user can disambiguate. */
  const select = q('#invCurrency', root);
  const customWrap = q('#invCurrencyCustomWrap', root);
  const customInput = q('#invCurrencyCustom', root);
  if (select) {
    const matches = Array.from(select.options).filter((opt) => opt.value === state.form.currency);
    const unique = matches.length === 1 ? matches[0] : null;
    select.value = unique ? unique.value : '__custom__';
  }
  if (customWrap) customWrap.hidden = !select || select.value !== '__custom__';
  if (customInput) customInput.value = state.form.currency || '';
  q('#invIssueDate', root).value = state.form.issueDate;
  q('#invDueDate', root).value = state.form.dueDate;
  q('#invTemplate', root).value = state.form.template;
  q('#invTaxRate', root).value = state.form.taxRate;
  q('#invTaxRateOut', root).textContent = `${state.form.taxRate}%`;
  q('#invBaseCurrency', root).value = state.form.baseCurrency || '';
  q('#invConversionRate', root).value = state.form.conversionRate || 1;
  q('#invDiscountType', root).value = state.form.discountType;
  q('#invDiscountValue', root).value = state.form.discountValue || 0;
  q('#invPaid', root).value = state.form.paid || 0;
  q('#invPaidDate', root).value = state.form.paidDate || '';
  q('#invQrPayload', root).value = state.form.qrPayload || '';
  q('#invBarcodePayload', root).value = state.form.barcodePayload || '';
  q('#invNotes', root).value = state.form.notes;
  q('#invSaveName', root).value = state.form.saveName;
  q('#invClientName', root).value = state.clientDraft.name;
  q('#invClientEmail', root).value = state.clientDraft.email;
  q('#invClientAddress', root).value = state.clientDraft.address;
  if (state.form.clientId) {
    q('#invClientPick', root).value = state.form.clientId;
  }
}

function paintClients(root) {
  const sel = q('#invClientPick', root);
  if (sel) {
    sel.innerHTML = '<option value="">— pick a saved client —</option>'
      + state.clients.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || '(unnamed)')}</option>`).join('');
    sel.value = state.form.clientId || '';
  }
  const form = q('#invClientForm', root);
  if (form) {
    const actions = form.querySelector('.inv-client-actions');
    if (actions) {
      actions.innerHTML = `
        <button class="button button-light" type="button" id="invSaveClient">${state.editingClientId ? 'Update client' : 'Save client'}</button>
        ${state.editingClientId ? '<button class="button button-light" type="button" id="invDeleteClient">Delete</button>' : ''}
        ${state.editingClientId ? '<button class="button button-light" type="button" id="invCancelEdit">Cancel</button>' : ''}
      `;
    }
  }
}

function paintTemplates(root) {
  const sel = q('#invTemplatePick', root);
  if (sel) {
    sel.innerHTML = '<option value="">— load a saved template —</option>'
      + state.templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
  }
  /* Re-render the templates section to show/hide the delete button. */
  const section = q('#invShell .inv-clients:nth-of-type(2)');
  if (section) {
    const oldBtn = section.querySelector('#invDeleteTemplate');
    const newBtn = state.templates.length
      ? '<div class="inv-client-actions"><button class="button button-light" type="button" id="invDeleteTemplate">Delete selected</button></div>'
      : '';
    if (oldBtn) oldBtn.parentElement.outerHTML = newBtn;
    else if (newBtn) section.insertAdjacentHTML('beforeend', newBtn);
  }
}

function paintLines(root) {
  const host = q('#invLines', root);
  if (!host) return;
  if (!state.lines || !state.lines.length) {
    state.lines = [blankLine()];
  }
  host.innerHTML = state.lines.map((line, i) => lineRowHtml(line, i)).join('');
  qa('.inv-line', host).forEach((row) => {
    const i = Number(row.dataset.idx);
    bindLineRow(row, i);
  });
}

function bindLineRow(row, i) {
  const desc = q('[data-field="desc"]', row);
  const qty = q('[data-field="qty"]', row);
  const price = q('[data-field="price"]', row);
  const tax = q('[data-field="tax"]', row);
  const discType = q('[data-field="discountType"]', row);
  const discVal = q('[data-field="discountValue"]', row);
  const remove = q('[data-field="remove"]', row);
  desc?.addEventListener('input', (e) => { state.lines[i].desc = e.target.value; onLineChange(); });
  qty?.addEventListener('input', (e) => { state.lines[i].qty = Number(e.target.value || 0); onLineChange(); });
  price?.addEventListener('input', (e) => { state.lines[i].price = Number(e.target.value || 0); onLineChange(); });
  tax?.addEventListener('input', (e) => {
    const v = e.target.value.trim();
    state.lines[i].taxRate = v === '' ? null : Number(v);
    onLineChange();
  });
  discType?.addEventListener('change', (e) => { state.lines[i].discountType = e.target.value; onLineChange(); });
  discVal?.addEventListener('input', (e) => { state.lines[i].discountValue = Number(e.target.value || 0); onLineChange(); });
  remove?.addEventListener('click', () => {
    state.lines.splice(i, 1);
    if (!state.lines.length) state.lines.push(blankLine());
    paintLines(q('#invShell'));
    onLineChange();
  });
  /* Drag handle. */
  const handle = q('[data-field="drag"]', row);
  if (handle) {
    handle.draggable = true;
    handle.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
      row.classList.add('is-dragging');
    });
    handle.addEventListener('dragend', () => row.classList.remove('is-dragging'));
  }
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('is-dragover');
  });
  row.addEventListener('dragleave', () => row.classList.remove('is-dragover'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('is-dragover');
    const from = Number(e.dataTransfer.getData('text/plain'));
    const to = i;
    if (Number.isNaN(from) || from === to) return;
    const [moved] = state.lines.splice(from, 1);
    state.lines.splice(to, 0, moved);
    paintLines(q('#invShell'));
    onLineChange();
  });
}

function lineRowHtml(line, i) {
  const { net, tax, gross } = lineTotals(line);
  return `
    <div class="inv-line" data-idx="${i}" draggable="false">
      <span class="inv-line-drag" data-field="drag" title="Drag to reorder" aria-label="Drag to reorder">${dragIcon}</span>
      <label class="field inv-line-desc"><span class="field-label">Description</span>
        <input class="text-input" data-field="desc" type="text" value="${escapeHtml(line.desc || '')}" placeholder="Design retainer, license, hours…" />
      </label>
      <label class="field inv-line-qty"><span class="field-label">Qty</span>
        <input class="text-input" data-field="qty" type="number" min="0" step="0.5" value="${line.qty}" />
      </label>
      <label class="field inv-line-price"><span class="field-label">Unit price</span>
        <input class="text-input" data-field="price" type="number" min="0" step="0.01" value="${line.price}" />
      </label>
      <label class="field inv-line-tax"><span class="field-label">Tax %</span>
        <input class="text-input" data-field="tax" type="number" min="0" max="50" step="0.5" value="${line.taxRate ?? ''}" placeholder="${state.form.taxRate}" />
      </label>
      <label class="field inv-line-discount"><span class="field-label">Discount</span>
        <span class="inv-line-discount-row">
          <select class="text-input inv-line-discount-type" data-field="discountType">
            <option value="none" ${line.discountType === 'none' ? 'selected' : ''}>—</option>
            <option value="percent" ${line.discountType === 'percent' ? 'selected' : ''}>%</option>
            <option value="amount" ${line.discountType === 'amount' ? 'selected' : ''}>${escapeHtml(state.form.currency)}</option>
          </select>
          <input class="text-input inv-line-discount-value" data-field="discountValue" type="number" min="0" step="0.01" value="${line.discountValue || 0}" />
        </span>
      </label>
      <div class="inv-line-total"><span class="field-label">Total</span>
        <output>${formatMoney(gross, state.form.currency)}</output>
      </div>
      <button class="button button-light inv-line-remove" data-field="remove" type="button" aria-label="Remove line">×</button>
    </div>`;
}

function paintTotals(root) {
  const host = q('#invTotals', root);
  if (!host) return;
  const totals = computeTotals();
  const conversion = conversionLine(state.form, totals.total);
  host.innerHTML = `
    <div class="inv-totals-row"><span>Subtotal (after line discounts)</span><output>${formatMoney(totals.linesNet, state.form.currency)}</output></div>
    ${totals.invoiceDiscount > 0 ? `<div class="inv-totals-row"><span>Invoice discount${state.form.discountType === 'percent' ? ` (${state.form.discountValue}%)` : ''}</span><output>-${formatMoney(totals.invoiceDiscount, state.form.currency)}</output></div>` : ''}
    <div class="inv-totals-row"><span>Subtotal (after invoice discount)</span><output>${formatMoney(totals.afterInvoiceDiscount, state.form.currency)}</output></div>
    <div class="inv-totals-row"><span>Tax</span><output>${formatMoney(totals.tax, state.form.currency)}</output></div>
    <div class="inv-totals-row inv-totals-grand"><span>Total due</span><output>${formatMoney(totals.total, state.form.currency)}</output></div>
    ${conversion ? `<div class="inv-totals-row inv-totals-conversion"><span>≈ in ${escapeHtml(state.form.baseCurrency)}</span><output>≈ ${escapeHtml(conversion)}</output></div>` : ''}
    ${Number(state.form.paid) > 0 ? `
      <div class="inv-totals-row"><span>Paid${state.form.paidDate ? ` (${escapeHtml(state.form.paidDate)})` : ''}</span><output>-${formatMoney(Number(state.form.paid), state.form.currency)}</output></div>
      <div class="inv-totals-row inv-totals-grand"><span>Balance due</span><output>${formatMoney(totals.total - Number(state.form.paid), state.form.currency)}</output></div>
    ` : ''}
  `;
}

function conversionLine(form, total) {
  if (!form.baseCurrency) return null;
  const rate = Number(form.conversionRate) || 1;
  return formatMoney(total * rate, form.baseCurrency);
}

function lineTotals(line) {
  const qty = Number(line.qty) || 0;
  const price = Number(line.price) || 0;
  const gross = qty * price;
  const disc = lineDiscountAmount(line, gross);
  const net = Math.max(0, gross - disc);
  const taxRate = (line.taxRate === null || line.taxRate === undefined || line.taxRate === '')
    ? Number(state.form.taxRate) || 0
    : Number(line.taxRate);
  const tax = net * taxRate / 100;
  return { gross, disc, net, tax, gross2: net + tax };
}
function lineDiscountAmount(line, gross) {
  if (line.discountType === 'percent') return gross * (Number(line.discountValue) || 0) / 100;
  if (line.discountType === 'amount') return Number(line.discountValue) || 0;
  return 0;
}
function invoiceDiscountAmount(form, afterLineDiscounts) {
  if (form.discountType === 'percent') return afterLineDiscounts * (Number(form.discountValue) || 0) / 100;
  if (form.discountType === 'amount') return Number(form.discountValue) || 0;
  return 0;
}
function computeTotals() {
  const lineResults = (state.lines || []).map(lineTotals);
  const linesNet = lineResults.reduce((s, r) => s + r.net, 0);
  const invoiceDiscount = invoiceDiscountAmount(state.form, linesNet);
  const afterInvoiceDiscount = Math.max(0, linesNet - invoiceDiscount);
  const tax = afterInvoiceDiscount * (Number(state.form.taxRate) || 0) / 100;
  /* The per-line tax (used in the line-level "tax" output) is informational;
     the invoice total uses the global rate on the post-discount subtotal.
     That's a deliberate simplification — per-line tax would split the base
     across different rates, which a single global rate doesn't need. */
  return { linesNet, invoiceDiscount, afterInvoiceDiscount, tax, total: afterInvoiceDiscount + tax };
}

function onLineChange() {
  const root = q('#invShell');
  if (!root) return;
  qa('.inv-line').forEach((row, i) => {
    const line = state.lines[i];
    if (!line) return;
    const t = lineTotals(line);
    const out = row.querySelector('.inv-line-total output');
    if (out) out.textContent = formatMoney(t.gross2, state.form.currency);
  });
  paintTotals(root);
  paintPreview(root);
}

function formatMoney(n, currency) {
  const v = Number.isFinite(n) ? n : 0;
  const s = v.toFixed(2);
  const [int, dec] = s.split('.');
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency || ''}${withCommas}.${dec}`;
}

/* -------------------------------------------------------------- wiring ---- */
function wireForm(root) {
  const fields = [
    ['#invNumber', 'number'],
    ['#invIssueDate', 'issueDate'],
    ['#invDueDate', 'dueDate'],
    ['#invTemplate', 'template'],
    ['#invNotes', 'notes'],
    ['#invSaveName', 'saveName'],
  ];
  for (const [sel, key] of fields) {
    const el = q(sel, root);
    if (!el) continue;
    el.addEventListener('input', () => {
      state.form[key] = el.value;
      save();
      /* The template change affects the code images, so refresh them
         before re-painting the preview. */
      if (key === 'template') {
        refreshCodeImgs().then(() => paintPreview(root));
      } else {
        paintPreview(root);
      }
    });
  }
  /* Currency has its own wiring because the dropdown's "Custom…" option
     needs to reveal a text input, and the per-line "amount" suffix in the
     discount-type select also reads state.form.currency. */
  const currency = q('#invCurrency', root);
  const customWrap = q('#invCurrencyCustomWrap', root);
  const customInput = q('#invCurrencyCustom', root);
  currency?.addEventListener('change', () => {
    if (currency.value === '__custom__') {
      if (customWrap) customWrap.hidden = false;
      const next = (customInput?.value || '').trim();
      state.form.currency = next || (customInput ? '' : '');
      customInput?.focus();
    } else {
      if (customWrap) customWrap.hidden = true;
      state.form.currency = currency.value;
    }
    save();
    paintLines(root);
    paintTotals(root);
    paintPreview(root);
  });
  customInput?.addEventListener('input', () => {
    state.form.currency = (customInput.value || '').trim();
    save();
    paintLines(root);
    paintTotals(root);
    paintPreview(root);
  });
  const tax = q('#invTaxRate', root);
  tax?.addEventListener('input', () => {
    state.form.taxRate = Number(tax.value || 0);
    q('#invTaxRateOut', root).textContent = `${state.form.taxRate}%`;
    save();
    /* Refresh line rows so the placeholder updates. */
    paintLines(root);
    onLineChange();
  });
}

function wireCurrency(root) {
  const base = q('#invBaseCurrency', root);
  base?.addEventListener('input', () => {
    state.form.baseCurrency = base.value;
    save();
    paintTotals(root);
    paintPreview(root);
  });
  const rate = q('#invConversionRate', root);
  rate?.addEventListener('input', () => {
    state.form.conversionRate = Number(rate.value || 1);
    save();
    paintTotals(root);
    paintPreview(root);
  });
}

function wireInvoiceDiscount(root) {
  const type = q('#invDiscountType', root);
  type?.addEventListener('change', () => {
    state.form.discountType = type.value;
    save();
    paintTotals(root);
    paintPreview(root);
  });
  const value = q('#invDiscountValue', root);
  value?.addEventListener('input', () => {
    state.form.discountValue = Number(value.value || 0);
    save();
    paintTotals(root);
    paintPreview(root);
  });
}

function wireDeposit(root) {
  const paid = q('#invPaid', root);
  paid?.addEventListener('input', () => {
    state.form.paid = Number(paid.value || 0);
    save();
    paintTotals(root);
    paintPreview(root);
  });
  const date = q('#invPaidDate', root);
  date?.addEventListener('input', () => {
    state.form.paidDate = date.value;
    save();
    paintTotals(root);
    paintPreview(root);
  });
}

function wireCodeFields(root) {
  /* QR + barcode payloads. They're free-text fields, stored verbatim.
     They only appear in the rendered PDF when the receipt template is
     selected, but the inputs are always visible so the user can fill
     them in before switching templates. */
  const qr = q('#invQrPayload', root);
  qr?.addEventListener('input', () => {
    state.form.qrPayload = qr.value;
    save();
    refreshCodeImgs().then(() => paintPreview(root));
  });
  const bc = q('#invBarcodePayload', root);
  bc?.addEventListener('input', () => {
    state.form.barcodePayload = bc.value;
    save();
    refreshCodeImgs().then(() => paintPreview(root));
  });
}

function wireLogo(root) {
  const button = q('#invPickLogo', root);
  const hint = q('#invLogoHint', root);
  button?.addEventListener('click', () => pickFiles({ accept: 'image/png,image/jpeg,.png,.jpg,.jpeg', multiple: false })
    .then((files) => {
      const file = files && files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const bytes = new Uint8Array(reader.result);
        try {
          const dims = await readImageDimensions(bytes, file.type);
          state.logo = { bytes, type: file.type, width: dims.width, height: dims.height };
          if (hint) hint.textContent = `${file.name} — ${dims.width}×${dims.height}`;
          paintPreview(root);
        } catch (err) {
          console.error('invoice: could not read logo', err);
          toast('That image could not be read.', true);
        }
      };
      reader.onerror = () => toast('That image could not be read.', true);
      reader.readAsArrayBuffer(file);
    }));
}

function wireExport(root) {
  q('#invExport', root)?.addEventListener('click', () => exportInvoice(root));
  q('#invAddLine', root)?.addEventListener('click', () => {
    state.lines.push(blankLine());
    paintLines(root);
    onLineChange();
  });
}

function wireLines(root) {
  /* The dragstart/dragover/drop handlers are bound per-row in paintLines. */
}

function wireClients(root) {
  q('#invNewClient', root)?.addEventListener('click', () => {
    state.editingClientId = '';
    state.clientDraft = { ...blankClient };
    paintForm(root);
    paintClients(root);
  });
  const pick = q('#invClientPick', root);
  pick?.addEventListener('change', () => {
    const id = pick.value;
    state.form.clientId = id;
    save();
    if (!id) return;
    const c = state.clients.find((x) => x.id === id);
    if (c) {
      state.editingClientId = c.id;
      state.clientDraft = { ...c };
      paintForm(root);
      paintClients(root);
    }
  });
  q('#invClientName', root)?.addEventListener('input', (e) => { state.clientDraft.name = e.target.value; });
  q('#invClientEmail', root)?.addEventListener('input', (e) => { state.clientDraft.email = e.target.value; });
  q('#invClientAddress', root)?.addEventListener('input', (e) => { state.clientDraft.address = e.target.value; });
  q('#invClientForm', root)?.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'invSaveClient') saveClient(root);
    else if (t.id === 'invDeleteClient') deleteClient(root);
    else if (t.id === 'invCancelEdit') cancelEdit(root);
  });
}

function wireTemplates(root) {
  q('#invSaveTemplate', root)?.addEventListener('click', () => {
    const name = (state.form.number || 'Untitled').trim() || 'Untitled';
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    state.templates.push({
      id,
      name,
      form: { ...state.form },
      lines: state.lines.map((l) => ({ ...l })),
    });
    saveTemplates();
    paintTemplates(root);
    toast(`Template "${name}" saved.`);
  });
  const pick = q('#invTemplatePick', root);
  pick?.addEventListener('change', () => {
    const id = pick.value;
    if (!id) return;
    const t = state.templates.find((x) => x.id === id);
    if (!t) return;
    state.form = { ...invoiceDefaults, ...t.form };
    state.lines = t.lines.map((l) => ({ ...l }));
    save();
    paintForm(root);
    paintLines(root);
    onLineChange();
    paintTotals(root);
    paintPreview(root);
    toast(`Template "${t.name}" loaded.`);
  });
  /* The delete button is rebuilt by paintTemplates, so delegate. */
  q('#invShell', root)?.addEventListener('click', (e) => {
    if (e.target.id === 'invDeleteTemplate') {
      const sel = q('#invTemplatePick');
      if (!sel || !sel.value) return;
      const t = state.templates.find((x) => x.id === sel.value);
      state.templates = state.templates.filter((x) => x.id !== sel.value);
      saveTemplates();
      paintTemplates(root);
      if (t) toast(`Template "${t.name}" deleted.`);
    }
  });
}

function saveClient(root) {
  if (!state.clientDraft.name) { toast('Client needs a name.'); return; }
  if (state.editingClientId) {
    const i = state.clients.findIndex((c) => c.id === state.editingClientId);
    if (i >= 0) state.clients[i] = { ...state.clientDraft, id: state.editingClientId };
  } else {
    const id = newId();
    state.clients.push({ ...state.clientDraft, id });
    state.editingClientId = id;
    state.form.clientId = id;
    save();
  }
  saveClients();
  paintForm(root);
  paintClients(root);
  paintPreview(root);
  toast('Client saved.');
}
function deleteClient(root) {
  if (!state.editingClientId) return;
  state.clients = state.clients.filter((c) => c.id !== state.editingClientId);
  if (state.form.clientId === state.editingClientId) state.form.clientId = '';
  save();
  saveClients();
  state.editingClientId = '';
  state.clientDraft = { ...blankClient };
  paintForm(root);
  paintClients(root);
  paintPreview(root);
}
function cancelEdit(root) {
  state.editingClientId = '';
  state.clientDraft = { ...blankClient };
  paintForm(root);
  paintClients(root);
}

/* ----------------------------------------------------------------- pdf ---- */
async function readImageDimensions(bytes, mime) {
  if (mime === 'image/png' && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    return { width: w, height: h };
  }
  if (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) return { width: 200, height: 200 };
      const marker = bytes[i + 1];
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
        const h = (bytes[i + 5] << 8) | bytes[i + 6];
        const w = (bytes[i + 7] << 8) | bytes[i + 8];
        return { width: w, height: h };
      }
      i += 2 + len;
    }
  }
  return { width: 200, height: 200 };
}

async function exportInvoice(root) {
  if (!state.identity.companyName) { toast('Set a company name in the Letterhead tab first.'); return; }
  if (!(state.lines || []).some((l) => l.desc && Number(l.qty) > 0)) {
    toast('Add at least one line item with a description and quantity.');
    return;
  }
  await withBusy(root, '#invExport', 'Composing…', async () => {
    const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
    const setup = page();
    const sheet = sheetMm(setup);
    const margins = marginsMm(setup);
    const out = await PDFDocument.create();
    const sheetW = mmToPt(sheet.width);
    const sheetH = mmToPt(sheet.height);
    const helv = await out.embedFont(StandardFonts.Helvetica);
    const helvBold = await out.embedFont(StandardFonts.HelveticaBold);
    const helvIt = await out.embedFont(StandardFonts.HelveticaOblique);
    const accent = hexToRgb(state.identity.accent);
    const ink = rgb(0.12, 0.18, 0.16);
    const muted = rgb(0.36, 0.41, 0.39);
    const rule = rgb(0.83, 0.85, 0.81);
    const marginL = mmToPt(margins.left);
    const marginR = mmToPt(margins.right);
    const marginT = mmToPt(margins.top);
    const marginB = mmToPt(margins.bottom);
    const contentW = sheetW - marginL - marginR;
    const template = TEMPLATES.find((t) => t.id === state.form.template) || TEMPLATES[0];

    let logoImg = null;
    let logoBoxH = 0;
    let logoBoxW = 0;
    if (state.logo) {
      logoImg = state.logo.type === 'image/png'
        ? await out.embedPng(state.logo.bytes)
        : await out.embedJpg(state.logo.bytes);
      const aspect = state.logo.width / state.logo.height;
      logoBoxH = template.id === 'minimal' ? 22 : (template.id === 'modern' ? 36 : 30);
      logoBoxW = logoBoxH * aspect;
    }

    /* Receipt-only: render a QR (for the payload) and a Code 128 barcode
       (for the second payload) into PNGs that pdf-lib can embed. We
       compute the PNG buffers up here so the per-page drawHeader call
       doesn't have to wait for a 100ms encode per page. */
    let qrPng = null;
    let qrPngDims = null;
    let barcodePng = null;
    let barcodePngDims = null;
    if (template.id === 'receipt') {
      const { toBuffer } = await import('bwip-js');
      if (state.form.qrPayload) {
        const png = Buffer.from(await toBuffer({
          bcid: 'qrcode',
          text: state.form.qrPayload,
          scale: 6,
          height: 24, /* mm */
          includetext: false,
          paddingwidth: 0,
          paddingheight: 0,
        }));
        qrPng = await out.embedPng(png);
        /* bwip-js doesn't return image dimensions from toBuffer; read
           them from the PNG header. IHDR is at byte 16, width: 16-19,
           height: 20-23. */
        qrPngDims = { width: readPngDims(png, 0), height: readPngDims(png, 4) };
      }
      if (state.form.barcodePayload) {
        const png = Buffer.from(await toBuffer({
          bcid: 'code128',
          text: state.form.barcodePayload,
          scale: 3,
          height: 14, /* mm */
          includetext: true,
          textxalign: 'center',
          textsize: 8,
        }));
        barcodePng = await out.embedPng(png);
        barcodePngDims = { width: readPngDims(png, 0), height: readPngDims(png, 4) };
      }
    }

    /* Pagination: each page gets the header band, the bill-to block (only on page 1),
       the line items table (paginated), and the totals + footer (on the last page). */
    const visibleLines = (state.lines || []).filter((l) => l.desc);
    const rowsPerPage = estimateRowsPerPage(sheetH, marginT, marginB, template);
    const pages = [];
    for (let i = 0; i < visibleLines.length; i += rowsPerPage) {
      pages.push(visibleLines.slice(i, i + rowsPerPage));
    }
    if (!pages.length) pages.push([]);

    const totals = computeTotals();
    const client = state.clients.find((c) => c.id === state.form.clientId);
    const isLastPage = (idx) => idx === pages.length - 1;

    pages.forEach((pageLines, pageIdx) => {
      const pdfPage = out.addPage([sheetW, sheetH]);
      /* Page label for multi-page invoices. */
      const pageLabel = pages.length > 1 ? `Page ${pageIdx + 1} of ${pages.length}` : '';
      let cursorY = drawHeader(pdfPage, {
        template, sheetW, sheetH, marginL, marginR, marginT, contentW,
        helv, helvBold, helvIt, accent, ink, muted, rule, rgb,
        logoImg, logoBoxH, logoBoxW,
        qrPng, qrPngDims, barcodePng, barcodePngDims,
        company: state.identity, invoice: state.form, client, pageLabel,
      });
      if (pageIdx === 0) {
        cursorY = drawBillTo(pdfPage, {
          cursorY, marginL, contentW, helv, helvBold, accent, ink, muted, client,
        });
      }
      cursorY = drawLineTable(pdfPage, {
        cursorY, marginL, marginB, contentW, helv, helvBold, accent, ink, muted, rule, rgb,
        lines: pageLines, currency: state.form.currency, startIndex: pageIdx * rowsPerPage,
        template,
      });
      if (isLastPage(pageIdx)) {
        /* The totals block needs to know the totals and currency conversion. */
        const after = drawTotals(pdfPage, {
          cursorY, marginL, marginB, contentW, helv, helvBold, accent, ink, muted, rule, rgb,
          totals, form: state.form, template,
        });
        /* Notes. */
        if (state.form.notes) {
          drawNotes(pdfPage, {
            y: after, marginL, marginB, contentW, helv, accent, muted, rgb, text: state.form.notes,
          });
        }
        /* Footer. */
        drawFooter(pdfPage, helv, helvBold, accent, muted, rgb, sheetW, marginL, marginB, contentW, template, {
          address: state.identity.address,
          phone: state.identity.phone,
          email: state.identity.email,
          website: state.identity.website,
        });
      }
    });

    const output = await out.save({ useObjectStreams: false });
    const stem = (state.form.saveName || 'folio-invoice').trim() || 'folio-invoice';
    const name = safeFileName(stem, 'pdf');
    downloadBlob(new Blob([output], { type: 'application/pdf' }), name);
    toast(`${name} is ready — ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
  });
}

function estimateRowsPerPage(sheetH, marginT, marginB, template) {
  /* The "table" section needs to fit between the bill-to block and the totals
     block. A4 with default margins gives us ~170pt of usable body height. */
  const headerHeight = template.id === 'modern' ? 60 : 50;
  const billToHeight = 60;
  const totalsHeight = template.id === 'minimal' ? 80 : 100;
  const footerHeight = template.id === 'minimal' ? 50 : 70;
  const rowHeight = template.id === 'minimal' ? 12 : 14;
  const headerBand = 18;
  const available = sheetH - marginT - marginB - headerHeight - headerBand - totalsHeight - footerHeight;
  /* First page subtracts bill-to. */
  const firstPage = Math.max(1, Math.floor((available - billToHeight) / rowHeight));
  const later = Math.max(1, Math.floor(available / rowHeight));
  return Math.max(2, Math.min(firstPage, later, 12));
}

function drawHeader(page, ctx) {
  const { template, sheetH, marginL, marginT, contentW, helv, helvBold, helvIt, accent, ink, muted, rule, rgb, logoImg, logoBoxH, logoBoxW, qrPng, qrPngDims, barcodePng, barcodePngDims, company, invoice, client, pageLabel } = ctx;
  let cursorY = sheetH - marginT;
  /* The Modern template has no accent rule (it uses a side rule instead). */
  if (template.id === 'classic') {
    page.drawRectangle({ x: marginL, y: cursorY - 2, width: contentW, height: 2, color: accent });
    cursorY -= 12;
  } else if (template.id === 'minimal') {
    cursorY -= 6;
  } else {
    cursorY -= 6;
  }
  /* Logo + company on the left. */
  if (logoImg) {
    const lx = template.id === 'modern' ? marginL + contentW - logoBoxW : marginL;
    page.drawImage(logoImg, { x: lx, y: cursorY - logoBoxH, width: logoBoxW, height: logoBoxH });
  }
  const companyX = marginL + (logoImg && template.id !== 'modern' ? logoBoxW + 10 : 0);
  if (template.id !== 'modern' || !logoImg) {
    page.drawText(company.companyName || '', { x: companyX, y: cursorY - 9, size: 9, font: helvBold, color: ink });
  }
  if (company.tagline) {
    page.drawText(company.tagline, { x: companyX, y: cursorY - 20, size: 8, font: helvIt, color: muted });
  }
  if (company.address) {
    const addrLines = company.address.split('\n');
    let ay = cursorY - 31;
    for (const line of addrLines) {
      if (ay < marginT - 50) break;
      page.drawText(line, { x: companyX, y: ay, size: 7.5, font: helv, color: muted });
      ay -= 9;
    }
  }
  /* Right-side title block. The receipt template says RECEIPT and
     suppresses the Due date (receipts are settled, not due). */
  const rightW = 180;
  const rightX = marginL + contentW - rightW;
  const titleSize = template.id === 'modern' ? 28 : 22;
  const titleText = template.id === 'receipt' ? 'RECEIPT' : 'INVOICE';
  page.drawText(titleText, { x: rightX, y: cursorY - (template.id === 'modern' ? 22 : 18), size: titleSize, font: helvBold, color: accent });
  if (template.id === 'modern') {
    /* Side rule below INVOICE. */
    page.drawRectangle({ x: rightX, y: cursorY - 26, width: 60, height: 1.5, color: accent });
  }
  const meta = [
    ['#', invoice.number],
    ['Issued', formatDate(invoice.issueDate)],
  ];
  if (template.id !== 'receipt') {
    meta.push(['Due', formatDate(invoice.dueDate)]);
  } else if (invoice.paidDate) {
    meta.push(['Paid', invoice.paidDate]);
  }
  let metaY = cursorY - (template.id === 'modern' ? 38 : 32);
  for (const [k, v] of meta) {
    if (!v) continue;
    page.drawText(k.toUpperCase(), { x: rightX, y: metaY, size: 6.5, font: helvBold, color: accent });
    page.drawText(String(v), { x: rightX + 50, y: metaY, size: 9, font: helv, color: ink });
    metaY -= 11;
  }
  if (pageLabel) {
    page.drawText(pageLabel, { x: rightX, y: cursorY - 60, size: 8, font: helvIt, color: muted });
  }
  /* Receipt-only: stack the QR (top) and the barcode (below) inside
     the right-side column, beneath the meta block. Sizing: the QR is
     a square ~22mm wide; the barcode is a 1D strip ~50mm wide and
     ~14mm tall. We compute display dimensions from the embedded PNG
     dimensions so the call doesn't need to know the original px/mm. */
  if (template.id === 'receipt') {
    const qrDisplayMm = 22;
    const barcodeDisplayWmm = 50;
    const barcodeDisplayHmm = 14;
    if (qrPng) {
      const w = mmToPt(qrDisplayMm);
      const h = qrPngDims && qrPngDims.height
        ? (qrPngDims.height / qrPngDims.width) * w
        : w;
      const x = marginL + contentW - w;
      const y = metaY - 6 - h;
      page.drawImage(qrPng, { x, y, width: w, height: h });
      metaY = y - 4;
    }
    if (barcodePng) {
      const w = mmToPt(barcodeDisplayWmm);
      const h = mmToPt(barcodeDisplayHmm);
      const x = marginL + contentW - w;
      const y = metaY - 6 - h;
      page.drawImage(barcodePng, { x, y, width: w, height: h });
      metaY = y - 4;
    }
  }
  cursorY = Math.min(cursorY - 50, metaY - 8);
  return cursorY;
}

function drawBillTo(page, ctx) {
  const { cursorY, marginL, contentW, helv, helvBold, accent, ink, muted, client } = ctx;
  let y = cursorY;
  if (client) {
    page.drawText('BILL TO', { x: marginL, y, size: 6.5, font: helvBold, color: accent });
    y -= 10;
    page.drawText(client.name, { x: marginL, y, size: 10, font: helvBold, color: ink });
    y -= 11;
    if (client.email) {
      page.drawText(client.email, { x: marginL, y, size: 8, font: helv, color: muted });
      y -= 10;
    }
    if (client.address) {
      for (const line of client.address.split('\n')) {
        page.drawText(line, { x: marginL, y, size: 8, font: helv, color: muted });
        y -= 10;
      }
    }
  }
  return y - 6;
}

function drawLineTable(page, ctx) {
  const { cursorY, marginL, marginB, contentW, helv, helvBold, accent, ink, muted, rule, rgb, lines, currency, startIndex, template } = ctx;
  let y = cursorY;
  /* Header band. */
  page.drawRectangle({ x: marginL, y: y - 4, width: contentW, height: 18, color: rgb(0.96, 0.97, 0.94) });
  /* Column layout. Receipts drop the tax column, so we widen QTY and
     PRICE into the space. */
  const isReceipt = template && template.id === 'receipt';
  const colDescX = marginL;
  const colQtyX = marginL + contentW * (isReceipt ? 0.60 : 0.55);
  const colPriceX = marginL + contentW * (isReceipt ? 0.78 : 0.70);
  const colTaxX = marginL + contentW * 0.83;
  const colSubX = marginL + contentW;
  page.drawText('#', { x: colDescX + 4, y: y + 2, size: 7, font: helvBold, color: accent });
  page.drawText('DESCRIPTION', { x: colDescX + 18, y: y + 2, size: 7, font: helvBold, color: accent });
  page.drawText('QTY', { x: colQtyX, y: y + 2, size: 7, font: helvBold, color: accent });
  page.drawText('PRICE', { x: colPriceX, y: y + 2, size: 7, font: helvBold, color: accent });
  if (!isReceipt) {
    page.drawText('TAX', { x: colTaxX, y: y + 2, size: 7, font: helvBold, color: accent });
  }
  const subLabel = 'TOTAL';
  page.drawText(subLabel, { x: colSubX - 70, y: y + 2, size: 7, font: helvBold, color: accent });
  y -= 14;
  lines.forEach((line, i) => {
    const t = lineTotals(line);
    const idx = startIndex + i + 1;
    if (y < marginB + 120) return;
    page.drawText(String(idx), { x: colDescX + 4, y, size: 9, font: helv, color: muted });
    page.drawText(truncate(line.desc, 48), { x: colDescX + 18, y, size: 9, font: helv, color: ink });
    page.drawText(String(line.qty), { x: colQtyX, y, size: 9, font: helv, color: ink });
    page.drawText(formatMoney(line.price, currency), { x: colPriceX, y, size: 9, font: helv, color: ink });
    if (!isReceipt) {
      const tr = (line.taxRate === null || line.taxRate === undefined || line.taxRate === '') ? '' : `${line.taxRate}%`;
      page.drawText(tr, { x: colTaxX, y, size: 9, font: helv, color: muted });
    }
    page.drawText(formatMoney(t.gross2, currency), { x: colSubX - 70, y, size: 9, font: helvBold, color: ink });
    y -= 12;
    page.drawLine({ start: { x: marginL, y: y + 6 }, end: { x: marginL + contentW, y: y + 6 }, thickness: 0.4, color: rule });
  });
  return y;
}

function drawTotals(page, ctx) {
  const { cursorY, marginL, marginB, contentW, helv, helvBold, accent, ink, muted, rule, rgb, totals, form, template } = ctx;
  const totalsX = marginL + contentW * 0.55;
  const w = contentW * 0.45;
  let y = cursorY - 4;
  const isReceipt = template && template.id === 'receipt';
  drawTotalRow(page, helv, helvBold, totalsX, w, y, 'Subtotal', formatMoney(totals.linesNet, form.currency), ink, 9, false);
  if (totals.invoiceDiscount > 0) {
    y -= 12;
    const label = form.discountType === 'percent' ? `Invoice discount (${form.discountValue}%)` : 'Invoice discount';
    drawTotalRow(page, helv, helvBold, totalsX, w, y, label, `-${formatMoney(totals.invoiceDiscount, form.currency)}`, ink, 9, false);
  }
  if (!isReceipt) {
    y -= 12;
    drawTotalRow(page, helv, helvBold, totalsX, w, y, 'Subtotal after discount', formatMoney(totals.afterInvoiceDiscount, form.currency), ink, 9, false);
    y -= 12;
    drawTotalRow(page, helv, helvBold, totalsX, w, y, `Tax (${form.taxRate}%)`, formatMoney(totals.tax, form.currency), ink, 9, false);
  }
  y -= 6;
  page.drawLine({ start: { x: totalsX, y }, end: { x: marginL + contentW, y }, thickness: 0.5, color: accent });
  y -= 14;
  if (isReceipt) {
    /* Receipt: a single "Paid in full" grand line. Use the total as the
       paid amount (a receipt is, by definition, settled). */
    const label = form.paidDate ? `Paid in full (${form.paidDate})` : 'Paid in full';
    drawTotalRow(page, helv, helvBold, totalsX, w, y, label, formatMoney(totals.total, form.currency), accent, 12, true);
  } else {
    drawTotalRow(page, helv, helvBold, totalsX, w, y, 'Total due', formatMoney(totals.total, form.currency), accent, 12, true);
    if (form.baseCurrency) {
      y -= 14;
      const rate = Number(form.conversionRate) || 1;
      const converted = formatMoney(totals.total * rate, form.baseCurrency);
      drawTotalRow(page, helv, helvIt, totalsX, w, y, `≈ in ${form.baseCurrency}`, `≈ ${converted}`, muted, 9, false);
    }
    const paid = Number(form.paid) || 0;
    if (paid > 0) {
      y -= 10;
      page.drawLine({ start: { x: totalsX, y }, end: { x: marginL + contentW, y }, thickness: 0.4, color: rule });
      y -= 12;
      const label = `Paid${form.paidDate ? ` (${form.paidDate})` : ''}`;
      drawTotalRow(page, helv, helvBold, totalsX, w, y, label, `-${formatMoney(paid, form.currency)}`, ink, 9, false);
      y -= 14;
      const balance = totals.total - paid;
      drawTotalRow(page, helv, helvBold, totalsX, w, y, 'Balance due', formatMoney(balance, form.currency), balance > 0 ? accent : ink, 12, true);
    }
  }
  return y;
}

function drawNotes(page, ctx) {
  const { y, marginL, marginB, contentW, helv, accent, muted, rgb, text } = ctx;
  const notesY = Math.max(marginB + 70, y - 20);
  page.drawText('NOTES', { x: marginL, y: notesY + 18, size: 7, font: helv, color: accent });
  const lines = wrapText(text, helv, 8, contentW);
  let ny = notesY + 6;
  for (const line of lines) {
    if (ny < marginB) break;
    page.drawText(line, { x: marginL, y: ny, size: 8, font: helv, color: muted });
    ny -= 10;
  }
}

function drawTotalRow(page, helv, helvBold, x, w, y, label, value, color, size, bold) {
  page.drawText(label, { x, y, size, font: bold ? helvBold : helv, color });
  const valW = (bold ? helvBold : helv).widthOfTextAtSize(value, size);
  page.drawText(value, { x: x + w - valW, y, size, font: bold ? helvBold : helv, color });
}

function drawFooter(page, helv, helvBold, accent, muted, rgb, sheetW, marginL, marginB, contentW, template, info) {
  const cols = [];
  if (info.address) cols.push({ label: 'Address', value: info.address });
  if (info.phone) cols.push({ label: 'Phone', value: info.phone });
  if (info.email) cols.push({ label: 'Email', value: info.email });
  if (info.website) cols.push({ label: 'Web', value: info.website });
  if (!cols.length) return;
  const top = marginB + (template.id === 'minimal' ? 24 : 30);
  page.drawLine({ start: { x: marginL, y: top + 12 }, end: { x: marginL + contentW, y: top + 12 }, thickness: 0.4, color: rgb(0.83, 0.85, 0.81) });
  if (template.id === 'minimal') {
    /* Single-line footer. */
    const single = cols.map((c) => `${c.label}: ${c.value.replace(/\n/g, ', ')}`).join('   ·   ');
    page.drawText(truncate(single, 110), { x: marginL, y: top, size: 7.5, font: helv, color: muted });
    return;
  }
  const colW = contentW / cols.length;
  cols.forEach((col, i) => {
    const x = marginL + colW * i;
    page.drawText(col.label.toUpperCase(), { x, y: top, size: 6, font: helvBold, color: accent });
    const lines = col.value.split('\n');
    let ty = top - 8;
    for (const line of lines) {
      if (ty < marginB - 4) break;
      page.drawText(line, { x, y: ty, size: 7.5, font: helv, color: muted });
      ty -= 9;
    }
  });
}

function formatDate(iso) { if (!iso) return new Date().toISOString().slice(0, 10); return iso; }
function truncate(s, n) { if (!s) return ''; if (s.length <= n) return s; return s.slice(0, n - 1) + '...'; }
function wrapText(text, font, size, maxWidth) {
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/);
    let line = '';
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(trial, size) > maxWidth) {
        if (line) out.push(line);
        line = w;
      } else {
        line = trial;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
function mmToPt(mm) { return mm * 2.83465; }

/* Read a 4-byte big-endian unsigned int from a PNG buffer. The PNG
   IHDR chunk is at byte 16, with width at 16-19 and height at 20-23. */
function readPngDims(buf, offset) {
  return ((buf[16 + offset] << 24) | (buf[17 + offset] << 16) | (buf[18 + offset] << 8) | buf[19 + offset]) >>> 0;
}

/* Render the QR and barcode to PNG data URLs for the on-screen preview.
   Only the receipt template uses these, but we always keep them up to
   date so switching templates is instant. In Node / tests there's no
   canvas, so we just no-op. */
let lastCodeSig = '';
async function refreshCodeImgs() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const sig = `${state.form.qrPayload}|${state.form.barcodePayload}|${state.form.template}`;
  if (sig === lastCodeSig) return;
  lastCodeSig = sig;
  const { toCanvas } = await import('bwip-js/browser');
  if (state.form.qrPayload) {
    const canvas = document.createElement('canvas');
    try {
      toCanvas(canvas, {
        bcid: 'qrcode',
        text: state.form.qrPayload,
        scale: 6,
        height: 24, /* mm */
        includetext: false,
        paddingwidth: 0,
        paddingheight: 0,
      });
      state.codeImgs.qr = canvas.toDataURL('image/png');
    } catch (err) {
      state.codeImgs.qr = '';
    }
  } else {
    state.codeImgs.qr = '';
  }
  if (state.form.barcodePayload) {
    const canvas = document.createElement('canvas');
    try {
      toCanvas(canvas, {
        bcid: 'code128',
        text: state.form.barcodePayload,
        scale: 3,
        height: 14, /* mm */
        includetext: true,
        textxalign: 'center',
        textsize: 8,
      });
      state.codeImgs.barcode = canvas.toDataURL('image/png');
    } catch (err) {
      state.codeImgs.barcode = '';
    }
  } else {
    state.codeImgs.barcode = '';
  }
}
function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return { type: 'RGB', red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

/* ------------------------------------------------------------ preview ---- */
function paintPreview(root) {
  const target = q('#invPreview', root);
  if (!target) return;
  const setup = page();
  const sheet = sheetMm(setup);
  const margins = marginsMm(setup);
  const css = previewCss(sheet, margins);
  target.style.width = `${Math.min(720, sheet.width * 2.4)}px`;
  target.style.height = `${Math.min(1080, sheet.height * 2.4)}px`;
  target.innerHTML = `<style>${css}</style><div class="inv-page">${renderInvoiceHtml()}</div>`;
}

function previewCss(sheet, margins) {
  const px = (mm) => `${mm * 2.4}px`;
  const scope = '.inv-preview';
  const tpl = state.form.template;
  return `
    ${scope} .inv-page { width: ${px(sheet.width)}; height: ${px(sheet.height)}; padding: ${px(margins.top)} ${px(margins.right)} ${px(margins.bottom)} ${px(margins.left)}; box-sizing: border-box; background: #fff; color: #1f2c1e; font-family: 'Charter', 'Georgia', 'Times New Roman', serif; box-shadow: 0 6px 24px rgba(0,0,0,0.08); display: flex; flex-direction: column; font-size: 9pt; overflow: hidden; }
    ${scope} .inv-page.inv-template-modern { font-family: 'Charter', 'Georgia', serif; }
    ${scope} .inv-page.inv-template-minimal { font-family: 'Charter', 'Georgia', serif; }
    ${scope} .inv-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 12px; ${tpl === 'classic' ? `border-bottom: 2px solid ${state.identity.accent};` : tpl === 'modern' ? '' : 'border-bottom: 1px solid #d3d8ce;'} }
    ${scope} .inv-head-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
    ${scope} .inv-head-left img { ${tpl === 'minimal' ? 'max-height: 32px;' : 'max-height: 50px;'} max-width: 180px; object-fit: contain; }
    ${scope} .inv-head-meta { display: flex; flex-direction: column; }
    ${scope} .inv-head-meta strong { font-size: 13pt; color: ${state.identity.accent}; }
    ${scope} .inv-head-meta small { font-size: 8pt; color: #5d6a5b; font-style: italic; }
    ${scope} .inv-head-right { text-align: right; }
    ${scope} .inv-head-right .inv-title { font-size: ${tpl === 'modern' ? '28pt' : '22pt'}; font-weight: 700; color: ${state.identity.accent}; letter-spacing: 1px; }
    ${scope} .inv-head-right .inv-title-rule { height: 1.5px; background: ${state.identity.accent}; width: 60px; margin: 4px 0 0 auto; }
    ${scope} .inv-head-right .inv-meta { margin-top: 6px; font-size: 8pt; color: #4a554d; }
    ${scope} .inv-head-right .inv-meta b { color: #2c3a26; }
    ${scope} .inv-page-label { font-size: 8pt; color: #888; font-style: italic; margin-top: 2px; }
    ${scope} .inv-bill { margin: 14px 0 8px; }
    ${scope} .inv-bill .inv-label { font-size: 7pt; font-weight: 700; color: ${state.identity.accent}; letter-spacing: 0.8px; text-transform: uppercase; margin-bottom: 4px; }
    ${scope} .inv-bill strong { font-size: 10pt; color: #1f2c1e; }
    ${scope} .inv-bill div { font-size: 8pt; color: #5d6a5b; line-height: 1.45; }
    ${scope} .inv-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    ${scope} .inv-table th { text-align: left; font-size: 7pt; font-weight: 700; color: ${state.identity.accent}; text-transform: uppercase; letter-spacing: 0.5px; padding: 4px 6px; background: ${tpl === 'minimal' ? 'transparent' : '#f0f3ed'}; border-bottom: 1px solid #d3d8ce; }
    ${scope} .inv-table th.inv-num { text-align: right; }
    ${scope} .inv-table td { padding: 4px 6px; border-bottom: 0.5px solid #d3d8ce; font-size: 8.5pt; color: #1f2c1e; }
    ${scope} .inv-table td.inv-num { text-align: right; }
    ${scope} .inv-table td.inv-tax { color: #888; font-size: 8pt; }
    ${scope} .inv-totals { margin-top: 8px; align-self: flex-end; width: 55%; }
    ${scope} .inv-totals .inv-totals-row { display: flex; justify-content: space-between; padding: 2px 0; font-size: 9pt; color: #4a554d; }
    ${scope} .inv-totals .inv-totals-grand { font-size: 12pt; font-weight: 700; color: ${state.identity.accent}; border-top: 1.5px solid ${state.identity.accent}; padding-top: 6px; margin-top: 4px; }
    ${scope} .inv-totals .inv-totals-conversion { color: #888; font-style: italic; }
    ${scope} .inv-notes { margin-top: 12px; font-size: 7.5pt; color: #5d6a5b; line-height: 1.5; }
    ${scope} .inv-notes .inv-label { font-size: 7pt; font-weight: 700; color: ${state.identity.accent}; letter-spacing: 0.8px; text-transform: uppercase; margin-bottom: 4px; }
    ${scope} .inv-spacer { flex: 1; }
    ${scope} .inv-footer { display: flex; gap: 18px; padding-top: 8px; border-top: 1px solid #d3d8ce; color: #4a554d; font-size: 7pt; }
    ${scope} .inv-page.inv-template-minimal .inv-footer { border-top: 0.5px solid #d3d8ce; font-size: 7pt; color: #5d6a5b; }
    ${scope} .inv-footer > div { display: flex; flex-direction: column; }
    ${scope} .inv-footer .inv-label { color: ${state.identity.accent}; font-weight: 700; text-transform: uppercase; font-size: 6pt; letter-spacing: 0.6px; margin-bottom: 1px; }
    ${scope} .inv-code-qr { display: block; width: 22mm; height: 22mm; margin-top: 6px; align-self: flex-end; }
    ${scope} .inv-code-barcode { display: block; width: 50mm; height: 14mm; margin-top: 4px; align-self: flex-end; }
  `;
}

function renderInvoiceHtml() {
  const totals = computeTotals();
  const client = state.clients.find((c) => c.id === state.form.clientId);
  const isReceipt = state.form.template === 'receipt';
  const logoHtml = state.logo ? `<img src="${arrayBufferToBase64(state.logo.bytes, state.logo.type)}" alt="">` : '';
  const linesHtml = (state.lines || []).filter((l) => l.desc).map((l, i) => {
    const t = lineTotals(l);
    const tr = (l.taxRate === null || l.taxRate === undefined || l.taxRate === '') ? '' : `${l.taxRate}%`;
    return `<tr>
      <td class="inv-num">${i + 1}</td>
      <td>${escapeHtml(l.desc)}</td>
      <td class="inv-num">${l.qty}</td>
      <td class="inv-num">${formatMoney(l.price, state.form.currency)}</td>
      ${isReceipt ? '' : `<td class="inv-tax">${tr}</td>`}
      <td class="inv-num"><b>${formatMoney(t.gross2, state.form.currency)}</b></td>
    </tr>`;
  }).join('');
  const issueDate = state.form.issueDate || new Date().toISOString().slice(0, 10);
  const dueDate = state.form.dueDate || '';
  const paid = Number(state.form.paid) || 0;
  const balance = totals.total - paid;
  const conversion = state.form.baseCurrency ? `≈ ${formatMoney(totals.total * (Number(state.form.conversionRate) || 1), state.form.baseCurrency)}` : '';
  /* Receipt-only: stack the QR (top, ~22mm square) and the barcode
     (below, ~50mm wide × 14mm tall) in the head-right column, beneath
     the meta block. */
  const codeHtml = isReceipt ? `
    ${state.codeImgs.qr ? `<img class="inv-code-qr" src="${state.codeImgs.qr}" alt="QR code">` : ''}
    ${state.codeImgs.barcode ? `<img class="inv-code-barcode" src="${state.codeImgs.barcode}" alt="Barcode">` : ''}
  ` : '';
  const titleText = isReceipt ? 'RECEIPT' : 'INVOICE';
  const dueMetaHtml = isReceipt
    ? (state.form.paidDate ? `<div><b>Paid</b> ${escapeHtml(state.form.paidDate)}</div>` : '')
    : (dueDate ? `<div><b>Due</b> ${escapeHtml(dueDate)}</div>` : '');
  return `
    <div class="inv-head">
      <div class="inv-head-left">
        ${logoHtml}
        <div class="inv-head-meta">
          <strong>${escapeHtml(state.identity.companyName || 'Your company')}</strong>
          ${state.identity.tagline ? `<small>${escapeHtml(state.identity.tagline)}</small>` : ''}
        </div>
      </div>
      <div class="inv-head-right">
        <div class="inv-title">${titleText}${state.form.template === 'modern' ? '<div class="inv-title-rule"></div>' : ''}</div>
        <div class="inv-meta">
          <div><b>#</b> ${escapeHtml(state.form.number)}</div>
          <div><b>Issued</b> ${escapeHtml(issueDate)}</div>
          ${dueMetaHtml}
        </div>
        ${codeHtml}
      </div>
    </div>
    ${client ? `
      <div class="inv-bill">
        <div class="inv-label">${isReceipt ? 'Received from' : 'Bill to'}</div>
        <strong>${escapeHtml(client.name)}</strong>
        ${client.email ? `<div>${escapeHtml(client.email)}</div>` : ''}
        ${client.address ? `<div>${escapeHtml(client.address).replace(/\n/g, '<br>')}</div>` : ''}
      </div>
    ` : ''}
    <table class="inv-table">
      <thead>
        <tr>
          <th class="inv-num">#</th>
          <th>Description</th>
          <th class="inv-num">Qty</th>
          <th class="inv-num">Price</th>
          ${isReceipt ? '' : '<th>Tax</th>'}
          <th class="inv-num">Total</th>
        </tr>
      </thead>
      <tbody>${linesHtml || `<tr><td colspan="${isReceipt ? 5 : 6}" style="color:#aaa; text-align:center;">No line items yet</td></tr>`}</tbody>
    </table>
    <div class="inv-spacer"></div>
    <div class="inv-totals">
      <div class="inv-totals-row"><span>Subtotal${isReceipt ? '' : ' (after line discounts)'}</span><span>${formatMoney(totals.linesNet, state.form.currency)}</span></div>
      ${totals.invoiceDiscount > 0 ? `<div class="inv-totals-row"><span>Invoice discount${state.form.discountType === 'percent' ? ` (${state.form.discountValue}%)` : ''}</span><span>-${formatMoney(totals.invoiceDiscount, state.form.currency)}</span></div>` : ''}
      ${isReceipt ? '' : `
        <div class="inv-totals-row"><span>Subtotal after discount</span><span>${formatMoney(totals.afterInvoiceDiscount, state.form.currency)}</span></div>
        <div class="inv-totals-row"><span>Tax (${state.form.taxRate}%)</span><span>${formatMoney(totals.tax, state.form.currency)}</span></div>
      `}
      ${isReceipt
        ? `<div class="inv-totals-row inv-totals-grand"><span>${state.form.paidDate ? `Paid in full (${escapeHtml(state.form.paidDate)})` : 'Paid in full'}</span><span>${formatMoney(totals.total, state.form.currency)}</span></div>`
        : `<div class="inv-totals-row inv-totals-grand"><span>Total due</span><span>${formatMoney(totals.total, state.form.currency)}</span></div>
      ${conversion ? `<div class="inv-totals-row inv-totals-conversion"><span>≈ in ${escapeHtml(state.form.baseCurrency)}</span><span>${escapeHtml(conversion)}</span></div>` : ''}
      ${paid > 0 ? `
        <div class="inv-totals-row"><span>Paid${state.form.paidDate ? ` (${escapeHtml(state.form.paidDate)})` : ''}</span><span>-${formatMoney(paid, state.form.currency)}</span></div>
        <div class="inv-totals-row inv-totals-grand"><span>Balance due</span><span>${formatMoney(balance, state.form.currency)}</span></div>
      ` : ''}
      `}
    </div>
    ${state.form.notes ? `<div class="inv-notes"><div class="inv-label">Notes</div>${escapeHtml(state.form.notes).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="inv-footer">
      ${state.identity.address ? `<div><span class="inv-label">Address</span><span>${escapeHtml(state.identity.address).replace(/\n/g, ' · ')}</span></div>` : ''}
      ${state.identity.phone ? `<div><span class="inv-label">Phone</span><span>${escapeHtml(state.identity.phone)}</span></div>` : ''}
      ${state.identity.email ? `<div><span class="inv-label">Email</span><span>${escapeHtml(state.identity.email)}</span></div>` : ''}
      ${state.identity.website ? `<div><span class="inv-label">Web</span><span>${escapeHtml(state.identity.website)}</span></div>` : ''}
    </div>
  `;
}

function arrayBufferToBase64(bytes, mime) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/* ------------------------------------------------------------------ busy -- */
async function withBusy(root, buttonId, label, work) {
  const button = q(buttonId, root);
  if (!button) return work();
  const previous = button.disabled;
  button.disabled = true;
  const original = button.innerHTML;
  button.innerHTML = `<span class="busy-dot"></span><span>${label}</span>`;
  state.busy = true;
  try {
    return await work();
  } finally {
    state.busy = false;
    button.disabled = previous;
    button.innerHTML = original;
  }
}

/* Test-only helpers — let tests mutate state without going through the
   input events (so the test can set up a known currency and then verify
   paintForm picks the right option). */
function setState(patch) {
  if (!patch) return;
  for (const k of Object.keys(patch)) state.form[k] = patch[k];
}
function getState() { return state; }

/* Test-only handle. */
export const __test = {
  state,
  layout,
  paintForm,
  paintLines,
  paintTotals,
  paintPreview,
  paintClients,
  paintTemplates,
  wireForm,
  formatMoney,
  setState,
  getState,
  exportInvoice,
  lineTotals,
  computeTotals,
  lineDiscountAmount,
  invoiceDiscountAmount,
  conversionLine,
  CURRENCIES,
  CURRENCY_SYMBOLS,
  TEMPLATES,
  readPngDims,
};
