/* Invoices — build a one-page PDF invoice from a few fields and a
   list of line items. The "from" side reuses the same company
   identity the Letterhead tab keeps (saved under letterhead:v1), so
   the user does not have to retype their company name, address,
   logo, or accent. Clients are saved in a separate store. */

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
  issueDate: '', /* YYYY-MM-DD; empty = today at export */
  dueDate: '',
  currency: '£',
  taxRate: 20, /* percent */
  notes: 'Payment due within 30 days. Bank details on request.',
  saveName: 'folio-invoice',
  clientId: '', /* id of selected saved client */
};

const blankClient = {
  id: '',
  name: '',
  email: '',
  address: '',
};

const identityStore = store('letterhead:v1', identityDefaults);
const prefsStore = store('invoice:v1', invoiceDefaults);
const clientsStore = store('invoice-clients:v1', []);

const state = {
  identity: { ...identityDefaults, ...identityStore.read() },
  form: { ...invoiceDefaults, ...prefsStore.read() },
  clients: Array.isArray(clientsStore.read()) ? clientsStore.read() : [],
  clientDraft: { ...blankClient }, /* the client being edited in the side panel */
  editingClientId: '', /* '' = new */
  logo: null, /* { bytes, type, width, height } — loaded from the same image picker as Letterhead */
  busy: false,
};

function save() {
  prefsStore.write(state.form);
}
function saveClients() {
  clientsStore.write(state.clients);
}

/* Generate a short id for a new client. */
function newId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function start(root) {
  root.innerHTML = layout();
  wireForm(root);
  wireLogo(root);
  wireExport(root);
  wireClients(root);
  paintForm(root);
  paintClients(root);
  paintLines(root);
  paintTotals(root);
  paintPreview(root);
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
          <input class="text-input" id="invCurrency" type="text" value="${escapeHtml(form.currency)}" maxlength="3" />
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
      <label class="field"><span class="field-label">Tax rate (%)</span>
        <div class="range-row">
          <input class="range-input" id="invTaxRate" type="range" min="0" max="30" step="0.5" value="${form.taxRate}" />
          <output class="range-readout" id="invTaxRateOut">${form.taxRate}%</output>
        </div>
      </label>
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
        <button class="button button-light" type="button" id="invAddLine">+ Add line</button>
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
  q('#invCurrency', root).value = state.form.currency;
  q('#invIssueDate', root).value = state.form.issueDate;
  q('#invDueDate', root).value = state.form.dueDate;
  q('#invTaxRate', root).value = state.form.taxRate;
  q('#invTaxRateOut', root).textContent = `${state.form.taxRate}%`;
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
  /* Rebuild the action row so it reflects the current editing state. */
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

function paintLines(root) {
  const host = q('#invLines', root);
  if (!host) return;
  if (!state.lines || !state.lines.length) {
    state.lines = [blankLine()];
  }
  host.innerHTML = state.lines.map((line, i) => lineRowHtml(line, i)).join('');
  qa('.inv-line', host).forEach((row) => {
    const i = Number(row.dataset.idx);
    q('[data-field="desc"]', row)?.addEventListener('input', (e) => {
      state.lines[i].desc = e.target.value;
      onLineChange();
    });
    q('[data-field="qty"]', row)?.addEventListener('input', (e) => {
      state.lines[i].qty = Number(e.target.value || 0);
      onLineChange();
    });
    q('[data-field="price"]', row)?.addEventListener('input', (e) => {
      state.lines[i].price = Number(e.target.value || 0);
      onLineChange();
    });
    q('[data-field="remove"]', row)?.addEventListener('click', () => {
      state.lines.splice(i, 1);
      if (!state.lines.length) state.lines.push(blankLine());
      paintLines(root);
      onLineChange();
    });
  });
}

function blankLine() {
  return { desc: '', qty: 1, price: 0 };
}

function lineRowHtml(line, i) {
  const subtotal = (Number(line.qty) || 0) * (Number(line.price) || 0);
  return `
    <div class="inv-line" data-idx="${i}">
      <label class="field inv-line-desc"><span class="field-label">Description</span>
        <input class="text-input" data-field="desc" type="text" value="${escapeHtml(line.desc || '')}" placeholder="Design retainer, license, hours…" />
      </label>
      <label class="field inv-line-qty"><span class="field-label">Qty</span>
        <input class="text-input" data-field="qty" type="number" min="0" step="0.5" value="${line.qty}" />
      </label>
      <label class="field inv-line-price"><span class="field-label">Unit price</span>
        <input class="text-input" data-field="price" type="number" min="0" step="0.01" value="${line.price}" />
      </label>
      <div class="inv-line-sub"><span class="field-label">Subtotal</span>
        <output>${formatMoney(subtotal, state.form.currency)}</output>
      </div>
      <button class="button button-light inv-line-remove" data-field="remove" type="button" aria-label="Remove line">×</button>
    </div>`;
}

function paintTotals(root) {
  const host = q('#invTotals', root);
  if (!host) return;
  const totals = computeTotals();
  host.innerHTML = `
    <div class="inv-totals-row"><span>Subtotal</span><output>${formatMoney(totals.subtotal, state.form.currency)}</output></div>
    <div class="inv-totals-row"><span>Tax (${state.form.taxRate}%)</span><output>${formatMoney(totals.tax, state.form.currency)}</output></div>
    <div class="inv-totals-row inv-totals-grand"><span>Total</span><output>${formatMoney(totals.total, state.form.currency)}</output></div>
  `;
}

function computeTotals() {
  const subtotal = (state.lines || []).reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const tax = subtotal * (Number(state.form.taxRate) || 0) / 100;
  return { subtotal, tax, total: subtotal + tax };
}

function onLineChange() {
  /* Re-render the lines so subtotal readouts update, and totals. */
  const root = q('#invShell');
  if (!root) return;
  /* Update only the subtotal outputs and the totals block to avoid losing focus. */
  qa('.inv-line').forEach((row, i) => {
    const line = state.lines[i];
    if (!line) return;
    const out = row.querySelector('.inv-line-sub output');
    if (out) out.textContent = formatMoney((Number(line.qty) || 0) * (Number(line.price) || 0), state.form.currency);
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
    ['#invNumber', 'number', (v) => v],
    ['#invCurrency', 'currency', (v) => v],
    ['#invIssueDate', 'issueDate', (v) => v],
    ['#invDueDate', 'dueDate', (v) => v],
    ['#invNotes', 'notes', (v) => v],
    ['#invSaveName', 'saveName', (v) => v],
  ];
  for (const [sel, key, parse] of fields) {
    const el = q(sel, root);
    if (!el) continue;
    el.addEventListener('input', () => {
      state.form[key] = parse(el.value);
      save();
      paintPreview(root);
    });
  }
  const tax = q('#invTaxRate', root);
  if (tax) {
    tax.addEventListener('input', () => {
      state.form.taxRate = Number(tax.value || 0);
      q('#invTaxRateOut', root).textContent = `${state.form.taxRate}%`;
      save();
      paintTotals(root);
      paintPreview(root);
    });
  }
}

function wireLogo(root) {
  const button = q('#invPickLogo', root);
  const hint = q('#invLogoHint', root);
  const open = () => pickFiles({ accept: 'image/png,image/jpeg,.png,.jpg,.jpeg', multiple: false })
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
    });
  button?.addEventListener('click', open);
}

function wireExport(root) {
  q('#invExport', root)?.addEventListener('click', () => exportInvoice(root));
  q('#invAddLine', root)?.addEventListener('click', () => {
    state.lines = state.lines || [];
    state.lines.push(blankLine());
    paintLines(root);
    onLineChange();
  });
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
  /* Delegated clicks for save/delete/cancel since the buttons are rebuilt. */
  q('#invClientForm', root)?.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'invSaveClient') saveClient(root);
    else if (t.id === 'invDeleteClient') deleteClient(root);
    else if (t.id === 'invCancelEdit') cancelEdit(root);
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
  /* Minimal image dimension probe. We don't have a full image library
     in the bundle, so parse the IHDR for PNG and the SOFn marker for
     JPEG. Falls back to 200×200 if the file is anything else. */
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
    const page0 = out.addPage([sheetW, sheetH]);
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

    /* Header: logo + company on the left, INVOICE block on the right. */
    let cursorY = sheetH - marginT;
    let logoBoxH = 0;
    let logoBoxW = 0;
    if (state.logo) {
      const img = state.logo.type === 'image/png'
        ? await out.embedPng(state.logo.bytes)
        : await out.embedJpg(state.logo.bytes);
      const aspect = state.logo.width / state.logo.height;
      logoBoxH = Math.min(state.identity.logoSize, 36);
      logoBoxW = logoBoxH * aspect;
      page0.drawImage(img, { x: marginL, y: cursorY - logoBoxH, width: logoBoxW, height: logoBoxH });
    } else {
      /* Use the company name in display type instead. */
      const fallbackSize = 16;
      page0.drawText(state.identity.companyName, { x: marginL, y: cursorY - fallbackSize, size: fallbackSize, font: helvBold, color: accent });
      cursorY -= fallbackSize + 4;
    }
    const companyX = marginL + (logoBoxW || 0) + (state.logo ? 10 : 0);
    page0.drawText(state.identity.companyName, { x: companyX, y: cursorY - 9, size: 9, font: helvBold, color: ink });
    if (state.identity.tagline) {
      page0.drawText(state.identity.tagline, { x: companyX, y: cursorY - 20, size: 8, font: helvIt, color: muted });
    }
    const addrLines = (state.identity.address || '').split('\n');
    let addrY = cursorY - 31;
    for (const line of addrLines) {
      if (addrY < marginB) break;
      page0.drawText(line, { x: companyX, y: addrY, size: 7.5, font: helv, color: muted });
      addrY -= 9;
    }
    /* Right-side INVOICE block. */
    const rightX = marginL + contentW;
    const rightW = 160;
    const rightStartX = rightX - rightW;
    page0.drawText('INVOICE', { x: rightStartX, y: cursorY - 18, size: 22, font: helvBold, color: accent });
    const meta = [
      ['Invoice #', state.form.number],
      ['Issued', formatDate(state.form.issueDate)],
      ['Due', formatDate(state.form.dueDate)],
    ];
    let metaY = cursorY - 34;
    for (const [k, v] of meta) {
      if (!v) continue;
      page0.drawText(k.toUpperCase(), { x: rightStartX, y: metaY, size: 6.5, font: helvBold, color: accent });
      page0.drawText(String(v), { x: rightStartX + 40, y: metaY, size: 9, font: helv, color: ink });
      metaY -= 12;
    }
    /* Accent rule below the header. */
    cursorY = Math.min(cursorY - 40, addrY - 8);
    page0.drawRectangle({ x: marginL, y: cursorY, width: contentW, height: 1.5, color: accent });
    cursorY -= 14;

    /* Bill to. */
    const client = state.clients.find((c) => c.id === state.form.clientId);
    if (client) {
      page0.drawText('BILL TO', { x: marginL, y: cursorY, size: 6.5, font: helvBold, color: accent });
      cursorY -= 10;
      page0.drawText(client.name, { x: marginL, y: cursorY, size: 10, font: helvBold, color: ink });
      cursorY -= 11;
      if (client.email) {
        page0.drawText(client.email, { x: marginL, y: cursorY, size: 8, font: helv, color: muted });
        cursorY -= 10;
      }
      if (client.address) {
        for (const line of client.address.split('\n')) {
          if (cursorY < marginB + 100) break;
          page0.drawText(line, { x: marginL, y: cursorY, size: 8, font: helv, color: muted });
          cursorY -= 10;
        }
      }
      cursorY -= 6;
    }

    /* Line items table. */
    const tableTop = cursorY;
    const colDescX = marginL;
    const colQtyX = marginL + contentW * 0.62;
    const colPriceX = marginL + contentW * 0.78;
    const colSubX = marginL + contentW;
    page0.drawRectangle({ x: marginL, y: tableTop - 4, width: contentW, height: 18, color: rgb(0.96, 0.97, 0.94) });
    page0.drawText('DESCRIPTION', { x: colDescX + 6, y: tableTop + 2, size: 7, font: helvBold, color: accent });
    page0.drawText('QTY', { x: colQtyX, y: tableTop + 2, size: 7, font: helvBold, color: accent });
    page0.drawText('UNIT PRICE', { x: colPriceX, y: tableTop + 2, size: 7, font: helvBold, color: accent });
    page0.drawText('SUBTOTAL', { x: colSubX - 70, y: tableTop + 2, size: 7, font: helvBold, color: accent });
    let rowY = tableTop - 14;
    const visibleLines = (state.lines || []).filter((l) => l.desc);
    for (const line of visibleLines) {
      if (rowY < marginB + 120) break;
      page0.drawText(truncate(line.desc, 50), { x: colDescX + 6, y: rowY, size: 9, font: helv, color: ink });
      page0.drawText(String(line.qty), { x: colQtyX, y: rowY, size: 9, font: helv, color: ink });
      page0.drawText(formatMoney(line.price, state.form.currency), { x: colPriceX, y: rowY, size: 9, font: helv, color: ink });
      const sub = (Number(line.qty) || 0) * (Number(line.price) || 0);
      page0.drawText(formatMoney(sub, state.form.currency), { x: colSubX - 70, y: rowY, size: 9, font: helvBold, color: ink });
      rowY -= 14;
      page0.drawLine({ start: { x: marginL, y: rowY + 6 }, end: { x: marginL + contentW, y: rowY + 6 }, thickness: 0.4, color: rule });
    }

    /* Totals block on the right. */
    const totals = computeTotals();
    const totalsX = marginL + contentW * 0.62;
    let totY = rowY - 6;
    drawTotalRow(page0, helv, helvBold, totalsX, contentW * 0.38, totY, 'Subtotal', formatMoney(totals.subtotal, state.form.currency), ink, 9, false);
    totY -= 12;
    drawTotalRow(page0, helv, helvBold, totalsX, contentW * 0.38, totY, `Tax (${state.form.taxRate}%)`, formatMoney(totals.tax, state.form.currency), ink, 9, false);
    totY -= 4;
    page0.drawLine({ start: { x: totalsX, y: totY }, end: { x: marginL + contentW, y: totY }, thickness: 0.5, color: accent });
    totY -= 14;
    drawTotalRow(page0, helv, helvBold, totalsX, contentW * 0.38, totY, 'Total', formatMoney(totals.total, state.form.currency), accent, 12, true);

    /* Notes at the bottom. */
    if (state.form.notes) {
      const notesY = marginB + 50;
      page0.drawText('NOTES', { x: marginL, y: notesY + 30, size: 7, font: helvBold, color: accent });
      const noteLines = wrapText(state.form.notes, helv, 8, contentW);
      let ny = notesY + 18;
      for (const line of noteLines) {
        if (ny < marginB) break;
        page0.drawText(line, { x: marginL, y: ny, size: 8, font: helv, color: muted });
        ny -= 10;
      }
    }

    /* Footer columns. */
    drawFooter(page0, helv, helvBold, accent, muted, rgb, sheetW, marginL, marginB, contentW, {
      address: state.identity.address,
      phone: state.identity.phone,
      email: state.identity.email,
      website: state.identity.website,
    });

    const output = await out.save({ useObjectStreams: false });
    const stem = (state.form.saveName || 'folio-invoice').trim() || 'folio-invoice';
    const name = safeFileName(stem, 'pdf');
    downloadBlob(new Blob([output], { type: 'application/pdf' }), name);
    toast(`${name} is ready.`);
  });
}

function drawTotalRow(page, helv, helvBold, x, w, y, label, value, color, size, bold) {
  page.drawText(label, { x, y, size, font: bold ? helvBold : helv, color });
  const valW = (bold ? helvBold : helv).widthOfTextAtSize(value, size);
  page.drawText(value, { x: x + w - valW, y, size, font: bold ? helvBold : helv, color });
}

function drawFooter(page, helv, helvBold, accent, muted, rgb, sheetW, marginL, marginB, contentW, info) {
  const cols = [];
  if (info.address) cols.push({ label: 'Address', value: info.address });
  if (info.phone) cols.push({ label: 'Phone', value: info.phone });
  if (info.email) cols.push({ label: 'Email', value: info.email });
  if (info.website) cols.push({ label: 'Web', value: info.website });
  if (!cols.length) return;
  const top = marginB + 30;
  page.drawLine({ start: { x: marginL, y: top + 12 }, end: { x: marginL + contentW, y: top + 12 }, thickness: 0.4, color: rgb(0.83, 0.85, 0.81) });
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

function formatDate(iso) {
  if (!iso) return new Date().toISOString().slice(0, 10);
  return iso;
}

function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

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
  return `
    ${scope} .inv-page { width: ${px(sheet.width)}; height: ${px(sheet.height)}; padding: ${px(margins.top)} ${px(margins.right)} ${px(margins.bottom)} ${px(margins.left)}; box-sizing: border-box; background: #fff; color: #1f2c1e; font-family: 'Charter', 'Georgia', 'Times New Roman', serif; box-shadow: 0 6px 24px rgba(0,0,0,0.08); display: flex; flex-direction: column; font-size: 9pt; }
    ${scope} .inv-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 12px; border-bottom: 2px solid ${state.identity.accent}; }
    ${scope} .inv-head-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
    ${scope} .inv-head-left img { max-height: 50px; max-width: 180px; object-fit: contain; }
    ${scope} .inv-head-meta { display: flex; flex-direction: column; }
    ${scope} .inv-head-meta strong { font-size: 13pt; color: ${state.identity.accent}; }
    ${scope} .inv-head-meta small { font-size: 8pt; color: #5d6a5b; font-style: italic; }
    ${scope} .inv-head-right { text-align: right; }
    ${scope} .inv-head-right .inv-title { font-size: 22pt; font-weight: 700; color: ${state.identity.accent}; letter-spacing: 1px; }
    ${scope} .inv-head-right .inv-meta { margin-top: 6px; font-size: 8pt; color: #4a554d; }
    ${scope} .inv-head-right .inv-meta b { color: #2c3a26; }
    ${scope} .inv-bill { margin: 14px 0 8px; }
    ${scope} .inv-bill .inv-label { font-size: 7pt; font-weight: 700; color: ${state.identity.accent}; letter-spacing: 0.8px; text-transform: uppercase; margin-bottom: 4px; }
    ${scope} .inv-bill strong { font-size: 10pt; color: #1f2c1e; }
    ${scope} .inv-bill div { font-size: 8pt; color: #5d6a5b; line-height: 1.45; }
    ${scope} .inv-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    ${scope} .inv-table th { text-align: left; font-size: 7pt; font-weight: 700; color: ${state.identity.accent}; text-transform: uppercase; letter-spacing: 0.5px; padding: 4px 6px; background: #f0f3ed; border-bottom: 1px solid #d3d8ce; }
    ${scope} .inv-table th.inv-num { text-align: right; }
    ${scope} .inv-table td { padding: 4px 6px; border-bottom: 0.5px solid #d3d8ce; font-size: 8.5pt; color: #1f2c1e; }
    ${scope} .inv-table td.inv-num { text-align: right; }
    ${scope} .inv-totals { margin-top: 8px; align-self: flex-end; width: 50%; }
    ${scope} .inv-totals .inv-totals-row { display: flex; justify-content: space-between; padding: 2px 0; font-size: 9pt; color: #4a554d; }
    ${scope} .inv-totals .inv-totals-grand { font-size: 12pt; font-weight: 700; color: ${state.identity.accent}; border-top: 1.5px solid ${state.identity.accent}; padding-top: 6px; margin-top: 4px; }
    ${scope} .inv-notes { margin-top: 12px; font-size: 7.5pt; color: #5d6a5b; line-height: 1.5; }
    ${scope} .inv-notes .inv-label { font-size: 7pt; font-weight: 700; color: ${state.identity.accent}; letter-spacing: 0.8px; text-transform: uppercase; margin-bottom: 4px; }
    ${scope} .inv-spacer { flex: 1; }
    ${scope} .inv-footer { display: flex; gap: 18px; padding-top: 8px; border-top: 1px solid #d3d8ce; color: #4a554d; font-size: 7pt; }
    ${scope} .inv-footer > div { display: flex; flex-direction: column; }
    ${scope} .inv-footer .inv-label { color: ${state.identity.accent}; font-weight: 700; text-transform: uppercase; font-size: 6pt; letter-spacing: 0.6px; margin-bottom: 1px; }
  `;
}

function renderInvoiceHtml() {
  const totals = computeTotals();
  const client = state.clients.find((c) => c.id === state.form.clientId);
  const logoHtml = state.logo
    ? `<img src="${arrayBufferToBase64(state.logo.bytes, state.logo.type)}" alt="">`
    : '';
  const linesHtml = (state.lines || [])
    .filter((l) => l.desc)
    .map((l) => {
      const sub = (Number(l.qty) || 0) * (Number(l.price) || 0);
      return `<tr>
        <td>${escapeHtml(l.desc)}</td>
        <td class="inv-num">${l.qty}</td>
        <td class="inv-num">${formatMoney(l.price, state.form.currency)}</td>
        <td class="inv-num"><b>${formatMoney(sub, state.form.currency)}</b></td>
      </tr>`;
    }).join('');
  const issueDate = state.form.issueDate || new Date().toISOString().slice(0, 10);
  const dueDate = state.form.dueDate || '';
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
        <div class="inv-title">INVOICE</div>
        <div class="inv-meta">
          <div><b>#</b> ${escapeHtml(state.form.number)}</div>
          <div><b>Issued</b> ${escapeHtml(issueDate)}</div>
          ${dueDate ? `<div><b>Due</b> ${escapeHtml(dueDate)}</div>` : ''}
        </div>
      </div>
    </div>
    ${client ? `
      <div class="inv-bill">
        <div class="inv-label">Bill to</div>
        <strong>${escapeHtml(client.name)}</strong>
        ${client.email ? `<div>${escapeHtml(client.email)}</div>` : ''}
        ${client.address ? `<div>${escapeHtml(client.address).replace(/\n/g, '<br>')}</div>` : ''}
      </div>
    ` : ''}
    <table class="inv-table">
      <thead>
        <tr>
          <th>Description</th>
          <th class="inv-num">Qty</th>
          <th class="inv-num">Unit price</th>
          <th class="inv-num">Subtotal</th>
        </tr>
      </thead>
      <tbody>${linesHtml || '<tr><td colspan="4" style="color:#aaa; text-align:center;">No line items yet</td></tr>'}</tbody>
    </table>
    <div class="inv-spacer"></div>
    <div class="inv-totals">
      <div class="inv-totals-row"><span>Subtotal</span><span>${formatMoney(totals.subtotal, state.form.currency)}</span></div>
      <div class="inv-totals-row"><span>Tax (${state.form.taxRate}%)</span><span>${formatMoney(totals.tax, state.form.currency)}</span></div>
      <div class="inv-totals-row inv-totals-grand"><span>Total</span><span>${formatMoney(totals.total, state.form.currency)}</span></div>
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
  /* Build a base64 data URL for the preview image. */
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

/* Test-only handle: lets the jsdom test reach into the same module
   instance. Not part of the public API. */
export const __test = { state, paintLines, paintTotals, paintPreview, paintForm, paintClients };
