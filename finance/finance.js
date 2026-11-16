(function () {
'use strict';
/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) { if (kid == null || kid === false) continue; e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return e;
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = n => String(+Number(n).toFixed(3));
const fmtDate = iso => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
const trim = v => (v == null ? '' : String(v).trim());
let toastT;
function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, bad ? 6000 : 3200); }
function askConfirm(text, yes = 'Delete') {
  return new Promise(res => {
    const d = $('#cfDlg'); $('#cfText').textContent = text; $('#cfYes').textContent = yes;
    const done = v => { d.close(); res(v); $('#cfYes').onclick = $('#cfNo').onclick = null; };
    $('#cfYes').onclick = () => done(true); $('#cfNo').onclick = () => done(false); d.showModal();
  });
}
const CFG = window.ENERGIX || {};
const REMOTE = !!CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes('YOUR-PROJECT-REF') && !!CFG.SUPABASE_ANON_KEY;

/* ================= data model ================= */
const TABLES = ['customers', 'accounts', 'quotations', 'invoices', 'payments', 'drafts', 'assets'];
const COLS = {
  customers: ['id', 'title', 'name', 'company', 'address', 'mobile', 'email', 'created_at'],
  accounts: ['id', 'title', 'bank', 'branch_code', 'account_no', 'iban', 'branch_address', 'ntn', 'gst', 'pra', 'created_at'],
  quotations: ['id', 'quote_no', 'date', 'customer_id', 'types', 'project', 'notes', 'status', 'created_at'],
  invoices: ['id', 'adjustments', 'invoice_no', 'date', 'due_date', 'project', 'po_no', 'customer_id', 'account_id', 'quotation_id', 'customer_snapshot', 'account_snapshot', 'items', 'taxes', 'subtotal', 'tax_total', 'total', 'status', 'notes', 'words_style', 'show_sign', 'created_at'],
  payments: ['id', 'invoice_id', 'date', 'amount', 'method', 'reference', 'details', 'created_at'],
  drafts: ['id', 'data', 'created_at'],
  assets: ['id', 'data', 'created_at']
};
const db = { customers: [], accounts: [], quotations: [], invoices: [], payments: [], drafts: [], assets: [] };
const byId = (t, id) => db[t].find(r => r.id === id);
const pick = (t, row) => { const o = {}; COLS[t].forEach(c => { if (row[c] !== undefined) o[c] = row[c]; }); return o; };
function memUpsert(t, row) { const i = db[t].findIndex(r => r.id === row.id); if (i >= 0) db[t][i] = { ...db[t][i], ...row }; else db[t].push(row); }

/* ---- Local store (browser only) ---- */
const LKEY = 'energix_finance_v1';
const Local = {
  async load() { try { const j = JSON.parse(localStorage.getItem(LKEY) || '{}'); TABLES.forEach(t => { db[t] = Array.isArray(j[t]) ? j[t] : []; }); } catch { TABLES.forEach(t => { db[t] = []; }); } },
  persist() { try { localStorage.setItem(LKEY, JSON.stringify(db)); } catch { toast('Browser storage is full or blocked.', true); } },
  async saveMany(t, rows) { rows.forEach(r => memUpsert(t, r)); this.persist(); },
  async del(t, id) { db[t] = db[t].filter(r => r.id !== id); this.persist(); }
};

/* ---- Remote store (Supabase REST, signed-in user, protected by RLS) ---- */
const SKEY = 'energix_finance_session';
const getSession = () => { try { return JSON.parse(sessionStorage.getItem(SKEY) || 'null'); } catch { return null; } };
const setSession = j => { const s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: (j.user && j.user.email) || '' }; try { sessionStorage.setItem(SKEY, JSON.stringify(s)); } catch {} return s; };
const clearSession = () => { try { sessionStorage.removeItem(SKEY); } catch {} };
async function refreshSession() {
  const s = getSession(); if (!s) throw new Error('auth');
  const r = await fetch(CFG.SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: CFG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { clearSession(); throw new Error('auth'); }
  return setSession({ ...j, user: { email: s.email } });
}
async function rest(path, { method = 'GET', body, headers = {} } = {}) {
  let s = getSession(); if (!s) throw new Error('auth');
  if (s.expires_at - 30 < Date.now() / 1000) s = await refreshSession();
  const res = await fetch(CFG.SUPABASE_URL + path, { method, headers: { apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) { const t = await res.text().catch(() => ''); const e = new Error(res.status + ' ' + t.slice(0, 220)); e.status = res.status; throw e; }
  return res.status === 204 ? null : res.json().catch(() => null);
}
const Remote = {
  async load() {
    for (const t of TABLES) {
      try {
        let out = [], from = 0; const step = 1000;
        for (;;) {
          const rows = await rest(`/rest/v1/${t}?select=*&order=created_at.asc`, { headers: { Range: `${from}-${from + step - 1}`, 'Range-Unit': 'items' } });
          out = out.concat(rows || []); if (!rows || rows.length < step) break; from += step;
        }
        db[t] = out;
      } catch (e) { if (t === 'drafts' || t === 'assets') { db[t] = []; continue; } throw e; }
    }
  },
  async saveMany(t, rows) {
    if (!rows.length) return;
    await rest(`/rest/v1/${t}?on_conflict=id`, { method: 'POST', body: rows, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    rows.forEach(r => memUpsert(t, r));
  },
  async del(t, id) { await rest(`/rest/v1/${t}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); db[t] = db[t].filter(r => r.id !== id); }
};
const store = REMOTE ? Remote : Local;
async function save(t, row) { row = pick(t, row); if (!row.created_at) row.created_at = new Date().toISOString(); await store.saveMany(t, [row]); return row; }
async function remove(t, id) { await store.del(t, id); }

/* ================= domain helpers ================= */
const QTYPES = [
  { cat: 'Solar', opts: ['On Grid', 'Hybrid', 'Supply & Services', 'Services Only', 'Supply Only', 'Project Management'] },
  { cat: 'Electrical', opts: ['Services Only', 'Contracting', 'Supplies Only', 'Supply & Services', 'Project Management'] },
  { cat: 'Civil', opts: ['Construction', 'Services Only', 'Contracting', 'Supplies Only', 'Supervision', 'Supply & Services', 'Project Management', 'As Built', 'Design'] },
  { cat: 'IT', opts: ['CCTV', 'Services Only', 'Contracting', 'Supplies Only', 'Supervision', 'Supply & Services', 'Project Management', 'As Built', 'Design', 'Software'] }
];
const typesText = types => (types || []).map(t => t.cat + ': ' + t.opts.join(', ')).join(' | ');
const custLabel = c => c ? ([c.company, c.name].filter(Boolean).join(' · ') || '(unnamed)') : '';
function custLines(c) {
  if (!c) return [];
  const L = []; const add = (text, bold) => { if (trim(text)) L.push({ text: trim(text), bold: !!bold }); };
  add(c.company, true); if (trim(c.name)) add('Attn: ' + [trim(c.title), trim(c.name)].filter(Boolean).join(' ')); add(c.mobile); add(c.address); add(c.email); return L;
}
function accLines(a) {
  if (!a) return [];
  const rows = [['Account Title', a.title], ['Bank', a.bank], ['Branch Code', a.branch_code], ['Account No.', a.account_no], ['IBAN', a.iban], ['Branch Address', a.branch_address], ['NTN', a.ntn], ['GST', a.gst], ['PRA', a.pra]];
  return rows.filter(r => trim(r[1])).map(r => r[0] + ': ' + trim(r[1]));
}
function calc(items, taxes, adjs = []) {
  const its = items.map(i => ({ ...i, amount: round2(num(i.qty) * num(i.rate)) }));
  const subtotal = round2(its.reduce((s, i) => s + i.amount, 0));
  const tx = taxes.map(t => ({ ...t, amount: round2(subtotal * num(t.pct) / 100) }));
  const tax_total = round2(tx.reduce((s, t) => s + t.amount, 0));
  // adjustments: a discount (-) or addition (+), either a % of the items subtotal or a fixed PKR value
  const ad = adjs.map(a => ({ ...a, amount: round2((a.sign < 0 ? -1 : 1) * (a.mode === 'pct' ? subtotal * num(a.value) / 100 : num(a.value))) }));
  const adj_total = round2(ad.reduce((s, a) => s + a.amount, 0));
  return { items: its, taxes: tx, adjs: ad, subtotal, tax_total, adj_total, total: round2(subtotal + tax_total + adj_total) };
}
const isPendingChq = p => p.method === 'Cheque' && p.details && p.details.cleared === false;   // cheque recorded but bank clearing not confirmed yet
const paidOf = id => round2(db.payments.filter(p => p.invoice_id === id && !isPendingChq(p)).reduce((s, p) => s + num(p.amount), 0));
const pendingOf = id => round2(db.payments.filter(p => p.invoice_id === id && isPendingChq(p)).reduce((s, p) => s + num(p.amount), 0));
function stateOf(inv) {
  if (inv.status === 'cancelled') return 'Cancelled';
  if (inv.status === 'draft') return 'Draft';
  const bal = round2(num(inv.total) - paidOf(inv.id));
  if (bal <= 0.005) return 'Paid';
  if (paidOf(inv.id) > 0) return 'Partially paid';
  if (pendingOf(inv.id) > 0) return 'Cheque pending';
  if (inv.due_date && inv.due_date < today()) return 'Overdue';
  return 'Unpaid';
}
const pillClass = s => ({ 'Paid': 'paid', 'Partially paid': 'partial', 'Cheque pending': 'partial', 'Overdue': 'overdue', 'Unpaid': 'unpaid', 'Draft': 'draft', 'Cancelled': 'cancelled', 'Sent': 'sent', 'Accepted': 'accepted', 'Rejected': 'rejected' }[s] || '');
const CODES = { Solar: 'SOL', Electrical: 'ELEC', Civil: 'CIV', IT: 'IT' };
function codeFromTypes(types) {
  if (!types || !types.length) return 'INV';
  const t = types[0]; if (t.cat === 'IT' && t.opts.includes('CCTV')) return 'CCTV'; return CODES[t.cat] || 'INV';
}
function nextInvoiceNo(code, year) {
  let n = db.invoices.filter(i => String(i.invoice_no || '').startsWith(String(year))).length + 1;
  while (db.invoices.some(i => i.invoice_no === `${year}${code}${n}`)) n++;
  return `${year}${code}${n}`;
}
function nextQuoteNo(year) {
  let n = db.quotations.filter(q => String(q.quote_no || '').startsWith('Q-' + year)).length + 1;
  const f = k => 'Q-' + year + '-' + String(k).padStart(3, '0');
  while (db.quotations.some(q => q.quote_no === f(n))) n++;
  return f(n);
}

/* ================= form helpers ================= */
function fillForm(form, obj) { $$('[name]', form).forEach(el => { el.value = obj && obj[el.name] != null ? obj[el.name] : ''; }); }
function readForm(form) { const o = {}; $$('[name]', form).forEach(el => { o[el.name] = trim(el.value); }); return o; }
function setOptions(sel, items, labelFn, first) {
  const cur = sel.value; sel.replaceChildren(h('option', { value: '', text: first }));
  items.forEach(i => sel.append(h('option', { value: i.id, text: labelFn(i) }))); sel.value = items.some(i => i.id === cur) ? cur : '';
}
function table(el, head, rows, emptyText) {
  el.replaceChildren();
  if (!rows.length) { el.append(h('tbody', {}, h('tr', {}, h('td', { class: 'empty', colspan: head.length, text: emptyText })))); return; }
  el.append(h('thead', {}, h('tr', {}, head.map(c => h('th', { class: c.num ? 'num' : '', text: c.t })))), h('tbody', {}, rows));
}
const actBtn = (label, fn, cls) => h('button', { type: 'button', class: cls || '', onclick: fn, text: label });

/* ================= tabs ================= */
function showTab(name) {
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== name; });
  try { sessionStorage.setItem('energix_fin_tab', name); } catch {}
  if (name === 'invoices') { if ($('#iEditor').hidden) $('#invList').hidden = false; renderInvoices(); }
}
$$('.tabs button').forEach(b => b.addEventListener('click', async () => { if (anyDirty()) await flushAll(); showTab(b.dataset.tab); }));

/* ================= A. customers ================= */
$('#cForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, v = readForm(f);
  if (!v.name && !v.company) { toast('Enter a customer name or company.', true); return; }
  try {
    await save('customers', { ...v, id: v.id || uid() });
    fillForm(f, null); clearFormDraft('customer-form'); renderCustomers(); refreshSelects(); toast('Customer saved.');
  } catch (err) { fail(err); }
});
$('[data-reset="cForm"]').addEventListener('click', () => fillForm($('#cForm'), null));
$('#cSearch').addEventListener('input', renderCustomers);
function renderCustomers() {
  const q = trim($('#cSearch').value).toLowerCase();
  const rows = db.customers.filter(c => !q || [c.name, c.company, c.mobile, c.email, c.address].join(' ').toLowerCase().includes(q))
    .sort((a, b) => custLabel(a).localeCompare(custLabel(b)))
    .map(c => h('tr', {},
      h('td', {}, h('b', { text: c.company || c.name || '' }), c.company && c.name ? h('div', { class: 'muted small', text: c.name }) : null),
      h('td', { text: c.mobile || '' }), h('td', { text: c.email || '' }), h('td', { text: c.address || '' }),
      h('td', { class: 'acts' },
        actBtn('Edit', () => { fillForm($('#cForm'), c); window.scrollTo({ top: 0, behavior: 'smooth' }); }),
        actBtn('Invoice', () => newInvoice({ customer_id: c.id })),
        actBtn('Delete', async () => { if (await askConfirm('Delete this customer? Saved invoices keep their own copy of the details.')) { try { await remove('customers', c.id); renderCustomers(); refreshSelects(); } catch (err) { fail(err); } } }, 'del'))));
  table($('#cList'), [{ t: 'Customer' }, { t: 'Mobile' }, { t: 'Email' }, { t: 'Address' }, { t: '' }], rows, 'No customers yet. Add one on the left.');
}

/* ================= C. accounts ================= */
$('#aForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, v = readForm(f);
  if (!v.title && !v.bank && !v.account_no && !v.iban) { toast('Enter at least an account title, bank, account no. or IBAN.', true); return; }
  try { await save('accounts', { ...v, id: v.id || uid() }); fillForm(f, null); clearFormDraft('account-form'); renderAccounts(); refreshSelects(); toast('Account saved.'); } catch (err) { fail(err); }
});
$('[data-reset="aForm"]').addEventListener('click', () => fillForm($('#aForm'), null));
function renderAccounts() {
  const rows = db.accounts.map(a => h('tr', {},
    h('td', {}, h('b', { text: a.title || '' }), h('div', { class: 'muted small', text: [a.bank, a.branch_code && 'Branch ' + a.branch_code].filter(Boolean).join(' · ') })),
    h('td', { text: a.account_no || '' }), h('td', { text: a.iban || '' }),
    h('td', { text: [a.ntn && 'NTN ' + a.ntn, a.gst && 'GST ' + a.gst, a.pra && 'PRA ' + a.pra].filter(Boolean).join(' · ') }),
    h('td', { class: 'acts' },
      actBtn('Edit', () => { fillForm($('#aForm'), a); window.scrollTo({ top: 0, behavior: 'smooth' }); }),
      actBtn('Delete', async () => { if (await askConfirm('Delete this account? Saved invoices keep their own copy of the details.')) { try { await remove('accounts', a.id); renderAccounts(); refreshSelects(); } catch (err) { fail(err); } } }, 'del'))));
  table($('#aList'), [{ t: 'Account' }, { t: 'Account no.' }, { t: 'IBAN' }, { t: 'Tax IDs' }, { t: '' }], rows, 'No accounts yet. Add one on the left.');
}

/* ================= B. quotations ================= */
let qSel = {}, qCat = QTYPES[0].cat;
const selToTypes = () => QTYPES.filter(t => qSel[t.cat] && qSel[t.cat].size).map(t => ({ cat: t.cat, opts: t.opts.filter(o => qSel[t.cat].has(o)) }));
function typesToSel(types) { qSel = {}; (types || []).forEach(t => { qSel[t.cat] = new Set(t.opts); }); }
function renderQPicker() {
  $('#qCats').replaceChildren(...QTYPES.map(t => h('button', { type: 'button', class: 'chip' + (t.cat === qCat ? ' on' : '') + (qSel[t.cat] && qSel[t.cat].size ? ' sel' : ''), text: t.cat + (qSel[t.cat] && qSel[t.cat].size ? ' (' + qSel[t.cat].size + ')' : ''), onclick: () => { qCat = t.cat; renderQPicker(); } })));
  const cur = QTYPES.find(t => t.cat === qCat);
  $('#qOpts').replaceChildren(...cur.opts.map(o => h('button', { type: 'button', class: 'chip' + (qSel[qCat] && qSel[qCat].has(o) ? ' on' : ''), text: o, onclick: () => { qSel[qCat] = qSel[qCat] || new Set(); qSel[qCat].has(o) ? qSel[qCat].delete(o) : qSel[qCat].add(o); renderQPicker(); } })));
  const sum = [];
  selToTypes().forEach(t => t.opts.forEach(o => sum.push(h('span', { class: 'chip' }, t.cat + ' — ' + o, h('b', { title: 'Remove', onclick: () => { qSel[t.cat].delete(o); renderQPicker(); } }, '×')))));
  $('#qSummary').replaceChildren(...sum);
}
function clearQuote() { fillForm($('#qForm'), { date: today(), quote_no: nextQuoteNo(new Date().getFullYear()), status: 'Draft' }); qSel = {}; renderQPicker(); }
$('#qClear').addEventListener('click', clearQuote);
$('#qForm').addEventListener('submit', async e => {
  e.preventDefault(); const v = readForm(e.target);
  const types = selToTypes();
  if (!v.customer_id) { toast('Choose a customer.', true); return; }
  if (!types.length) { toast('Choose at least one quotation type option.', true); return; }
  try { await save('quotations', { ...v, id: v.id || uid(), customer_id: v.customer_id || null, types }); clearQuote(); clearFormDraft('quotation-form'); renderQuotations(); refreshSelects(); toast('Quotation saved.'); } catch (err) { fail(err); }
});
$('#qFilter').addEventListener('change', renderQuotations);
function renderQuotations() {
  const f = $('#qFilter').value;
  const rows = db.quotations.filter(q => !f || q.status === f).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.quote_no).localeCompare(String(a.quote_no)))
    .map(q => h('tr', {},
      h('td', {}, h('b', { text: q.quote_no || '' }), h('div', { class: 'muted small', text: fmtDate(q.date) })),
      h('td', { text: custLabel(byId('customers', q.customer_id)) }),
      h('td', {}, h('div', { text: q.project || '' }), h('div', { class: 'muted small', text: typesText(q.types) })),
      h('td', {}, h('span', { class: 'pill ' + pillClass(q.status), text: q.status || '' })),
      h('td', { class: 'acts' },
        actBtn('Edit', () => { fillForm($('#qForm'), q); typesToSel(q.types); qCat = (q.types && q.types[0] && q.types[0].cat) || QTYPES[0].cat; renderQPicker(); window.scrollTo({ top: 0, behavior: 'smooth' }); }),
        actBtn('Invoice', () => newInvoice({ quotation_id: q.id })),
        actBtn('Delete', async () => { if (await askConfirm('Delete this quotation?')) { try { await remove('quotations', q.id); renderQuotations(); refreshSelects(); } catch (err) { fail(err); } } }, 'del'))));
  table($('#qList'), [{ t: 'Quotation' }, { t: 'Customer' }, { t: 'Project / type' }, { t: 'Status' }, { t: '' }], rows, 'No quotations yet.');
}

/* ================= D. invoices: list + tracking ================= */
function renderInvoices() {
  const q = trim($('#iSearch').value).toLowerCase(), f = $('#iFilter').value;
  const all = db.invoices.map(i => ({ i, st: stateOf(i), paid: paidOf(i.id) }));
  const live = all.filter(x => x.st !== 'Draft' && x.st !== 'Cancelled');
  const invoiced = round2(live.reduce((s, x) => s + num(x.i.total), 0)), received = round2(live.reduce((s, x) => s + Math.min(x.paid, num(x.i.total)), 0));
  const overdue = live.filter(x => x.st === 'Overdue');
  $('#kpis').replaceChildren(
    h('div', { class: 'kpi' }, h('span', { text: 'Total invoiced (PKR)' }), h('b', { text: money(invoiced) })),
    h('div', { class: 'kpi' }, h('span', { text: 'Received (PKR)' }), h('b', { text: money(received) })),
    h('div', { class: 'kpi' }, h('span', { text: 'Outstanding (PKR)' }), h('b', { text: money(invoiced - received) })),
    h('div', { class: 'kpi' + (overdue.length ? ' warn' : '') }, h('span', { text: 'Overdue invoices' }), h('b', { text: overdue.length })));
  const ageDays = d => { const t = Date.parse(d); return isNaN(t) ? 0 : Math.max(0, Math.floor((Date.parse(today()) - t) / 86400000)); };
  const matches = all.filter(x => (!f || x.st === f) && (!q || [x.i.invoice_no, x.i.project, custLabel(byId('customers', x.i.customer_id)), (x.i.customer_snapshot || {}).company, (x.i.customer_snapshot || {}).name].join(' ').toLowerCase().includes(q)));
  const OUT = ['Unpaid', 'Overdue', 'Partially paid', 'Cheque pending'];
  const byNew = (a, b) => String(b.i.date).localeCompare(String(a.i.date)) || String(b.i.invoice_no).localeCompare(String(a.i.invoice_no));
  const byOld = (a, b) => String(a.i.date).localeCompare(String(b.i.date)) || String(a.i.invoice_no).localeCompare(String(b.i.invoice_no));
  const outstanding = matches.filter(x => OUT.includes(x.st)).sort(byOld);          // oldest (highest ageing) first
  const paidList = matches.filter(x => x.st === 'Paid').sort(byNew);
  const others = matches.filter(x => !OUT.includes(x.st) && x.st !== 'Paid').sort(byNew);
  const mkRow = ({ i, st, paid }) => {
    const cs = byId('customers', i.customer_id) || i.customer_snapshot, open = OUT.includes(st), age = ageDays(i.date);
    return h('tr', { class: open && st === 'Overdue' ? 'overduerow' : '' },
      h('td', {}, h('b', { text: i.invoice_no }), h('div', { class: 'muted small', text: fmtDate(i.date) + (i.due_date ? ' · due ' + fmtDate(i.due_date) : '') })),
      h('td', { text: custLabel(cs) }), h('td', { text: i.project || '' }),
      h('td', { class: 'num age' + (open && age > 60 ? ' old' : ''), text: open ? age + ' d' : '—' }),
      h('td', { class: 'num', text: money(i.total) }), h('td', { class: 'num', text: money(paid) }), h('td', { class: 'num', text: money(num(i.total) - paid) }),
      h('td', {}, h('button', { type: 'button', class: 'pill ' + pillClass(st), title: 'Click to preview / download this invoice', onclick: () => previewInvoice(i), text: st === 'Cheque pending' ? 'Cheque pending clearance' : st === 'Partially paid' ? 'Partially paid · ' + (Math.round(paid / Math.max(num(i.total), 0.01) * 1000) / 10) + '% received' : st })),
      h('td', { class: 'acts' }, actBtn('PDF', () => previewInvoice(i)), actBtn('Send', () => openSend(i)), actBtn('Payments', () => openPayments(i)), actBtn('Edit', () => editInvoice(i)),
        actBtn('Delete', async () => { if (await askConfirm('Delete invoice ' + i.invoice_no + ' and its payments?')) { try { for (const p of db.payments.filter(p => p.invoice_id === i.id)) await remove('payments', p.id); await remove('invoices', i.id); renderInvoices(); } catch (err) { fail(err); } } }, 'del')));
  };
  const sep = (cls, title, list, showBal) => h('tr', { class: 'sep ' + cls }, h('td', { colspan: 9 }, h('b', { text: title }), h('span', { text: ' · ' + list.length + (list.length === 1 ? ' invoice' : ' invoices') + (showBal ? ' · balance PKR ' + money(round2(list.reduce((a, x) => a + num(x.i.total) - x.paid, 0))) : '') })));
  const rows = [];
  if (outstanding.length) rows.push(sep('out', 'NOT YET PAID — oldest first (highest ageing on top)', outstanding, true), ...outstanding.map(mkRow));
  if (paidList.length) rows.push(sep('pd', 'PAID', paidList, false), ...paidList.map(mkRow));
  if (others.length) rows.push(sep('oth', 'DRAFTS & CANCELLED', others, false), ...others.map(mkRow));
  table($('#iTable'), [{ t: 'Invoice' }, { t: 'Customer' }, { t: 'Project' }, { t: 'Age', num: 1 }, { t: 'Total', num: 1 }, { t: 'Paid', num: 1 }, { t: 'Balance', num: 1 }, { t: 'Status' }, { t: '' }], rows, 'No invoices yet. Click “Create invoice”.');
}
$('#iSearch').addEventListener('input', renderInvoices); $('#iFilter').addEventListener('change', renderInvoices);
$('#csvBtn').addEventListener('click', () => {
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['Invoice #', 'Date', 'Due date', 'Customer', 'Project Name', 'Project Code', 'Subtotal', 'Tax', 'Total', 'Paid', 'Balance', 'Status'];
  const lines = [head.map(esc).join(',')].concat(db.invoices.map(i => { const p = paidOf(i.id); return [i.invoice_no, i.date, i.due_date, custLabel(byId('customers', i.customer_id) || i.customer_snapshot), i.project, i.po_no, i.subtotal, i.tax_total, i.total, p, round2(num(i.total) - p), stateOf(i)].map(esc).join(','); }));
  download(new Blob([lines.join('\r\n')], { type: 'text/csv' }), 'energix-invoices-' + today() + '.csv');
});
function download(blob, name) { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }

/* ---- payments ---- */
let payInv = null;
function openPayments(inv) { proofs = []; payTime = ''; payInv = inv; $('#payTitle').textContent = 'Payments · ' + inv.invoice_no; fillForm($('#payForm'), { date: today(), amount: '', method: 'Bank transfer', reference: '', sender: '', bank: '', account: '', clearing: '' }); renderPayments(); syncProofUI(); $('#payDlg').showModal(); }
function renderPayments() {
  const inv = payInv, paid = paidOf(inv.id), bal = round2(num(inv.total) - paid);
  $('#paySummary').replaceChildren(h('div', {}, 'Total ', h('b', { text: 'PKR ' + money(inv.total) })), h('div', {}, 'Paid ', h('b', { text: 'PKR ' + money(paid) })), h('div', {}, 'Balance ', h('b', { text: 'PKR ' + money(bal) })), ...(pendingOf(inv.id) > 0 ? [h('div', {}, 'Cheque pending clearance ', h('b', { text: 'PKR ' + money(pendingOf(inv.id)) }))] : []));
  $('#payForm').elements.amount.value = bal > 0 ? bal : '';
  const rows = db.payments.filter(p => p.invoice_id === inv.id).sort((a, b) => String(a.date).localeCompare(String(b.date))).map(p => h('tr', {}, h('td', { text: fmtDate(p.date) }), h('td', { text: p.method || '' }), h('td', { text: (p.reference || '') + (isPendingChq(p) ? ' · PENDING CLEARANCE' : (p.details && p.details.clearing ? ' · cleared ' + p.details.clearing : '')) }), h('td', { class: 'num', text: money(p.amount) }), h('td', { class: 'acts' }, isPendingChq(p) ? actBtn('Mark cleared', () => clearCheque(p)) : '', (p.method !== 'Cash' && !(p.details && (p.details.sender || p.details.bank || p.details.account))) ? actBtn('Read evidence', () => rereadProof(p)) : '', actBtn('Evidence', () => viewProofs(p)), actBtn('Delete', async () => { try { await remove('payments', p.id); Proof.dropLocal(p.id); renderPayments(); renderInvoices(); } catch (err) { fail(err); } }, 'del'))));
  table($('#payList'), [{ t: 'Date' }, { t: 'Method' }, { t: 'Reference' }, { t: 'Amount', num: 1 }, { t: '' }], rows, 'No payments recorded.');
}
$('#payForm').addEventListener('submit', async e => {
  e.preventDefault(); const v = readForm(e.target); const amt = round2(num(v.amount));
  if (amt <= 0) { toast('Enter a payment amount.', true); return; }
  if (ocrBusy) { toast('Still reading the pictures — one moment.', true); return; }
  const needProof = v.method !== 'Cash';
  if (needProof && !proofs.length && !await askConfirm('No receipt / cheque / payment picture has been added. Record this payment without evidence?')) return;
  try {
    const isChqPay = v.method === 'Cheque', cleared = !isChqPay || !!trim(v.clearing);
    if (isChqPay && !cleared && !await askConfirm('No clearing message or transaction ID has been added for this cheque. To avoid a bounced cheque being counted as payment, the invoice will stay "Cheque pending clearance" until you press "Mark cleared". Record it as pending?')) return;
    const details = needProof ? { sender: trim(v.sender), bank: trim(v.bank), account: trim(v.account), time: payTime, ...(isChqPay ? { cleared, clearing: trim(v.clearing) } : {}) } : null;
    const rec = await save('payments', { id: uid(), invoice_id: payInv.id, date: v.date || today(), amount: amt, method: v.method, reference: v.reference, details });
    if (needProof) for (const d of proofs) await Proof.add(rec.id, d);
    proofs = []; $('#payDlg').close(); renderInvoices(); toast(isChqPay && !cleared ? 'Cheque recorded — pending clearance.' : 'Payment recorded.');
  } catch (err) { fail(err); }
});
$('#payClose').addEventListener('click', () => $('#payDlg').close());


/* ================= payment evidence (pictures + reading the tracking number) ================= */
const PKEY = 'energix_finance_proofs';
const Proof = {
  async add(paymentId, data) {
    const row = { id: uid(), payment_id: paymentId, data, created_at: new Date().toISOString() };
    if (REMOTE) await rest('/rest/v1/payment_files?on_conflict=id', { method: 'POST', body: [row], headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    else { const a = this.local(); a.push(row); try { localStorage.setItem(PKEY, JSON.stringify(a)); } catch { toast('Browser storage is full or blocked.', true); } }
  },
  local() { try { return JSON.parse(localStorage.getItem(PKEY) || '[]'); } catch { return []; } },
  async list(paymentId) {
    if (REMOTE) return (await rest(`/rest/v1/payment_files?select=id,data&payment_id=eq.${encodeURIComponent(paymentId)}&order=created_at.asc`)) || [];
    return this.local().filter(r => r.payment_id === paymentId);
  },
  dropLocal(paymentId) { if (!REMOTE) try { localStorage.setItem(PKEY, JSON.stringify(this.local().filter(r => r.payment_id !== paymentId))); } catch {} }
};
let proofs = [], ocrBusy = false, ocrWorker = null;
function syncProofUI() {
  const need = $('#payForm').elements.method.value !== 'Cash';
  $('#payProof').hidden = !need; $('#chqNote').hidden = $('#payForm').elements.method.value !== 'Cheque';
  const box = $('#proofThumbs'); box.replaceChildren();
  proofs.forEach((d, i) => box.append(h('div', { class: 'th' }, h('img', { src: d, alt: 'Evidence ' + (i + 1) }), h('button', { type: 'button', title: 'Remove picture', text: '×', onclick: () => { proofs.splice(i, 1); syncProofUI(); } }))));
  if (!need) $('#proofStatus').textContent = '';
}
$('#payForm').elements.method.addEventListener('change', syncProofUI);
$('#proofCam').addEventListener('click', () => $('#proofCamIn').click());
$('#proofPick').addEventListener('click', () => $('#proofPickIn').click());
for (const id of ['#proofCamIn', '#proofPickIn']) $(id).addEventListener('change', e => { const fl = [...e.target.files]; e.target.value = ''; addProofFiles(fl); });

/* orientation fix + downscale + tidy-up (auto contrast) + JPEG compression */
async function prepImage(file) {
  let bmp; try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(file); }
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * k)), hh = Math.max(1, Math.round(bmp.height * k));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = hh; const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, hh); cx.drawImage(bmp, 0, 0, w, hh); if (bmp.close) bmp.close();
  const im = cx.getImageData(0, 0, w, hh), px = im.data, hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) hist[(px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8]++;
  const tot = w * hh; let lo = 0, hi = 255, a = 0;
  for (; lo < 255; lo++) { a += hist[lo]; if (a > tot * 0.01) break; }
  a = 0; for (; hi > 0; hi--) { a += hist[hi]; if (a > tot * 0.01) break; }
  if (hi - lo > 40) { const sc = 255 / (hi - lo); for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) px[i + c] = Math.max(0, Math.min(255, (px[i + c] - lo) * sc)); cx.putImageData(im, 0, 0); }
  return cv;
}
async function getOcr() {
  if (ocrWorker) return ocrWorker;
  if (!window.Tesseract) await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'vendor/ocr/tesseract.min.js'; sc.onload = res; sc.onerror = () => rej(new Error('ocr-load')); document.head.append(sc); });
  const abs = p => new URL(p, location.href).href;
  ocrWorker = await Tesseract.createWorker('eng', 1, { workerPath: abs('vendor/ocr/worker.min.js'), corePath: abs('vendor/ocr/tesseract-core-simd-lstm.wasm.js'), langPath: abs('vendor/ocr'), workerBlobURL: false, cacheMethod: 'none' });
  return ocrWorker;
}
function parseProof(text) {
  let t = String(text || '').replace(/[ \t]+/g, ' ');
  const t0 = t, isClr0 = /\b(clear(?:ed|ing|ance)|realiz|realis|credited|deposited)/i.test(t0) && !/(a\/c\s*payee|or\s*bearer|rupees)/i.test(t0);
  if (isClr0) t = t.replace(/cheque\s*(?:no\.?|#|number)?\s*[:#\-]?\s*[A-Z0-9\-]{4,}/gi, ' ');   // in a clearing message the cheque number is not the transaction reference
  let ref = '';
  const m = t.match(/(?:\bTID\b|\bTRX\.?\s*ID\b|\bTXN\.?\s*(?:ID|NO\.?)?|Transaction\s*(?:ID|No\.?|#|Number)|Tracking\s*(?:ID|No\.?|#|Number)|Reference\s*(?:ID|No\.?|#|Number|Num)?|\bRef\.?\s*(?:ID|No\.?|#|Number|Num)?|Cheque\s*(?:No\.?|#|Number)|\bCHQ\.?\s*(?:No\.?|#)?|Receipt\s*(?:No\.?|#|Number)|Auth(?:orization)?\s*(?:Code|ID)|Stan|RRN)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-]{5,24})/i);
  if (m) ref = m[1];
  if (!ref) { const d = t.match(/\b\d{8,20}\b/g); if (d) ref = d.sort((x, y) => y.length - x.length)[0]; }
  let amount = 0;
  const am = [...t.matchAll(/(?:PKR|Rs\.?|Amount|Total)\s*[:\-]?\s*(?:PKR|Rs\.?)?\s*([\d][\d,]*(?:\.\d{1,2})?)/gi)].map(x => num(x[1].replace(/,/g, ''))).filter(x => x > 0);
  if (am.length) amount = Math.max(...am);
  // sender, bank / app, account number, date
  const lines = String(text || '').split(/\n/).map(x => x.trim()).filter(Boolean);
  const isLabel = x => /^(name|account\s*(number|no\.?|#|title)?|amount|fee|total|date|ref|transaction|charges|sent\s*(to|by)|paid\s*(by|via)|funding)\b/i.test(x);
  let sender = '', account = '', si = -1;
  for (let i = 0; i < lines.length && si < 0; i++) { const m = lines[i].match(/^(?:paid\s*by|sent\s*by|from|sender|remitter|payer|account\s*title)\s*[:\-]?\s*(.*)$/i); if (m) { si = i; sender = m[1].replace(/^name\s*[:\-]?\s*/i, '').trim(); } }
  if (si >= 0) {
    for (let k = si + 1; k < Math.min(lines.length, si + 6); k++) {
      const ln = lines[k], nm = ln.match(/^name\s*[:\-]?\s*(.+)$/i);
      if (!sender && nm) { sender = nm[1].trim(); continue; }
      if (!sender && !isLabel(ln) && /^[A-Za-z][A-Za-z .&'\-]{2,}$/.test(ln)) { sender = ln; continue; }
      const am = ln.match(/account\s*(?:number|no\.?|#)?\s*[:\-]?\s*([\d*xX\-]{4,})/i);
      if (!account && am) { account = am[1]; break; }
      if (!account && !/\s/.test(ln) && /\d{4}$/.test(ln) && ln.length >= 6 && !isLabel(ln)) { account = '****' + ln.slice(-4); break; }
    }
  }
  sender = sender.replace(/\s+/g, ' ').trim();
  const BANKS = ['Easypaisa', 'JazzCash', 'NayaPay', 'SadaPay', 'Raast', '1LINK', 'UPaisa', 'Zindigi', 'Konnect', 'Meezan', 'HBL', 'UBL', 'MCB', 'Allied Bank', 'Bank Alfalah', 'Alfalah', 'Askari', 'Faysal', 'Habib Metro', 'Soneri', 'Bank Islami', 'BankIslami', 'Dubai Islamic', 'JS Bank', 'Silk Bank', 'Standard Chartered', 'National Bank', 'Bank of Punjab', 'Samba', 'Summit Bank', 'Al Baraka', 'Telenor', 'Mobilink', 'Finja', 'Keenu'];
  let bank = ''; const lc = t.toLowerCase();
  for (const b of BANKS) if (lc.includes(b.toLowerCase())) { bank = b; break; }
  if (!bank) { const gm = t.match(/\b([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)? Bank(?: Limited| Ltd)?)\b/); if (gm) bank = gm[1]; }
  let date = ''; const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const dm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?[ \-]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?[ \-]+(20\d{2})\b/i);
  if (dm) date = dm[3] + '-' + String(MON.indexOf(dm[2].toLowerCase()) + 1).padStart(2, '0') + '-' + String(dm[1]).padStart(2, '0');
  const clearWords = /\b(clear(?:ed|ing|ance)|realiz|realis|credited|deposited|cheque\s*(?:has\s*been\s*)?processed)/i.test(t);
  const chqWords = /(a\/c\s*payee|pay\s.*(?:or\s*bearer|order)|rupees|\bchq\b|cheque\s*(?:no|#|number)|signature)/i.test(t);
  const kind = clearWords && !chqWords ? 'clearing' : (chqWords && !clearWords ? 'cheque' : (clearWords ? 'clearing' : 'other'));
  if (kind === 'cheque' && !ref) { const d6 = t.match(/\b\d{6,9}\b/); if (d6) ref = d6[0]; }
  const tm = t.match(/\b(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)\b/); const time = tm ? tm[1].replace(/\s+/g, ' ').toUpperCase() : '';
  return { ref, amount, sender, account, bank, date, time, kind };
}
let payTime = '';
const isChq = () => $('#payForm').elements.method.value === 'Cheque';
async function addProofFiles(files) {
  const imgs = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name)); if (!imgs.length) return;
  ocrBusy = true; const st = $('#proofStatus'); const btn = $('#payForm button[type=submit]'); btn.disabled = true;
  let found = null;
  try {
    for (let n = 0; n < imgs.length; n++) {
      st.textContent = 'Preparing picture ' + (n + 1) + ' of ' + imgs.length + '…';
      const cv = await prepImage(imgs[n]); proofs.push(cv.toDataURL('image/jpeg', 0.72)); syncProofUI();
      if (!found || !found.ref || !found.sender || isChq()) {
        st.textContent = 'Reading picture ' + (n + 1) + ' of ' + imgs.length + ' (first time can take a few seconds)…';
        try { const w = await getOcr(); const r = await w.recognize(cv); const p = parseProof(r.data.text); const o = found || {}; const asClr = p.kind === 'clearing' && isChq(); found = { clearing: o.clearing || (asClr ? p.ref : ''), ref: o.ref || (asClr ? '' : p.ref) || '', amount: o.amount || p.amount || 0, sender: o.sender || p.sender || '', account: o.account || p.account || '', bank: o.bank || p.bank || '', date: o.date || p.date || '', time: o.time || p.time || '' }; } catch (err) { console.warn('ocr', err); }
      }
    }
    const f = $('#payForm').elements, msgs = [];
    if (found && found.ref) { f.reference.value = found.ref; msgs.push('tracking / reference no. ' + found.ref); }
    else if (!trim(f.reference.value) || /not found/i.test(f.reference.value)) f.reference.value = 'Reference number not found';
    if (isChq() && !trim(f.clearing.value)) msgs.push('no clearing message found yet');
    if (found && found.amount && found.amount <= num(payInv.total) * 1.0001) { f.amount.value = found.amount; msgs.push('amount ' + money(found.amount)); }
    if (found && found.clearing) { f.clearing.value = found.clearing; msgs.push('clearing ref. ' + found.clearing); }
    if (found && found.sender) { f.sender.value = found.sender; msgs.push('from ' + found.sender); }
    if (found && found.bank) { f.bank.value = found.bank; msgs.push(found.bank); }
    if (found && found.account) { f.account.value = found.account; msgs.push('account ' + found.account); }
    if (found && found.date) f.date.value = found.date;
    payTime = (found && found.time) || payTime;
    st.textContent = msgs.length ? 'Read from picture: ' + msgs.join(', ') + '. Please check these before recording.' : 'Pictures added, but no tracking / reference number could be found — "Reference number not found" was entered. Type the number over it if you have it.';
  } catch (err) { console.error(err); st.textContent = 'Could not add that picture.'; }
  finally { ocrBusy = false; btn.disabled = false; }
}
async function rereadProof(p) {
  try {
    const rows = await Proof.list(p.id); if (!rows.length) { toast('No evidence pictures are saved with this payment. Delete it and record it again with the receipt.', true); return; }
    toast('Reading the saved pictures…'); const w = await getOcr(); let f = {};
    for (const r of rows) { const q = parseProof((await w.recognize(r.data)).data.text); f = { ref: f.ref || q.ref, sender: f.sender || q.sender, account: f.account || q.account, bank: f.bank || q.bank, date: f.date || q.date, time: f.time || q.time }; }
    const det = { ...(p.details || {}), sender: f.sender || '', account: f.account || '', bank: f.bank || '', time: f.time || '' };
    const ref = (!trim(p.reference) || /not found/i.test(p.reference)) && f.ref ? f.ref : p.reference;
    await save('payments', { ...p, details: det, reference: ref, date: f.date || p.date });
    renderPayments(); renderInvoices(); toast(f.sender || f.account || f.bank || f.ref ? 'Details read from the evidence and saved.' : 'Could not read any details from the pictures.', !(f.sender || f.account || f.bank || f.ref));
  } catch (err) { fail(err); }
}
let clearFor = null;
function clearCheque(p) { clearFor = p; $('#clearIn').click(); }
$('#clearIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; const p = clearFor; if (!f || !p) return;
  try {
    toast('Reading the clearing message…'); const cv = await prepImage(f); let id = '';
    try { const w = await getOcr(); const r = await w.recognize(cv); id = parseProof(r.data.text).ref; } catch (err) { console.warn('ocr', err); }
    if (!await askConfirm('Mark this cheque as cleared?' + (id ? ' Clearing / transaction reference read from the picture: ' + id : ' No reference could be read from the picture.'))) return;
    await Proof.add(p.id, cv.toDataURL('image/jpeg', 0.72));
    await save('payments', { ...p, details: { ...(p.details || {}), cleared: true, clearing: id || (p.details && p.details.clearing) || '' } });
    renderPayments(); renderInvoices(); toast('Cheque marked as cleared.');
  } catch (err) { fail(err); }
});
async function viewProofs(p) {
  $('#proofTitle').textContent = 'Payment evidence · ' + fmtDate(p.date) + ' · PKR ' + money(p.amount) + (p.reference ? ' · ' + p.reference : '');
  const box = $('#proofView'); box.replaceChildren(h('div', { class: 'muted', text: 'Loading…' })); $('#proofDlg').showModal();
  try { const rows = await Proof.list(p.id); box.replaceChildren(...(rows.length ? rows.map(r => h('img', { src: r.data, alt: 'Payment evidence' })) : [h('div', { class: 'muted', text: 'No pictures were saved with this payment.' })])); }
  catch (err) { $('#proofDlg').close(); fail(err); }
}
$('#proofClose').addEventListener('click', () => $('#proofDlg').close());

/* ================= D. invoice editor ================= */
let ed = null, edDirty = false;
const KINDS = [['services', 'Services Only'], ['supply', 'Supply Only'], ['both', 'Supply & Services']];
const KIND_DEFAULT = { services: 'Services', supply: 'Supply', both: 'Supply & Services' };
const isJobKind = k => k === 'services' || k === 'both';
const UNITS = ['Pcs', 'Meters', 'Feet', 'Watt', 'Job'];
const legacyUnit = i => i.unit || (isJobKind(i.kind) ? 'Job' : (i.kind ? 'Pcs' : ''));
const isJob = u => u === 'Job';
function blankItem() { return { item: 'Services', description: '', kind: 'services', unit: 'Job', qty: 1, rate: '' }; }
function newInvoice(pre = {}) {
  showTab('invoices');
  const q = pre.quotation_id ? byId('quotations', pre.quotation_id) : null;
  const year = new Date().getFullYear();
  ed = { id: null, items: [blankItem()], taxes: [], adjs: [], custSnap: null, accSnap: null, created_at: null };
  openEditor('Create invoice');
  $('#iCustomer').value = pre.customer_id || (q && q.customer_id) || '';
  $('#iAccount').value = db.accounts.length === 1 ? db.accounts[0].id : '';
  $('#iQuote').value = q ? q.id : ''; $('#iProject').value = q ? q.project || '' : '';
  $('#iDate').value = today(); $('#iDue').value = ''; $('#iPO').value = ''; $('#iNotes').value = ''; $('#iStatus').value = 'draft'; $('#iWords').value = 'intl'; $('#iSign').checked = true;
  $('#iNo').value = nextInvoiceNo(codeFromTypes(q && q.types), year);
  renderEditorParts();
}
function editInvoice(inv) {
  showTab('invoices');
  ed = { id: inv.id, items: (inv.items || []).map(i => ({ item: i.item, description: i.description, kind: i.kind || 'supply', unit: legacyUnit(i) || 'Pcs', qty: i.qty, rate: i.rate })), taxes: (inv.taxes || []).map(t => ({ label: t.label, pct: t.pct })), adjs: (inv.adjustments || []).map(a => ({ label: a.label, mode: a.mode === 'pct' ? 'pct' : 'val', sign: a.sign < 0 ? -1 : 1, kind: a.kind, value: a.value })), custSnap: inv.customer_snapshot, accSnap: inv.account_snapshot, created_at: inv.created_at };
  if (!ed.items.length) ed.items = [blankItem()];
  openEditor('Edit invoice ' + inv.invoice_no);
  $('#iCustomer').value = inv.customer_id || ''; $('#iAccount').value = inv.account_id || ''; $('#iQuote').value = inv.quotation_id || '';
  $('#iProject').value = inv.project || ''; $('#iDate').value = inv.date || today(); $('#iDue').value = inv.due_date || ''; $('#iPO').value = inv.po_no || '';
  $('#iNo').value = inv.invoice_no; $('#iWords').value = inv.words_style === 'pk' ? 'pk' : 'intl'; $('#iSign').checked = inv.show_sign !== false; $('#iNotes').value = inv.notes || ''; $('#iStatus').value = inv.status || 'draft';
  renderEditorParts();
}
function openEditor(title) { edDirty = false; $('#iEdTitle').textContent = title; $('#invList').hidden = true; $('#iEditor').hidden = false; window.scrollTo({ top: 0 }); }
$('#newInv').addEventListener('click', () => newInvoice());
$('#iCancel').addEventListener('click', async () => { if (edDirty) await flushInvoiceDraft(); $('#iEditor').hidden = true; $('#invList').hidden = false; renderInvoices(); });
$('#addItem').addEventListener('click', () => { syncItems(); ed.items.push(blankItem()); renderItems(); });
$$('[data-tax]').forEach(b => b.addEventListener('click', () => { const [label, pct] = b.dataset.tax.split('|'); ed.taxes.push({ label, pct: +pct }); renderTaxes(); updTotals(); }));
$('#iCustomer').addEventListener('change', () => { ed.custSnap = null; renderPreviews(); });
$('#iAccount').addEventListener('change', () => { ed.accSnap = null; renderPreviews(); });
$('#iQuote').addEventListener('change', () => { const q = byId('quotations', $('#iQuote').value); if (!q) return; if (q.customer_id) { $('#iCustomer').value = q.customer_id; ed.custSnap = null; } if (!trim($('#iProject').value)) $('#iProject').value = q.project || ''; renderPreviews(); });
function renderEditorParts() { renderPreviews(); renderItems(); renderTaxes(); renderAdjs(); updTotals(); }
function curCust() { return byId('customers', $('#iCustomer').value) || (ed && ed.custSnap) || null; }
function curAcc() { return byId('accounts', $('#iAccount').value) || (ed && ed.accSnap) || null; }
function renderPreviews() {
  const c = curCust(), a = curAcc();
  $('#iCustPrev').textContent = c ? custLines(c).map(l => l.text).join('\n') : 'No customer selected.';
  $('#iAccPrev').textContent = a ? accLines(a).join('\n') : 'No account selected.';
}
function syncItems() {
  $$('#iItems tbody tr').forEach((tr, i) => { if (ed.items[i]) ed.items[i] = readRow(tr, ed.items[i]); });
}
function readRow(tr, prev) {
  const g = f => { const el = tr.querySelector('[data-f="' + f + '"]'); return el ? el.value : undefined; };
  const kind = g('kind') || prev.kind || 'supply', unit = g('unit') || prev.unit || 'Pcs';
  return { item: KIND_DEFAULT[kind] || 'Supply', description: g('description'), kind, unit, qty: isJob(unit) ? 1 : g('qty'), rate: g('rate') };
}
function startRowDrag(e, tr, from) {
  if (e.button > 0) return; e.preventDefault(); syncItems();
  const tb = tr.parentNode, rows = [...tb.children]; let to = from;
  tr.classList.add('dragging'); try { e.target.setPointerCapture(e.pointerId); } catch {}
  const mark = y => {
    rows.forEach(r => r.classList.remove('dropline', 'dropend')); to = rows.length;
    for (let k = 0; k < rows.length; k++) { const b = rows[k].getBoundingClientRect(); if (y < b.top + b.height / 2) { to = k; break; } }
    if (to < rows.length) rows[to].classList.add('dropline'); else rows[rows.length - 1].classList.add('dropend');
    const ed2 = tb.closest('.tablewrap'); if (ed2) { const r = ed2.getBoundingClientRect(); if (y < r.top + 30) window.scrollBy(0, -12); else if (y > r.bottom - 30) window.scrollBy(0, 12); }
  };
  const move = ev => mark(ev.clientY);
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    rows.forEach(r => r.classList.remove('dropline', 'dropend', 'dragging'));
    const dest = to > from ? to - 1 : to;
    if (dest !== from) { const [m] = ed.items.splice(from, 1); ed.items.splice(dest, 0, m); renderItems(); updTotals(); }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up); mark(e.clientY);
}
function renderItems() {
  const tb = $('#iItems tbody'); tb.replaceChildren();
  ed.items.forEach((it, i) => {
    const kind = it.kind || 'supply', unit = it.unit || 'Pcs';
    const amt = h('td', { class: 'amt', text: money(num(isJob(unit) ? 1 : it.qty) * num(it.rate)) });
    const on = () => { ed.items[i] = readRow(tr, ed.items[i]); amt.textContent = money(round2(num(ed.items[i].qty) * num(ed.items[i].rate))); updTotals(); };
    const sel = h('select', { 'data-f': 'kind', 'aria-label': 'Item type' }, ...KINDS.map(([v, t]) => h('option', { value: v, text: t })));
    sel.value = kind;
    sel.addEventListener('change', () => {
      const cur = readRow(tr, ed.items[i]); const nk = sel.value;
      const name = KIND_DEFAULT[nk];
      const nu = isJobKind(nk) ? 'Job' : (isJob(cur.unit) ? 'Pcs' : cur.unit);
      ed.items[i] = { ...cur, kind: nk, item: name, unit: nu, qty: isJob(nu) || isJob(cur.unit) ? 1 : cur.qty };
      renderItems(); updTotals();
    });
    const usel = h('select', { 'data-f': 'unit', 'aria-label': 'Unit' }, ...UNITS.map(u => h('option', { value: u, text: u })));
    usel.value = unit;
    usel.addEventListener('change', () => {
      const cur = readRow(tr, ed.items[i]); const nu = usel.value;
      ed.items[i] = { ...cur, unit: nu, qty: isJob(nu) || isJob(ed.items[i].unit) ? 1 : cur.qty };
      renderItems(); updTotals();
    });
    const qtyCell = isJob(unit)
      ? h('td', { class: 'num' }, h('span', { class: 'jobtag', text: '1' }), h('input', { type: 'hidden', 'data-f': 'qty', value: 1 }))
      : h('td', { class: 'num' }, h('input', { type: 'number', step: 'any', min: '0', value: it.qty, 'data-f': 'qty', oninput: on }));
    const grip = h('td', { class: 'dragh', title: 'Drag to move this row up or down', 'aria-label': 'Drag to reorder', text: '⋮⋮' });
    grip.addEventListener('pointerdown', e => startRowDrag(e, tr, i));
    const tr = h('tr', {},
      grip,
      h('td', {}, sel),
      h('td', {}, h('textarea', { rows: 2, maxlength: 800, spellcheck: 'true', lang: 'en', 'data-f': 'description', oninput: on, text: it.description })),
      h('td', {}, usel),
      qtyCell,
      h('td', { class: 'num' }, h('input', { type: 'number', step: 'any', min: '0', value: it.rate, 'data-f': 'rate', oninput: on })),
      amt,
      h('td', {}, h('button', { type: 'button', class: 'chip', title: 'Remove row', text: '×', onclick: () => { syncItems(); ed.items.splice(i, 1); if (!ed.items.length) ed.items.push(blankItem()); renderItems(); updTotals(); } })));
    tb.append(tr);
  });
}
function renderTaxes() {
  const box = $('#iTaxes'); box.replaceChildren();
  ed.taxes.forEach((t, i) => {
    const amt = h('div', { class: 'amt' });
    const row = h('div', { class: 'taxrow' },
      h('input', { value: t.label, maxlength: 60, oninput: e => { ed.taxes[i].label = e.target.value; } }),
      h('input', { type: 'number', step: 'any', min: '0', value: t.pct, oninput: e => { ed.taxes[i].pct = e.target.value; updTotals(); } }),
      amt, h('button', { type: 'button', title: 'Remove', text: '×', onclick: () => { ed.taxes.splice(i, 1); renderTaxes(); updTotals(); } }));
    row.dataset.i = i; box.append(row);
  });
}
const ADJ_KINDS = [['Discount', -1, '− Discount'], ['Deduction', -1, '− Deduction'], ['Adjustment', -1, '− Adjustment'], ['Addition', 1, '+ Addition'], ['Adjustment', 1, '+ Adjustment']];
const kindOf = a => a.kind || (a.sign < 0 ? 'Discount' : 'Addition');
const signed = n => (n < 0 ? '-' : n > 0 ? '+' : '') + money(Math.abs(n));
function renderAdjs() {
  const box = $('#iAdjs'); box.replaceChildren();
  (ed.adjs || []).forEach((a, i) => {
    const amt = h('div', { class: 'amt' });
    const sg = h('select', { 'aria-label': 'Adjustment type' }, ...ADJ_KINDS.map(([k, sn, tx]) => h('option', { value: k + '|' + sn, text: tx }))); sg.value = kindOf(a) + '|' + (a.sign < 0 ? -1 : 1);
    if (sg.value !== kindOf(a) + '|' + (a.sign < 0 ? -1 : 1)) sg.value = a.sign < 0 ? 'Discount|-1' : 'Addition|1';
    const md = h('select', { 'aria-label': 'Percentage or amount' }, h('option', { value: 'pct', text: '%' }), h('option', { value: 'val', text: 'PKR' })); md.value = a.mode === 'pct' ? 'pct' : 'val';
    sg.addEventListener('change', () => { const [k, sn] = sg.value.split('|'); ed.adjs[i].sign = +sn; ed.adjs[i].kind = k; updTotals(); }); md.addEventListener('change', () => { ed.adjs[i].mode = md.value; updTotals(); });
    box.append(h('div', { class: 'adjrow' },
      h('input', { value: a.label, maxlength: 60, placeholder: 'Description', oninput: e => { ed.adjs[i].label = e.target.value; } }), sg, md,
      h('input', { type: 'number', step: 'any', min: '0', value: a.value, oninput: e => { ed.adjs[i].value = e.target.value; updTotals(); } }),
      amt, h('button', { type: 'button', title: 'Remove', text: '×', onclick: () => { ed.adjs.splice(i, 1); renderAdjs(); updTotals(); } })));
  });
}
$$('[data-adj]').forEach(b => b.addEventListener('click', () => { const [label, sign, mode] = b.dataset.adj.split('|'); ed.adjs.push({ label, kind: label, sign: +sign, mode, value: '' }); renderAdjs(); updTotals(); }));
function updTotals() {
  const c = calc(ed.items, ed.taxes, ed.adjs || []);
  $$('#iAdjs .adjrow').forEach((r, i) => { r.querySelector('.amt').textContent = c.adjs[i] ? signed(c.adjs[i].amount) : '0.00'; });
  $$('#iTaxes .taxrow').forEach((r, i) => { r.querySelector('.amt').textContent = money(c.taxes[i] ? c.taxes[i].amount : 0); });
  $('#iTotals').replaceChildren(h('div', {}, h('span', { text: 'Subtotal' }), h('span', { text: money(c.subtotal) })),
    ...c.taxes.map(t => h('div', {}, h('span', { text: (t.label || 'Tax') + ' (' + fmtQty(num(t.pct)) + '%)' }), h('span', { text: money(t.amount) }))),
    ...c.adjs.filter(a => num(a.value) > 0).map(a => h('div', {}, h('span', { text: (trim(a.label) || kindOf(a)) + (a.mode === 'pct' ? ' (' + (a.sign < 0 ? '-' : '+') + fmtQty(num(a.value)) + '%)' : '') }), h('span', { text: signed(a.amount) }))),
    h('div', { class: 'grand' }, h('span', { text: 'Total' }), h('span', { text: 'PKR ' + money(c.total) })));
}
function collectInvoice(asDraft) {
  syncItems();
  const items = ed.items.filter(i => trim(i.description) || num(i.rate) > 0);
  const taxes = ed.taxes.filter(t => num(t.pct) > 0);
  const adjIn = (ed.adjs || []).filter(a => num(a.value) > 0).map(a => ({ label: trim(a.label) || kindOf(a), mode: a.mode === 'pct' ? 'pct' : 'val', sign: a.sign < 0 ? -1 : 1, kind: kindOf(a), value: num(a.value) }));
  const c = calc(items.map(i => ({ item: trim(i.item), description: String(i.description || '').replace(/\s+$/g, ''), kind: i.kind || 'supply', unit: i.unit || 'Pcs', qty: isJob(i.unit || 'Pcs') ? 1 : num(i.qty), rate: num(i.rate) })), taxes.map(t => ({ label: trim(t.label) || 'Tax', pct: num(t.pct) })), adjIn);
  const cust = curCust(), acc = curAcc(), v = id => trim($(id).value);
  if (!v('#iNo')) throw new Error('Enter an invoice number.');
  if (!v('#iDate')) throw new Error('Enter the invoice date.');
  if (!asDraft) {
    if (!cust) throw new Error('Choose the customer to invoice.');
    if (!c.items.length || c.total <= 0) throw new Error('Add at least one item with an amount.');
  }
  if (db.invoices.some(i => i.invoice_no === v('#iNo') && i.id !== ed.id)) throw new Error('Invoice number ' + v('#iNo') + ' already exists.');
  return {
    id: ed.id || uid(), invoice_no: v('#iNo'), date: v('#iDate'), due_date: v('#iDue') || null, project: v('#iProject'), po_no: v('#iPO'),
    customer_id: $('#iCustomer').value || null, account_id: $('#iAccount').value || null, quotation_id: $('#iQuote').value || null,
    customer_snapshot: cust ? pick('customers', cust) : null, account_snapshot: acc ? pick('accounts', acc) : null,
    items: c.items.map(i => ({ item: i.item, description: i.description, kind: i.kind, unit: i.unit, qty: i.qty, rate: i.rate, amount: i.amount })), taxes: c.taxes.map(t => ({ label: t.label, pct: t.pct, amount: t.amount })), adjustments: c.adjs.map(a => ({ label: a.label, mode: a.mode, sign: a.sign, kind: a.kind, value: a.value, amount: a.amount })),
    subtotal: c.subtotal, tax_total: c.tax_total, total: c.total, status: $('#iStatus').value, notes: trim($('#iNotes').value), words_style: $('#iWords').value === 'pk' ? 'pk' : 'intl', show_sign: $('#iSign').checked, created_at: ed.created_at || new Date().toISOString()
  };
}
$('#iSaveDraft').addEventListener('click', async () => {
  try { const inv = collectInvoice(true); await save('invoices', inv); ed.id = inv.id; ed.created_at = inv.created_at; $('#iEdTitle').textContent = 'Edit invoice ' + inv.invoice_no; toast('Invoice saved.'); } catch (err) { fail(err); }
});
$('#iEditor').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    let inv = collectInvoice(false);                       // validates first
    const issues = await spellIssues();
    if (issues.length) {
      const go = await showSpell(issues);
      renderItems(); updTotals();                          // show any corrections in the editor
      if (!go) return;
      inv = collectInvoice(false);
    }
    pvInv = inv; pvFromEditor = true; openPreview(inv);
  } catch (err) { fail(err); }
});

/* ================= total in words (international: Thousand / Million / Billion) ================= */
const W_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const W_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const w100 = n => n < 20 ? W_ONES[n] : W_TENS[Math.floor(n / 10)] + (n % 10 ? '-' + W_ONES[n % 10] : '');
const w1000 = n => { const h = Math.floor(n / 100), r = n % 100; return (h ? W_ONES[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? w100(r) : ''); };
function intWords(n) {
  if (n === 0) return 'Zero';
  const scales = [[1e12, 'Trillion'], [1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']], out = [];
  for (const [v, name] of scales) { const q = Math.floor(n / v); if (q) { out.push(w1000(q) + ' ' + name); n -= q * v; } }
  if (n) out.push(w1000(n));
  return out.join(' ');
}
function intWordsPk(n) {                       // Lakh / Crore grouping
  if (n === 0) return 'Zero';
  const out = []; const cr = Math.floor(n / 1e7); n -= cr * 1e7;
  const lk = Math.floor(n / 1e5); n -= lk * 1e5; const th = Math.floor(n / 1e3); n -= th * 1e3;
  if (cr) out.push(intWordsPk(cr) + ' Crore'); if (lk) out.push(w100(lk) + ' Lakh'); if (th) out.push(w100(th) + ' Thousand'); if (n) out.push(w1000(n));
  return out.join(' ');
}
function amountWords(total, style) {
  const cents = Math.round(num(total) * 100), rupees = Math.floor(cents / 100), paisa = cents % 100;
  if (rupees === 0 && paisa) return w100(paisa) + ' Paisa Only';
  return 'Rupees ' + (style === 'pk' ? intWordsPk(rupees) : intWords(rupees)) + (paisa ? ' and ' + w100(paisa) + ' Paisa' : '') + ' Only';
}

/* ================= spell check (descriptions + notes), runs when you press preview ================= */
let DICT = null, dictLoading = null;
function loadDict() {
  if (DICT) return Promise.resolve(DICT);
  dictLoading = dictLoading || fetch('/finance/vendor/en-words.txt?v=1').then(r => r.ok ? r.text() : Promise.reject(new Error('dict')))
    .then(t => { const arr = t.split('\n').filter(Boolean); DICT = { set: new Set(arr), rank: new Map(arr.map((w, i) => [w, i])) }; return DICT; }).catch(() => null);
  return dictLoading;
}
const UDKEY = 'energix_fin_dict';
const userDict = () => { try { return new Set(JSON.parse(localStorage.getItem(UDKEY) || '[]')); } catch { return new Set(); } };
const addUserWord = w => { const d = userDict(); d.add(w.toLowerCase()); try { localStorage.setItem(UDKEY, JSON.stringify([...d])); } catch {} };
function knownNames() {
  const out = new Set(), add = v => String(v || '').toLowerCase().match(/[a-z]+/g)?.forEach(w => out.add(w));
  db.customers.forEach(c => { add(c.name); add(c.company); add(c.address); }); db.accounts.forEach(a => { add(a.title); add(a.bank); add(a.branch_address); });
  add($('#iProject').value); return out;
}
function isWord(w, ok) {
  const l = w.toLowerCase(); if (DICT.set.has(l) || ok.has(l)) return true;
  const has = x => DICT.set.has(x) || ok.has(x);
  if (l.endsWith('s') && has(l.slice(0, -1))) return true;
  if (l.endsWith('es') && has(l.slice(0, -2))) return true;
  if (l.endsWith('ies') && has(l.slice(0, -3) + 'y')) return true;
  if (l.endsWith('ed') && (has(l.slice(0, -2)) || has(l.slice(0, -1)) || (l.length > 4 && l[l.length - 3] === l[l.length - 4] && has(l.slice(0, -3))))) return true;
  if (l.endsWith('ing') && (has(l.slice(0, -3)) || has(l.slice(0, -3) + 'e') || (l.length > 5 && l[l.length - 4] === l[l.length - 5] && has(l.slice(0, -4))))) return true;
  if (l.endsWith('ly') && has(l.slice(0, -2))) return true;
  if (l.endsWith('er') && (has(l.slice(0, -2)) || has(l.slice(0, -1)))) return true;
  return false;
}
const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
function edits1(w) {
  const out = new Map(), put = (x, t) => { if (!out.has(x) || out.get(x) > t) out.set(x, t); }, sp = [];
  for (let i = 0; i <= w.length; i++) sp.push([w.slice(0, i), w.slice(i)]);
  sp.forEach(([a, b]) => {
    if (b) put(a + b.slice(1), 1);                                  // typed an extra letter
    if (b.length > 1) put(a + b[1] + b[0] + b.slice(2), 0);         // swapped letters
    for (const c of ALPHA) { if (b) put(a + c + b.slice(1), 2); put(a + c + b, 0); }   // wrong / missing letter
  });
  return out;
}
function suggestFor(word) {
  const l = word.toLowerCase(), cands = new Map();
  const take = (map, pen) => map.forEach((t, x) => { if (DICT.set.has(x)) { const sc = t + pen; if (!cands.has(x) || cands.get(x).sc > sc) cands.set(x, { sc, r: DICT.rank.get(x) }); } });
  const e1 = edits1(l); take(e1, 0);
  if (cands.size < 3 && l.length <= 12) { let n = 0; for (const e of e1.keys()) { take(edits1(e), 5); if (++n > 700) break; } }
  const list = [...cands.entries()].sort((a, b) => (a[1].sc >= 5 ? 1 : 0) - (b[1].sc >= 5 ? 1 : 0) || ((a[1].sc === 0 ? 0 : 1) - (b[1].sc === 0 ? 0 : 1)) || a[1].r - b[1].r).map(x => x[0]).slice(0, 5);
  const cap = word[0] !== word[0].toLowerCase();
  return cap ? list.map(x => x[0].toUpperCase() + x.slice(1)) : list;
}
function findSpelling(text) {
  const ok = new Set([...userDict(), ...knownNames()]), found = [], re = /[A-Za-z][A-Za-z'’]*/g; let m;
  while ((m = re.exec(text))) {
    let w = m[0].replace(/['’]s$/i, '').replace(/['’]+$/, ''); if (w.length < 3) continue;
    if (/[A-Z]/.test(w.slice(1))) continue;                       // CCTV, UPS, kW, camelCase
    const before = text.slice(0, m.index), sentenceStart = !before.trim() || /[.!?:\n]\s*$/.test(before);
    if (/^[A-Z]/.test(w) && !sentenceStart) continue;             // names (Lahore, Wapda)
    if (/^[\d]/.test(text.slice(Math.max(0, m.index - 1), m.index)) ) continue;
    if (isWord(w, ok) || w.split("'").every(p => !p || isWord(p, ok))) continue;
    found.push({ word: w, index: m.index });
  }
  return found;
}
async function spellIssues() {
  if (!await loadDict()) return [];
  const issues = [], seen = new Set();
  const scan = (where, text, setter) => findSpelling(String(text || '')).forEach(f => {
    const key = where + '|' + f.word.toLowerCase(); if (seen.has(key)) return; seen.add(key);
    const a = Math.max(0, f.index - 28), b = Math.min(text.length, f.index + f.word.length + 28);
    issues.push({ where, word: f.word, ctx: (a ? '…' : '') + text.slice(a, f.index) + '\u0001' + f.word + '\u0002' + text.slice(f.index + f.word.length, b) + (b < text.length ? '…' : ''), sugg: suggestFor(f.word), setter, text: () => text });
  });
  ed.items.forEach((it, i) => { if (trim(it.description)) scan('Item ' + (i + 1) + ' description', it.description, (from, to) => { ed.items[i].description = ed.items[i].description.replace(new RegExp('\\b' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), to); }); });
  const notes = $('#iNotes').value; if (trim(notes)) scan('Notes', notes, (from, to) => { $('#iNotes').value = $('#iNotes').value.replace(new RegExp('\\b' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), to); });
  return issues;
}
function showSpell(issues) {
  return new Promise(res => {
    const d = $('#spDlg'), body = $('#spBody'); body.replaceChildren();
    body.append(h('p', { class: 'muted small', text: 'These words may be misspelled. Click a suggestion to fix it, or ignore it. Names, abbreviations and words you add to the dictionary are not flagged again.' }));
    let left = issues.length; const status = h('p', { class: 'small spstat' }); body.append(status);
    const upd = () => { status.textContent = left ? left + ' to review' : 'All reviewed.'; };
    issues.forEach(is => {
      const row = h('div', { class: 'sprow' });
      const done = msg => { row.classList.add('done'); row.replaceChildren(h('span', { class: 'small', text: msg })); left--; upd(); };
      const ctx = h('div', { class: 'spctx small muted' }); const [pre, rest] = is.ctx.split('\u0001'), [w, post] = rest.split('\u0002');
      ctx.append(pre, h('mark', { text: w }), post);
      const sug = h('div', { class: 'chips' });
      is.sugg.forEach(x => sug.append(h('button', { type: 'button', class: 'chip', text: x, onclick: () => { is.setter(is.word, x); done('"' + is.word + '" changed to "' + x + '".'); } })));
      if (!is.sugg.length) sug.append(h('span', { class: 'small muted', text: 'No suggestions.' }));
      row.append(h('div', {}, h('b', { text: is.word }), h('span', { class: 'small muted', text: '  ·  ' + is.where }), ctx), sug,
        h('div', { class: 'actions' }, actBtn('Ignore', () => done('"' + is.word + '" ignored.'), 'btn ghost sm'), actBtn('Add to dictionary', () => { addUserWord(is.word); done('"' + is.word + '" added to your dictionary.'); }, 'btn ghost sm')));
      body.append(row);
    }); upd();
    const finish = v => { d.close(); $('#spGo').onclick = $('#spClose').onclick = null; d.onclose = null; res(v); };
    $('#spGo').onclick = () => finish(true); $('#spClose').onclick = () => finish(false); d.onclose = () => res(false);
    d.showModal();
  });
}

/* ================= PDF layout (shared by preview + PDF) ================= */
let M = null, logoPromise = null;
const meas = () => { if (!M) M = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' }); return M; };
const safe = s => String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ').replace(/[^\x09\x0A\x20-\x7E¡-ÿ]/g, '?');
const tw = (s, f, st, sz) => { const m = meas(); m.setFont(f, st); m.setFontSize(sz); return m.getTextWidth(s); };
/* word-wrap that never splits a (bracketed phrase) across two lines: the whole bracket moves to the next line unless it is wider than the column */
const wrap = (s, w, f, st, sz) => {
  const m = meas(); m.setFont(f, st); m.setFontSize(sz);
  return safe(s).split('\n').flatMap(p => {
    if (p === '') return [''];
    const units = []; let depth = 0, cur = '';
    p.split(/ +/).forEach(wd => {
      cur = cur ? cur + '\u0001' + wd : wd;
      for (const ch of wd) { if (ch === '(' || ch === '[') depth++; else if ((ch === ')' || ch === ']') && depth > 0) depth--; }
      if (depth === 0) { units.push(cur); cur = ''; }
    });
    if (cur) units.push(cur);
    const out = []; let line = '';
    const W = u => m.getTextWidth(u.replace(/\u0001/g, ' '));
    units.forEach(u => {
      const t = line ? line + ' ' + u : u;
      if (W(t) <= w) { line = t; return; }
      if (line) { out.push(line); line = ''; }
      if (W(u) <= w) line = u;
      else { const parts = m.splitTextToSize(u.replace(/\u0001/g, ' '), w); parts.slice(0, -1).forEach(x => out.push(x)); line = parts[parts.length - 1] || ''; }
    });
    if (line) out.push(line);
    return out.map(x => x.replace(/\u0001/g, ' '));
  });
};
function loadLogo() {
  if (!logoPromise) logoPromise = fetch('/img/logo.png?v=2').then(r => r.blob()).then(b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); })).catch(() => null);
  return logoPromise;
}
const BORDER = 0.9, GREY = [232, 232, 232];
function paidLines(pays) {
  const d = p => p.details || {}, when = p => fmtDate(p.date) + (d(p).time ? ' at ' + d(p).time : '');
  if (pays.length === 1) { const p = pays[0], x = d(p), L = [];
    L.push('Date: ' + when(p));
    if (x.sender) L.push('Paid by: ' + x.sender);
    if (x.account) L.push('From account: ' + x.account);
    if (x.bank) L.push('Bank / channel: ' + x.bank); else if (p.method) L.push('Method: ' + p.method);
    if (p.reference) L.push((p.method === 'Cheque' ? 'Cheque no.: ' : 'Transaction ID: ') + p.reference);
    if (x.clearing) L.push('Clearing ref.: ' + x.clearing);
    L.push('Amount: PKR ' + money(p.amount)); return L; }
  const L = []; pays.slice(0, 5).forEach((p, i) => { const x = d(p);
    L.push((i + 1) + '. ' + when(p) + ' - PKR ' + money(p.amount));
    const sub = [x.sender && 'By ' + x.sender, x.account && 'A/c ' + x.account, x.bank || p.method, p.reference && (p.method === 'Cheque' ? 'Chq ' : 'Txn ') + p.reference, x.clearing && 'Clr ' + x.clearing].filter(Boolean).join(' | '); if (sub) L.push('    ' + sub); });
  if (pays.length > 5) L.push('+ ' + (pays.length - 5) + ' more payments'); return L;
}
function layoutInvoiceK(inv, logo, sig, K) {
  const P = [[]]; let pg = 0;
  const add = c => P[pg].push(c);
  const R = (x, y, w, hh, o = {}) => add({ t: 'r', x, y, w, h: hh, ...o });
  const L = (x1, y1, x2, y2, lw = BORDER) => add({ t: 'l', x1, y1, x2, y2, lw });
  const T = (s, x, y, o = {}) => add({ t: 't', s: safe(s), x, y, font: o.font || 'times', style: o.style || 'normal', size: o.size || 10, align: o.align || 'left', color: o.color });
  const LEFT = K.l, RIGHT = 600 - K.l, WID = RIGHT - LEFT, HW = (WID - 14) / 2;

  const pays = inv.id ? db.payments.filter(x => x.invoice_id === inv.id && !isPendingChq(x)).sort((a, b) => String(a.date).localeCompare(String(b.date))) : [];
  const recv = round2(pays.reduce((a, x) => a + num(x.amount), 0)), totalAmt = round2(num(inv.total));
  const isPaid = totalAmt > 0 && recv >= totalAmt - 0.005, GREEN = [24, 120, 58];
  // ---- header block
  if (logo) add({ t: 'i', src: logo, x: LEFT, y: K.logoY, w: K.logoW, h: K.logoW * 0.7837 });
  T(isPaid ? 'Payment Receipt' : 'Proforma Invoice', RIGHT, K.logoY + 18, { font: 'helvetica', style: 'bold', size: K.title, align: 'right' });
  const info = [['Date', fmtDate(inv.date)], ['Project Code', inv.po_no], ['Project Name', inv.project], ['Invoice #', inv.invoice_no]];
  info.forEach(([lab, val], i) => {
    const y = K.infoY + i * K.step, ih = K.ih, ty = y + ih / 2 + 3.5;
    R(RIGHT - 284, y, 66, ih); R(RIGHT - 213, y, 213, ih);
    T(lab, RIGHT - 251, ty, { font: 'helvetica', size: 8, align: 'center' });
    let sz = 10; val = safe(val || ''); while (sz > 6.5 && tw(val, 'times', 'normal', sz) > 201) sz -= 0.5;
    T(val, RIGHT - 106.5, ty, { size: sz, align: 'center' });
  });

  // ---- invoice-to / transfer-payment-to
  const top = K.top, XR = RIGHT - HW, HH = K.hh;
  R(LEFT, top, HW, HH); R(XR, top, HW, HH);
  T('Invoice To:', LEFT + 12, top + HH / 2 + 3.5, { font: 'helvetica', size: 9.5 });
  T(isPaid ? 'Payment Received:' : recv > 0 ? 'Payments Received  /  Balance To:' : 'Transfer Payment To:', XR + 6, top + HH / 2 + 3.5, { size: 10 });
  const cust = inv.customer_snapshot, acc = inv.account_snapshot, LH = K.lh;
  const left = []; custLines(cust).forEach(l => wrap(l.text, HW - 18, 'times', l.bold ? 'bold' : 'normal', 10).forEach(t => left.push({ t, bold: l.bold })));
  const right = []; (isPaid ? paidLines(pays) : recv > 0 ? paidLines(pays).concat(accLines(acc).length ? ['- - - - - - - - - - - - - - - - - - - -', 'Balance transfer details:'] : [], accLines(acc)) : accLines(acc)).forEach(l => wrap(l, HW - 28, 'times', 'normal', recv > 0 && (pays.length > 1 || !isPaid) ? 9 : 10).forEach(t => right.push(t)));
  const boxH = Math.max(K.boxMin, 16 + Math.max(left.length, right.length) * LH), BY = top + HH + 4;
  R(LEFT, BY, HW, boxH); R(XR, BY, HW, boxH);
  left.forEach((l, i) => T(l.t, LEFT + 6, BY + 15 + i * LH, { style: l.bold ? 'bold' : 'normal' }));
  right.forEach((l, i) => T(l, XR + 14, BY + 15 + i * LH, {}));

  // ---- items table
  const cx = [LEFT, LEFT + K.itemW, RIGHT - 242, RIGHT - 192, RIGHT - 154, RIGHT - 80, RIGHT], FS = K.fs;
  const rows = inv.items.map(i => ({ a: i.item, b: i.description, q: fmtQty(i.qty), u: legacyUnit(i), r: money(i.rate), m: money(i.amount) }))
    .concat(inv.taxes.map(t => ({ a: 'Tax', b: fmtQty(t.pct) + '% ' + (t.label || 'Tax'), q: '', u: '', r: '', m: money(t.amount) })))
    .concat((inv.adjustments || []).map(a => ({ a: kindOf(a), b: (a.label || '') + (a.mode === 'pct' ? ' (' + (a.sign < 0 ? '-' : '+') + fmtQty(a.value) + '%)' : ''), q: '', u: '', r: '', m: signed(a.amount) })));
  const BODY_BOTTOM = 676, RH = FS * 1.24, TH = K.th;
  let y = BY + boxH + K.gap;
  const header = yy => {
    R(LEFT, yy, WID, TH, { fill: GREY });
    ['Item', 'Description', 'Unit', 'Qty', 'Rate', 'Amount'].forEach((tx, i) => T(tx, (cx[i] + cx[i + 1]) / 2, yy + TH / 2 + 3.5, { font: 'helvetica', size: 9.5, align: 'center' }));
    return yy + TH;
  };
  let bodyTop = header(y); y = bodyTop;
  const closeBody = () => { R(LEFT, bodyTop, WID, BODY_BOTTOM - bodyTop); for (let i = 1; i < 6; i++) L(cx[i], bodyTop - TH, cx[i], BODY_BOTTOM); };
  rows.forEach(r => {
    const A = wrap(r.a, cx[1] - cx[0] - 10, 'times', 'normal', FS), B = wrap(r.b || '', cx[2] - cx[1] - 12, 'times', 'normal', FS);
    const rh = Math.max(A.length, B.length, 1) * RH + K.pad, by = K.pad / 2 + FS * 0.9;
    if (y + rh > BODY_BOTTOM && y > bodyTop + 1) { closeBody(); pg++; P[pg] = []; bodyTop = header(40); y = bodyTop; }
    A.forEach((t, i) => T(t, cx[0] + 5, y + by + i * RH, { size: FS }));
    B.forEach((t, i) => T(t, cx[1] + 6, y + by + i * RH, { size: FS }));
    if (r.u) T(r.u, (cx[2] + cx[3]) / 2, y + by, { size: FS, align: 'center' });
    if (r.q) T(r.q, (cx[3] + cx[4]) / 2, y + by, { size: FS, align: 'center' });
    if (r.r) T(r.r, cx[5] - 6, y + by, { size: FS, align: 'right' });
    T(r.m, cx[6] - 6, y + by, { size: FS, align: 'right' });
    y += rh;
  });
  closeBody();

  // ---- total (last page)
  R(LEFT, BODY_BOTTOM + 5, WID, 40); L(RIGHT - 182, BODY_BOTTOM + 5, RIGHT - 182, BODY_BOTTOM + 45);
  T('Total Amount in Words:', LEFT + 6, BODY_BOTTOM + 16.5, { font: 'helvetica', style: 'bold', size: 8 });
  wrap(amountWords(inv.total, inv.words_style), 334, 'times', 'normal', 9.5).slice(0, 2).forEach((l, i) => T(l, LEFT + 6, BODY_BOTTOM + 28 + i * 10.5, { size: 9.5 }));
  T('Total', RIGHT - 156, BODY_BOTTOM + 30, { font: 'helvetica', style: 'bold', size: 11, align: 'center' });
  T('PKR ' + money(inv.total), RIGHT - 8, BODY_BOTTOM + 30, { style: 'bold', size: 14, align: 'right' });
  // ---- payment status: received / balance, thank-you note and PAID stamp
  if (recv > 0) {
    const sy = BODY_BOTTOM + 50, bal = isPaid ? 0 : round2(totalAmt - recv);
    R(RIGHT - 182, sy, 182, 32); L(RIGHT - 182, sy + 16, RIGHT, sy + 16);
    T('Amount Received', RIGHT - 176, sy + 11.5, { font: 'helvetica', style: 'bold', size: 8 });
    T('PKR ' + money(isPaid ? totalAmt : recv), RIGHT - 6, sy + 11.5, { size: 9.5, align: 'right' });
    T('Balance Due', RIGHT - 176, sy + 27.5, { font: 'helvetica', style: 'bold', size: 8 });
    T('PKR ' + money(bal), RIGHT - 6, sy + 27.5, { style: 'bold', size: 10.5, align: 'right', color: isPaid ? GREEN : undefined });
  }
  let noteX = LEFT, noteW = WID, noteY = BODY_BOTTOM + 62, noteMax = 4;
  if (isPaid) {
    // The stamp goes in the empty part of the items table (inside the Description column, so it never crosses a grid line,
    // a row of text, a signature or the Energix stamp). If the table is full it is made smaller / the thank-you becomes one line.
    const last = pays.map(x => x.date).filter(Boolean).sort().pop();
    const freeTop = y + 8, free = BODY_BOTTOM - 8 - freeTop, colMid = (cx[1] + cx[2]) / 2;
    const THANKS = 'Thank you for your payment. We truly appreciate your prompt settlement and your trust in Energix Technologies.';
    const mk = (cy, w, hh, big, cxx = colMid, mini = false) => add({ t: 'stamp', cx: cxx, cy, ang: 5, w, h: hh, color: GREEN, alpha: 1, title: 'PAID', sub: mini ? '' : 'PAYMENT RECEIVED IN FULL', sub2: mini || !last ? '' : fmtDate(last), big });
    let thanksInside = false;
    if (free >= 70) { const h0 = 62, cy = freeTop + 6 + h0 / 2; mk(cy, 164, h0, 30); if (free >= 70 + 44) { thanksInside = true; wrap(THANKS, cx[2] - cx[1] - 20, 'times', 'italic', 9).slice(0, 4).forEach((l, i) => T(l, cx[1] + 10, cy + h0 / 2 + 16 + i * 11, { size: 9, style: 'italic', color: GREEN })); } }
    else if (free >= 46) mk(freeTop + 3 + 20, 140, 40, 22);
    else mk(773.5, 88, 24, 13, RIGHT - 55, true);   // table is full: small stamp in the empty space above "Received By"
    if (!thanksInside) { T('Thank you for your payment - we truly appreciate your prompt settlement.', LEFT, BODY_BOTTOM + 59, { size: 8.5, style: 'italic', color: GREEN }); noteY = BODY_BOTTOM + 71; noteMax = 3; }
  }
  if (inv.notes) wrap('Notes: ' + inv.notes, noteW, 'times', 'normal', 9).slice(0, noteMax).forEach((l, i) => T(l, noteX, noteY + i * 11.5, { size: 9 }));

  // ---- signatures + footer (last page)
  [[LEFT, LEFT + 109, 'Prepared By'], [245, 355, 'Approved By'], [RIGHT - 110, RIGHT, 'Received By']].forEach(([a, b, lab]) => { L(a, 786, b, 786, 0.8); T(lab, (a + b) / 2, 797, { size: 9.5, align: 'center' }); });
  if (sig && inv.show_sign !== false) {
    const put = (im, cx, bottom, mw, mh) => { if (!im) return; let w = mw, hh = mw * im.r; if (hh > mh) { hh = mh; w = mh / im.r; } add({ t: 'i', src: im.src, x: cx - w / 2, y: bottom - hh, w, h: hh }); };
    const busy = isPaid || !!inv.notes;   // thank-you / notes sit just above the signatures: keep the images below them
    put(sig.prepared, LEFT + 54.5, 784, 108, busy ? 32 : 48);
    put(sig.approved, 288, 790, 112, busy ? 38 : 66);
    put(sig.stamp, 376, 800, 84, busy ? 46 : 52);
  }
  T('Energix Technologies  |  11 J-2 Wapda Town, Lahore  |  03100002823  |  +92 42 35199988  |  info@energixtechnologies.com', 297.6, 825, { font: 'helvetica', size: 7, align: 'center', color: [120, 120, 120] });
  if (P.length > 1) P.forEach((pgc, i) => pgc.push({ t: 't', s: `Page ${i + 1} of ${P.length}`, x: RIGHT, y: 825, font: 'helvetica', style: 'normal', size: 7, align: 'right', color: [120, 120, 120] }));
  return P;
}
const FIT_LEVELS = [
  { l: 36, fs: 9.5, pad: 7, logoY: 26, logoW: 190, title: 24, infoY: 58, step: 32, ih: 24, top: 198, hh: 24, lh: 12.8, boxMin: 88, itemW: 100, th: 22, gap: 14 },
  { l: 32, fs: 9, pad: 5.5, logoY: 24, logoW: 165, title: 22, infoY: 54, step: 27, ih: 21, top: 176, hh: 22, lh: 12, boxMin: 74, itemW: 96, th: 20, gap: 10 },
  { l: 28, fs: 8.5, pad: 4.5, logoY: 22, logoW: 150, title: 21, infoY: 50, step: 24, ih: 19, top: 160, hh: 20, lh: 11.4, boxMin: 64, itemW: 92, th: 19, gap: 8 },
  { l: 24, fs: 8, pad: 3.5, logoY: 20, logoW: 138, title: 20, infoY: 46, step: 22, ih: 18, top: 148, hh: 19, lh: 10.8, boxMin: 56, itemW: 88, th: 18, gap: 7 },
  { l: 20, fs: 7.5, pad: 3, logoY: 18, logoW: 126, title: 19, infoY: 42, step: 21, ih: 17, top: 138, hh: 18, lh: 10.2, boxMin: 50, itemW: 84, th: 17, gap: 6 },
  { l: 18, fs: 7, pad: 2.5, logoY: 16, logoW: 116, title: 18, infoY: 38, step: 20, ih: 16, top: 128, hh: 17, lh: 9.6, boxMin: 44, itemW: 80, th: 16, gap: 5 }
];
/* tries the roomiest layout first and tightens margins / fonts / spacing until everything fits on ONE A4 page */
function layoutInvoice(inv, logo, sig) {
  let P;
  for (const K of FIT_LEVELS) { P = layoutInvoiceK(inv, logo, sig, K); if (P.length === 1) return P; }
  return P;
}
/* rotated "PAID" stamp: double border + text, drawn in both the PDF and the on-screen canvas */
function stampLines(c) {
  const small = c.h < 50, L = [{ s: c.title, y: c.sub ? (small ? -1 : -4) : c.big * 0.35, size: c.big, bold: true }];
  if (c.sub) L.push({ s: c.sub, y: small ? c.h / 2 - 9 : c.h / 2 - 19, size: small ? 6.2 : 7.4, bold: true });
  if (c.sub2 && !small) L.push({ s: c.sub2, y: c.h / 2 - 8, size: 8.2, bold: false });
  return L;
}
function stampPDF(d, c) {
  const a = c.ang * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  const pt = (lx, ly) => [c.cx + lx * cs + ly * sn, c.cy - lx * sn + ly * cs];
  d.saveGraphicsState(); d.setGState(new d.GState({ opacity: c.alpha, 'stroke-opacity': c.alpha })); d.setDrawColor(...c.color); d.setTextColor(...c.color);
  (c.big > 50 ? [] : [[c.w / 2, c.h / 2, 2.2], [c.w / 2 - 4, c.h / 2 - 4, 0.8]]).forEach(([hw, hh, lw]) => {
    d.setLineWidth(lw); const q = [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)];
    for (let i = 0; i < 4; i++) { const u = q[i], v = q[(i + 1) % 4]; d.line(u[0], u[1], v[0], v[1]); }
  });
  stampLines(c).forEach(t => { const [x, y] = pt(0, t.y); d.setFont('helvetica', t.bold ? 'bold' : 'normal'); d.setFontSize(t.size); d.text(t.s, x, y, { align: 'center', angle: c.ang }); });
  d.restoreGraphicsState();
}
function toPDF(pages) {
  const d = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', compress: true });
  d.setProperties({ title: (pvInv && stateOf(pvInv) === 'Paid' ? 'Payment Receipt ' : 'Invoice ') + (pvInv ? pvInv.invoice_no : ''), author: 'Energix Technologies', creator: 'Energix Finance' });
  pages.forEach((cmds, pi) => {
    if (pi) d.addPage();
    cmds.forEach(c => {
      if (c.t === 'r') { const f = !!c.fill, s = c.stroke !== false; if (f) d.setFillColor(...c.fill); d.setDrawColor(0, 0, 0); d.setLineWidth(c.lw || BORDER); d.rect(c.x, c.y, c.w, c.h, f && s ? 'FD' : f ? 'F' : 'S'); }
      else if (c.t === 'l') { d.setDrawColor(0, 0, 0); d.setLineWidth(c.lw || BORDER); d.line(c.x1, c.y1, c.x2, c.y2); }
      else if (c.t === 't') { d.setFont(c.font, c.style); d.setFontSize(c.size); d.setTextColor(...(c.color || [0, 0, 0])); d.text(c.s, c.x, c.y, { align: c.align }); }
      else if (c.t === 'i') { d.addImage(c.src, 'PNG', c.x, c.y, c.w, c.h); }
      else if (c.t === 'stamp') { stampPDF(d, c); }
    });
  });
  return d;
}
const imgCache = {};
function loadImg(src) { return imgCache[src] || (imgCache[src] = new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; })); }
async function toCanvas(cmds, canvas) {
  const S = canvas.width / 595.28, ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const FAM = { helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif', times: '"Times New Roman", Times, "Liberation Serif", serif' };
  for (const c of cmds) {
    if (c.t === 'r') { if (c.fill) { ctx.fillStyle = `rgb(${c.fill.join(',')})`; ctx.fillRect(c.x * S, c.y * S, c.w * S, c.h * S); } if (c.stroke !== false) { ctx.strokeStyle = '#000'; ctx.lineWidth = (c.lw || BORDER) * S; ctx.strokeRect(c.x * S, c.y * S, c.w * S, c.h * S); } }
    else if (c.t === 'l') { ctx.strokeStyle = '#000'; ctx.lineWidth = (c.lw || BORDER) * S; ctx.beginPath(); ctx.moveTo(c.x1 * S, c.y1 * S); ctx.lineTo(c.x2 * S, c.y2 * S); ctx.stroke(); }
    else if (c.t === 't') { ctx.font = `${c.style === 'bold' ? 'bold ' : ''}${c.size * S}px ${FAM[c.font]}`; ctx.fillStyle = c.color ? `rgb(${c.color.join(',')})` : '#000'; ctx.textAlign = c.align || 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(c.s, c.x * S, c.y * S); }
    else if (c.t === 'i') { const im = await loadImg(c.src); if (im) ctx.drawImage(im, c.x * S, c.y * S, c.w * S, c.h * S); }
    else if (c.t === 'stamp') {
      ctx.save(); ctx.translate(c.cx * S, c.cy * S); ctx.rotate(-c.ang * Math.PI / 180); ctx.globalAlpha = c.alpha;
      const col = `rgb(${c.color.join(',')})`; ctx.strokeStyle = col; ctx.fillStyle = col;
      (c.big > 50 ? [] : [[c.w / 2, c.h / 2, 2.2], [c.w / 2 - 4, c.h / 2 - 4, 0.8]]).forEach(([hw, hh, lw]) => { ctx.lineWidth = lw * S; ctx.strokeRect(-hw * S, -hh * S, 2 * hw * S, 2 * hh * S); });
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      stampLines(c).forEach(t => { ctx.font = `${t.bold ? 'bold ' : ''}${t.size * S}px ${FAM.helvetica}`; ctx.fillText(t.s, 0, t.y * S); });
      ctx.restore();
    }
  }
}

/* ================= preview + generate PDF ================= */
/* PDF file name: yyyymmdd - Company - Customer - Project code - Project name - Invoice no. (| is not allowed in file names) */
function pdfName(inv) {
  const c = byId('customers', inv.customer_id) || inv.customer_snapshot || {};
  const cl = t => String(t || '').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const d = String(inv.date || '').replace(/-/g, '').slice(0, 8);
  return [d, cl(c.company), cl([c.title, c.name].filter(Boolean).join(' ')), cl(inv.po_no), cl(inv.project), cl(inv.invoice_no), inv.id && inv.status !== 'cancelled' && stateOf(inv) === 'Paid' ? 'PAID' : ''].filter(Boolean).join(' - ') + '.pdf';
}
/* after saving / generating: close the preview, leave the editor and land on the invoice list */
let sendBack = false;
function backToInvoices() {
  if ($('#pvDlg').open) $('#pvDlg').close();
  pvFromEditor = false; $('#iEditor').hidden = true; edDirty = false;
  showTab('invoices'); $('#invList').hidden = false; renderInvoices(); window.scrollTo({ top: 0 });
}
let pvInv = null, pvFromEditor = false, pvPages = null;
async function loadSigs() {
  const out = {};
  if (REMOTE && !db.assets.length) {                       // startup load may have been skipped or failed: fetch directly and say why if it fails
    try { db.assets = (await rest('/rest/v1/assets?select=*')) || []; }
    catch (err) { setTimeout(() => toast('Could not load signatures: ' + (err && (err.message || err.status) || 'unknown error') + '. Sign out, sign in again and refresh (Ctrl+F5).', true), 700); }
  }
  for (const [k, id] of [['prepared', 'sign-prepared'], ['approved', 'sign-approved'], ['stamp', 'stamp']]) {
    const row = byId('assets', id); if (!row || !row.data) continue;
    const im = await loadImg(row.data); if (im && im.naturalWidth) out[k] = { src: row.data, r: im.naturalHeight / im.naturalWidth };
  }
  return out;
}
async function openPreview(inv) {
  const logo = await loadLogo(), sig = await loadSigs(); pvInv = inv; pvPages = layoutInvoice(inv, logo, sig);
  if (inv.show_sign !== false && !Object.keys(sig).length) setTimeout(() => toast('No signatures or stamp are saved yet. Add them with the "Signatures & stamp" button at the top.', true), 600);
  $('#pvTitle').textContent = 'Invoice preview · ' + inv.invoice_no;
  $('#pvBack').hidden = !pvFromEditor;
  const box = $('#pvPages'); box.replaceChildren();
  for (const cmds of pvPages) { const cv = h('canvas', { width: 1190, height: 1684 }); box.append(cv); await toCanvas(cmds, cv); }
  if (!$('#pvDlg').open) $('#pvDlg').showModal();
}
function previewInvoice(inv) { pvFromEditor = false; openPreview(inv).catch(fail); }
$('#pvBack').addEventListener('click', () => $('#pvDlg').close());
$('#pvClose').addEventListener('click', () => { $('#pvDlg').close(); if (pvFromEditor) { /* stay in editor */ } });
$('#pvPdf').addEventListener('click', async () => {
  const btn = $('#pvPdf'); btn.disabled = true;
  try {
    let inv = pvInv;
    if (pvFromEditor) { if (inv.status === 'draft') inv = { ...inv, status: 'issued' }; await save('invoices', inv); ed.id = inv.id; ed.created_at = inv.created_at; $('#iStatus').value = inv.status; pvInv = inv; }
    const doc = toPDF(pvPages); doc.save(pdfName(inv));
    toast('Invoice saved and PDF created.'); backToInvoices();
  } catch (err) { fail(err); } finally { btn.disabled = false; }
});

/* ================= send invoice (email / WhatsApp) ================= */
let sendInv = null;
const SEND_TEXT = 'Asalam Alikum,\n\nHopefully this message finds you well.\n\nPlease find the Invoice Attached for your kind reference & review.\n\nRegards,\nEnergix Technologies';
function waNumber(v) { let d = String(v || '').replace(/[^\d+]/g, ''); if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = '92' + d.slice(1); return d.replace(/\D/g, ''); }
function openSend(inv) {
  sendBack = false; sendInv = inv; const c = byId('customers', inv.customer_id) || inv.customer_snapshot || {};
  $('#sendTitle').textContent = 'Send invoice · ' + inv.invoice_no;
  $('#sendEmail').value = c.email || ''; $('#sendPhone').value = c.mobile || '';
  $('#sendMsg').value = stateOf(inv) === 'Paid' ? SEND_TEXT.replace('Please find the Invoice Attached for your kind reference & review.', 'Please find the Payment Receipt attached for your kind reference. Thank you for your payment.') : SEND_TEXT; $('#sendDlg').showModal();
}
async function sendPdf() {
  const logo = await loadLogo(), sig = await loadSigs(); const pages = layoutInvoice(sendInv, logo, sig);
  const doc = toPDF(pages); return { doc, name: pdfName(sendInv) };
}
$('#sendDlg').addEventListener('close', () => { if (sendBack) { sendBack = false; backToInvoices(); } });
$('#sendClose').addEventListener('click', () => $('#sendDlg').close());
$('#sendMail').addEventListener('click', async () => {
  const to = $('#sendEmail').value.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return toast('Enter a valid email address.', true);
  try {
    const { doc, name } = await sendPdf(); doc.save(name);
    const subj = (stateOf(sendInv) === 'Paid' ? 'Payment Receipt ' : 'Proforma Invoice ') + sendInv.invoice_no + ' - Energix Technologies';
    location.href = 'mailto:' + encodeURIComponent(to).replace('%40', '@') + '?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent($('#sendMsg').value);
    toast('PDF downloaded. Attach "' + name + '" in the email that just opened.'); $('#sendDlg').close();
  } catch (err) { fail(err); }
});
$('#sendWa').addEventListener('click', async () => {
  const n = waNumber($('#sendPhone').value); if (n.length < 10) return toast('Enter a valid WhatsApp number (e.g. 0300 1234567).', true);
  try {
    const { doc, name } = await sendPdf(); const blob = doc.output('blob'); const file = new File([blob], name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) { await navigator.share({ files: [file], text: $('#sendMsg').value }); $('#sendDlg').close(); return; }
    doc.save(name);
    window.open('https://wa.me/' + n + '?text=' + encodeURIComponent($('#sendMsg').value), '_blank', 'noopener');
    toast('PDF downloaded. Attach "' + name + '" in the WhatsApp chat that just opened.'); $('#sendDlg').close();
  } catch (err) { if (!(err && err.name === 'AbortError')) fail(err); }
});
$('#pvSend').addEventListener('click', async () => {
  try {
    let inv = pvInv;
    if (pvFromEditor) { if (inv.status === 'draft') inv = { ...inv, status: 'issued' }; await save('invoices', inv); ed.id = inv.id; ed.created_at = inv.created_at; $('#iStatus').value = inv.status; pvInv = inv; renderInvoices(); }
    const fromEd = pvFromEditor; openSend(inv); sendBack = fromEd;
  } catch (err) { fail(err); }
});

/* ================= selects + backup + boot ================= */
function refreshSelects() {
  const cs = [...db.customers].sort((a, b) => custLabel(a).localeCompare(custLabel(b)));
  setOptions($('#qCustomer'), cs, custLabel, '— select customer —');
  setOptions($('#iCustomer'), cs, custLabel, '— select customer —');
  setOptions($('#iAccount'), db.accounts, a => [a.title, a.bank].filter(Boolean).join(' · ') || a.account_no || a.iban || '(account)', '— select account —');
  setOptions($('#iQuote'), [...db.quotations].sort((a, b) => String(b.date).localeCompare(String(a.date))), q => q.quote_no + ' · ' + (q.project || custLabel(byId('customers', q.customer_id))), '— none —');
}
function fail(err) {
  console.error(err);
  if (err && err.message === 'auth') { logout(); return; }
  const m = String(err && err.message || err);
  toast(err && (err.status === 401 || err.status === 403) ? 'Not allowed: this account is not authorised for Finance (' + err.status + ').' : m, true);
}
$('#backupBtn').addEventListener('click', () => download(new Blob([JSON.stringify({ app: 'energix-finance', version: 1, exported: new Date().toISOString(), data: db }, null, 1)], { type: 'application/json' }), 'energix-finance-backup-' + today() + '.json'));
$('#restoreFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text()); if (j.app !== 'energix-finance' || !j.data) throw new Error('This is not an Energix finance backup file.');
    if (!await askConfirm('Restore ' + TABLES.filter(t => t !== 'drafts' && t !== 'assets').map(t => (j.data[t] || []).length + ' ' + t).join(', ') + '? Existing records with the same ID are overwritten.', 'Restore')) return;
    for (const t of ['customers', 'accounts', 'quotations', 'invoices', 'payments', 'assets']) { const rows = (j.data[t] || []).map(r => pick(t, r)).filter(r => r.id); for (let i = 0; i < rows.length; i += 200) await store.saveMany(t, rows.slice(i, i + 200)); }
    renderAll(); toast('Backup restored.');
  } catch (err) { fail(err); }
});

/* ================= signatures + stamp (stored privately in the database) ================= */
const SIG_SLOTS = [['sign-prepared', 'Prepared By signature'], ['sign-approved', 'Approved By signature'], ['stamp', 'Company stamp']];
async function imageToInk(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file is not a readable image.')); i.src = url; });
    const sc = Math.min(1, 560 / im.naturalWidth), w = Math.max(1, Math.round(im.naturalWidth * sc)), hgt = Math.max(1, Math.round(im.naturalHeight * sc));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = hgt; const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(im, 0, 0, w, hgt);
    const img = cx.getImageData(0, 0, w, hgt), d = img.data, bord = [[], [], []];
    const sample = (x, y) => { const i = (y * w + x) * 4; if (d[i + 3] > 200) { bord[0].push(d[i]); bord[1].push(d[i + 1]); bord[2].push(d[i + 2]); } };
    for (let x = 0; x < w; x++) { sample(x, 0); sample(x, hgt - 1); } for (let y = 0; y < hgt; y++) { sample(0, y); sample(w - 1, y); }
    const med = a => { if (!a.length) return 255; a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const P = [med(bord[0]), med(bord[1]), med(bord[2])]; const maxd = Math.max(60, Math.hypot(...P.map(v => 255 - v)) * 0.5 + 90);
    let minx = w, miny = hgt, maxx = 0, maxy = 0;
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, dist = Math.hypot(d[i] - P[0], d[i + 1] - P[1], d[i + 2] - P[2]);
      let a = Math.min(1, Math.max(0, (dist - 24) / (maxd * 0.5))); a = Math.min(Math.pow(a, 0.45), d[i + 3] / 255 > 0.4 ? 1 : d[i + 3] / 255 * 2);
      if (a > 0.02) { for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, Math.round(Math.round(Math.max(0, Math.min(255, (d[i + c] - P[c] * (1 - a)) / a)) / 12) * 12))); }
      d[i + 3] = Math.round(a * 255);
      if (a > 0.15) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    }
    if (maxx <= minx || maxy <= miny) throw new Error('Could not find any ink in that image.');
    cx.putImageData(img, 0, 0);
    const o = document.createElement('canvas'); o.width = maxx - minx + 1; o.height = maxy - miny + 1; o.getContext('2d').drawImage(cv, minx, miny, o.width, o.height, 0, 0, o.width, o.height);
    return o.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}
function renderSigs() {
  const box = $('#sigBody'); box.replaceChildren();
  SIG_SLOTS.forEach(([id, label]) => {
    const row = byId('assets', id), prev = h('div', { class: 'sigprev' }, row && row.data ? h('img', { src: row.data, alt: label }) : h('span', { class: 'small muted', text: 'Not added' }));
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files[0]; file.value = ''; if (!f) return;
      try { const data = await imageToInk(f); if (data.length > 600000) throw new Error('That image is too large. Use a smaller photo.'); await save('assets', { id, data }); renderSigs(); toast(label + ' saved.'); } catch (err) { fail(err); }
    });
    box.append(h('div', { class: 'sigrow' }, h('div', {}, h('b', { text: label }), prev),
      h('div', { class: 'actions' }, h('label', { class: 'btn ghost sm' }, row ? 'Replace' : 'Upload', file),
        row ? actBtn('Remove', async () => { try { await remove('assets', id); renderSigs(); } catch (err) { fail(err); } }, 'btn ghost sm') : null)));
  });
}
$('#sigBtn').addEventListener('click', () => { renderSigs(); $('#sigDlg').showModal(); });
$('#sigClose').addEventListener('click', () => $('#sigDlg').close());

/* ================= auto-drafts (saved to the backend when you leave a tab) ================= */
const DRAFT_FORMS = [
  { id: 'customer-form', form: '#cForm', clear: '[data-reset="cForm"]' },
  { id: 'account-form', form: '#aForm', clear: '[data-reset="aForm"]' },
  { id: 'quotation-form', form: '#qForm', clear: '#qClear' }
];
const formDirty = {};
const anyDirty = () => edDirty || Object.values(formDirty).some(Boolean);
DRAFT_FORMS.forEach(d => {
  const f = $(d.form), mark = () => { formDirty[d.id] = true; };
  f.addEventListener('input', mark); f.addEventListener('change', mark);
  f.addEventListener('click', e => { if (e.target.closest && e.target.closest('.chip')) mark(); });
  $(d.clear).addEventListener('click', () => clearFormDraft(d.id));
});
(function () { const ev = $('#iEditor'), mark = () => { edDirty = true; };
  ev.addEventListener('input', mark); ev.addEventListener('change', mark);
  ev.addEventListener('click', e => { const t = e.target; if (t.closest && (t.closest('#addItem') || t.closest('[data-tax]') || t.closest('.taxrow button') || t.closest('button[title="Remove row"]'))) mark(); });
})();
function formDraftData(d) {
  const f = $(d.form), v = readForm(f);
  if (d.id === 'quotation-form') { v.types = selToTypes(); v.qCat = qCat; }
  return v;
}
function draftHasContent(v) {
  const skip = ['id', 'date', 'quote_no', 'status', 'types', 'qCat'];
  return Object.entries(v).some(([k, x]) => !skip.includes(k) && trim(x)) || (v.types && v.types.length > 0);
}
function clearFormDraft(id) {
  formDirty[id] = false;
  const d = DRAFT_FORMS.find(x => x.id === id); if (d) $$('.draftnote', $(d.form)).forEach(n => n.remove());
  if (byId('drafts', id)) remove('drafts', id).catch(() => {});
}
async function flushInvoiceDraft() {
  if (!ed || $('#iEditor').hidden || !edDirty) return false;
  try {
    const inv = collectInvoice(true); await save('invoices', inv);
    ed.id = inv.id; ed.created_at = inv.created_at; edDirty = false; $('#iEdTitle').textContent = 'Edit invoice ' + inv.invoice_no; return true;
  } catch (err) { toast('Draft invoice not saved: ' + (err && err.message || err), true); return false; }
}
let flushChain = Promise.resolve();
function flushAll(quiet) {
  flushChain = flushChain.then(async () => {
    let saved = 0;
    for (const d of DRAFT_FORMS) {
      if (!formDirty[d.id]) continue;
      try {
        const v = formDraftData(d);
        if (draftHasContent(v)) { await save('drafts', { id: d.id, data: v, created_at: new Date().toISOString() }); saved++; }
        else if (byId('drafts', d.id)) await remove('drafts', d.id);
        formDirty[d.id] = false;
      } catch (err) { fail(err); }
    }
    if (await flushInvoiceDraft()) saved++;
    if (saved && !quiet) toast('Draft saved.');
  });
  return flushChain;
}
document.addEventListener('visibilitychange', () => { if (document.hidden && anyDirty()) flushAll(true); });
addEventListener('pagehide', () => { if (anyDirty()) flushAll(true); });
function restoreDrafts() {
  DRAFT_FORMS.forEach(d => {
    const row = byId('drafts', d.id); if (!row || !row.data || !draftHasContent(row.data)) return;
    const f = $(d.form); fillForm(f, row.data);
    if (d.id === 'quotation-form') { typesToSel(row.data.types); qCat = row.data.qCat || (row.data.types && row.data.types[0] && row.data.types[0].cat) || QTYPES[0].cat; renderQPicker(); }
    const h2 = $('h2', f); if (h2) h2.after(h('p', { class: 'draftnote small', text: 'Draft restored: this was auto-saved and is not yet saved as a record. Press Save to keep it, or Clear to discard.' }));
  });
}

function renderAll() { refreshSelects(); renderCustomers(); renderAccounts(); renderQuotations(); renderInvoices(); }
function logout() { clearSession(); location.reload(); }
$('#logoutBtn').addEventListener('click', async () => { const s = getSession(); try { if (s) await fetch(CFG.SUPABASE_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + s.access_token } }); } catch {} logout(); });
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, err = $('#loginErr'); err.textContent = ''; const btn = $('button', f); btn.disabled = true;
  try {
    const r = await fetch(CFG.SUPABASE_URL + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: CFG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: f.email.value.trim(), password: f.password.value }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error_description || j.msg || 'Sign-in failed.');
    setSession(j); f.password.value = ''; await boot();
  } catch (x) { err.textContent = x.message; } finally { btn.disabled = false; }
});
async function boot() {
  if (REMOTE && !getSession()) { $('#login').hidden = false; $('#app').hidden = true; return; }
  $('#login').hidden = true; $('#app').hidden = false;
  const tag = $('#modeTag');
  if (REMOTE) { tag.textContent = 'Supabase'; $('#userEmail').textContent = (getSession() || {}).email || ''; $('#logoutBtn').hidden = false; }
  else { tag.textContent = 'Local mode'; tag.classList.add('local'); const b = $('#banner'); b.hidden = false; b.textContent = 'Local mode: your data is stored only in this browser. Connect Supabase (js/config.js) to save it centrally and protect it with a login. Use Backup to keep a copy.'; }
  try { await store.load(); } catch (err) { fail(err); }
  renderAll(); clearQuote(); renderQPicker(); restoreDrafts();
  setInterval(() => { if (anyDirty()) flushAll(true); }, 20000);
  let tab = 'customers'; try { tab = sessionStorage.getItem('energix_fin_tab') || tab; } catch {}
  showTab(tab);
}
boot();
})();
