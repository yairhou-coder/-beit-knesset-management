/** מסך הוצאות: לאן הכסף יוצא, עם קטגוריות, סינון וצירוף חשבוניות. */

import { api } from '../api.js';
import { date, esc, money, number } from '../format.js';
import { field, openModal, section, selectOptions, statCard, table, toast } from '../ui.js';
import { organizationOptions, state, withOrg } from '../state.js';
import { navigate } from '../router.js';

let categoriesCache = null;

async function categories() {
  if (!categoriesCache) categoriesCache = (await api.expenseCategories()).items;
  return categoriesCache;
}

const KIND_TONES = { salary: 'neutral', ongoing: 'warning', events: 'positive', maintenance: 'neutral', other: 'neutral' };

function filtersForm(params, cats) {
  const kindOptions = [
    { value: '', label: 'כל הסוגים' },
    { value: 'salary', label: 'משכורות' },
    { value: 'ongoing', label: 'הוצאות שוטפות' },
    { value: 'events', label: 'חגים ואירועים' },
    { value: 'maintenance', label: 'תחזוקה' },
    { value: 'other', label: 'אחר' },
  ];
  const categoryOptions = cats.map((c) => ({ value: c.id, label: `${c.name} (${c.kindLabel})` }));
  const attachmentOptions = [
    { value: '', label: 'הכל' },
    { value: 'true', label: 'עם חשבונית' },
    { value: 'false', label: 'ללא חשבונית' },
  ];

  return `
    <form id="expense-filters" class="filters">
      ${field('חיפוש', `<input type="search" name="search" value="${esc(params.search ?? '')}" placeholder="ספק, תיאור, מספר חשבונית" />`)}
      ${field('סוג הוצאה', `<select name="kind">${selectOptions(kindOptions, params.kind ?? '')}</select>`)}
      ${field('קטגוריה', `<select name="categoryId">${selectOptions(categoryOptions, params.categoryId, { placeholder: 'כל הקטגוריות' })}</select>`)}
      ${field('עמותה', `<select name="organizationId">${selectOptions(organizationOptions(), params.organizationId, { placeholder: 'כל העמותות' })}</select>`)}
      ${field('חשבונית', `<select name="withAttachment">${selectOptions(attachmentOptions, params.withAttachment ?? '')}</select>`)}
      ${field('מתאריך', `<input type="date" name="fromDate" value="${esc(params.fromDate ?? '')}" />`)}
      ${field('עד תאריך', `<input type="date" name="toDate" value="${esc(params.toDate ?? '')}" />`)}
      <div class="btn-row">
        <button type="submit" class="btn primary">סינון</button>
        <button type="button" class="btn" data-reset>ניקוי</button>
      </div>
    </form>`;
}

export async function renderExpenses(route) {
  const params = route.params;
  const cats = await categories();
  const data = await api.expenses(
    withOrg({
      search: params.search,
      kind: params.kind,
      categoryId: params.categoryId,
      organizationId: params.organizationId,
      eventId: params.eventId,
      withAttachment: params.withAttachment,
      fromDate: params.fromDate,
      toDate: params.toDate,
      // הרשימה מוגבלת לאחרונות; הסיכומים למטה מחושבים על כל הרשומות המסוננות
      limit: params.limit ?? 60,
    }),
  );
  const summary = data.summary;

  const cards = `
    <div class="card-grid" style="margin:0">
      ${statCard({ title: 'סך ההוצאות', amountAgorot: summary.totalAgorot, hint: `${number(summary.count)} רשומות`, tone: 'neutral', link: '#/expenses' })}
      ${summary.byKind
        .slice(0, 4)
        .map((row) =>
          statCard({
            title: row.label,
            amountAgorot: row.amountAgorot,
            hint: `${row.share}% מסך ההוצאות`,
            tone: KIND_TONES[row.id] ?? 'neutral',
            link: `#/expenses?kind=${row.id ?? ''}`,
          }),
        )
        .join('')}
      ${statCard({
        title: 'ללא חשבונית מצורפת',
        count: summary.missingInvoice.count,
        hint: money(summary.missingInvoice.amountAgorot),
        tone: summary.missingInvoice.count > 0 ? 'warning' : 'positive',
        link: '#/expenses?withAttachment=false',
      })}
    </div>`;

  const rows = table(
    [
      { header: 'תאריך', cell: (row) => date(row.expenseDate) },
      {
        header: 'קטגוריה',
        cell: (row) =>
          `${esc(row.category.name)}${row.category.kindLabel ? `<div class="small muted">${esc(row.category.kindLabel)}</div>` : ''}`,
      },
      { header: 'ספק', cell: (row) => esc(row.supplier ?? '—') },
      { header: 'תיאור', cell: (row) => esc(row.description ?? '—') },
      { header: 'אירוע', cell: (row) => esc(row.event?.name ?? '—') },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'מס׳ חשבונית', cell: (row) => (row.invoiceNumber ? `<span class="mono">${esc(row.invoiceNumber)}</span>` : '—') },
      { header: 'סכום', className: 'num', cell: (row) => `<strong>${money(row.amountAgorot)}</strong>` },
      {
        header: 'חשבונית',
        cell: (row) =>
          row.attachments.length > 0
            ? row.attachments
                .map(
                  (a) =>
                    `<a class="btn small" href="/api/expenses/attachments/${a.id}/file" target="_blank" rel="noopener" title="${esc(a.filename)}">צפייה</a>`,
                )
                .join(' ')
            : '<span class="badge warning">חסרה</span>',
      },
      {
        header: '',
        cell: (row) => `
          <div class="btn-row">
            <button class="btn small" data-edit="${row.id}">עריכה</button>
            <button class="btn small" data-attach="${row.id}">צירוף</button>
          </div>`,
      },
    ],
    data.items,
    'אין הוצאות התואמות לסינון',
  );

  const breakdown = (title, list, param) =>
    section(
      title,
      table(
        [
          { header: 'שם', cell: (row) => esc(row.label) },
          { header: 'סכום', className: 'num', cell: (row) => money(row.amountAgorot) },
          { header: 'חלק', className: 'num', cell: (row) => `${row.share}%` },
          {
            header: '',
            cell: (row) => (row.id ? `<a class="btn small" href="#/expenses?${param}=${row.id}">הצג</a>` : ''),
          },
        ],
        list.filter((row) => row.amountAgorot > 0),
        'אין נתונים',
      ),
      { flush: true },
    );

  const monthly = table(
    [
      { header: 'חודש', cell: (row) => esc(row.month) },
      { header: 'סכום', className: 'num', cell: (row) => money(row.amountAgorot) },
      { header: 'רשומות', className: 'num', cell: (row) => number(row.count) },
    ],
    summary.byMonth.slice(0, 12),
    'אין נתונים',
  );

  const intro = `
    <p class="small" style="padding:4px">
      כאן נרשמת <strong>כל הוצאה שיצאה בפועל</strong> — עם תאריך, ספק, סכום וחשבונית.
      התכנון והאומדנים נמצאים במסך <a href="#/budget">התקציב</a>, והוא משווה את עצמו
      למספרים שכאן.
    </p>`;

  return `
    ${section('סיכום הוצאות', intro + cards, { hint: 'לחיצה על כרטיס מסננת את הרשימה' })}
    ${section('סינון', filtersForm(params, cats))}
    ${section('הוצאות', rows, {
      hint:
        summary.count > data.items.length
          ? `${number(data.items.length)} אחרונות מתוך ${number(summary.count)} · סה"כ ${money(summary.totalAgorot)}`
          : `${number(summary.count)} רשומות · סה"כ ${money(summary.totalAgorot)}`,
      actions:
        summary.count > data.items.length
          ? `<a class="btn small" href="#/expenses${location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?')) + '&' : '?'}limit=1000">הצג הכל</a>`
          : '',
      flush: true,
    })}
    <div class="grid-2">
      ${breakdown('לפי קטגוריה', summary.byCategory, 'categoryId')}
      ${breakdown('לפי חג / אירוע', summary.byEvent, 'eventId')}
      ${section('לפי חודש', monthly, { flush: true })}
    </div>`;
}

export function bindExpenses(root, reload) {
  const form = root.querySelector('#expense-filters');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    navigate('expenses', Object.fromEntries(new FormData(form).entries()));
  });
  form?.querySelector('[data-reset]')?.addEventListener('click', () => navigate('expenses', {}));

  root.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', async () => {
      const response = await api.get(`/expenses/${button.dataset.edit}`);
      openExpenseModal({ expense: response.expense, onDone: reload });
    });
  });

  root.querySelectorAll('[data-attach]').forEach((button) => {
    button.addEventListener('click', () =>
      openAttachModal({ expenseId: Number(button.dataset.attach), onDone: reload }),
    );
  });
}

/** קורא קובץ מהדפדפן ומחזיר אותו כ-base64 לשליחה. */
function readFile(input) {
  const file = input.files?.[0];
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        filename: file.name,
        mimeType: file.type || 'application/pdf',
        dataBase64: String(reader.result).split(',')[1],
      });
    reader.onerror = () => reject(new Error('לא ניתן לקרוא את הקובץ'));
    reader.readAsDataURL(file);
  });
}

/** טופס הוצאה. תומך בהעלאת חשבונית שממלאת את השדות מראש. */
export async function openExpenseModal({ expense, onDone } = {}) {
  const cats = await categories();
  const events = state.events.map((event) => ({ value: event.id, label: event.name }));
  const methods = Object.entries(state.lookups.paymentMethods ?? {}).map(([value, label]) => ({
    value,
    label,
  }));
  const todayIso = new Date().toISOString().slice(0, 10);

  const bodyHtml = `
    ${
      expense
        ? ''
        : `<div class="full" style="background:var(--surface-alt);border:1px solid var(--border);border-radius:8px;padding:12px">
             <label style="font-size:13px;font-weight:600">העלאת חשבונית</label>
             <input type="file" name="invoice" accept="application/pdf,image/*" style="margin-top:6px" />
             <div class="small muted" style="margin-top:6px" id="scan-note">
               ניתן להעלות חשבונית, והמערכת תנסה למלא את הסכום, התאריך ומספר החשבונית.
               הנתונים הם הצעה בלבד - יש לאמת אותם לפני שמירה.
             </div>
           </div>`
    }
    <div class="form-grid">
      ${field('קטגוריה', `<select name="categoryId" required>${selectOptions(cats.map((c) => ({ value: c.id, label: `${c.name} · ${c.kindLabel}` })), expense?.category.id, { placeholder: 'בחרו קטגוריה' })}</select>`)}
      ${field('עמותה', `<select name="organizationId" required>${selectOptions(organizationOptions(), expense?.organization.id ?? state.organizationId)}</select>`)}
      ${field('סכום (₪)', `<input type="number" name="amountShekels" min="0.01" step="0.01" required value="${expense ? expense.amountAgorot / 100 : ''}" />`)}
      ${field('תאריך', `<input type="date" name="expenseDate" required value="${esc(expense?.expenseDate ?? todayIso)}" />`)}
      ${field('ספק', `<input type="text" name="supplier" value="${esc(expense?.supplier ?? '')}" />`)}
      ${field('מספר חשבונית', `<input type="text" name="invoiceNumber" value="${esc(expense?.invoiceNumber ?? '')}" />`)}
      ${field('אמצעי תשלום', `<select name="method">${selectOptions(methods, expense?.method ?? '', { placeholder: 'לא נקבע' })}</select>`)}
      ${field('שיוך לחג / אירוע', `<select name="eventId">${selectOptions(events, expense?.event?.id ?? '', { placeholder: 'ללא שיוך' })}</select>`)}
      ${field('תיאור', `<input type="text" name="description" value="${esc(expense?.description ?? '')}" />`, { className: 'full' })}
      ${field('הערות', `<textarea name="notes">${esc(expense?.notes ?? '')}</textarea>`, { className: 'full' })}
    </div>`;

  openModal({
    title: expense ? 'עריכת הוצאה' : 'הוצאה חדשה',
    bodyHtml,
    submitLabel: expense ? 'שמירה' : 'רישום ההוצאה',
    onSubmit: async (formData) => {
      const payload = {
        organizationId: Number(formData.get('organizationId')),
        categoryId: Number(formData.get('categoryId')),
        amountShekels: formData.get('amountShekels'),
        expenseDate: formData.get('expenseDate'),
        supplier: formData.get('supplier') || null,
        invoiceNumber: formData.get('invoiceNumber') || null,
        method: formData.get('method') || null,
        eventId: formData.get('eventId') ? Number(formData.get('eventId')) : null,
        description: formData.get('description') || null,
        notes: formData.get('notes') || null,
      };

      if (expense) {
        await api.updateExpense(expense.id, payload);
        toast('ההוצאה עודכנה', 'success');
      } else {
        const fileInput = document.querySelector('.modal [name="invoice"]');
        const attachment = fileInput ? await readFile(fileInput) : null;
        if (attachment) payload.attachment = attachment;
        const created = await api.createExpense(payload);
        toast(
          `נרשמה הוצאה: ${money(created.expense.amountAgorot)}${attachment ? ' · החשבונית צורפה' : ''}`,
          'success',
        );
      }
      onDone?.();
    },
  });

  // קריאת החשבונית ומילוי מראש של הטופס
  const fileInput = document.querySelector('.modal [name="invoice"]');
  fileInput?.addEventListener('change', async () => {
    const note = document.getElementById('scan-note');
    const file = await readFile(fileInput);
    if (!file) return;
    note.textContent = 'קורא את החשבונית…';
    try {
      const { suggestion } = await api.scanInvoice(file);
      const set = (name, value) => {
        const input = document.querySelector(`.modal [name="${name}"]`);
        if (input && value) input.value = value;
      };
      set('amountShekels', suggestion.amountAgorot ? suggestion.amountAgorot / 100 : '');
      set('expenseDate', suggestion.date ?? '');
      set('invoiceNumber', suggestion.invoiceNumber ?? '');
      set('supplier', suggestion.supplier ?? '');
      note.textContent = suggestion.note;
      note.style.color = suggestion.confidence === 'none' ? 'var(--warning)' : '';
    } catch (error) {
      note.textContent = `לא ניתן היה לקרוא את החשבונית: ${error.message}`;
    }
  });
}

/** צירוף חשבונית להוצאה קיימת. */
function openAttachModal({ expenseId, onDone }) {
  openModal({
    title: 'צירוף חשבונית',
    bodyHtml: `
      <div class="full">
        <label style="font-size:13px;font-weight:600">בחרו קובץ</label>
        <input type="file" name="invoice" accept="application/pdf,image/*" required style="margin-top:6px" />
        <p class="small muted">PDF או תמונה, עד 15MB.</p>
      </div>`,
    submitLabel: 'צירוף',
    onSubmit: async () => {
      const file = await readFile(document.querySelector('.modal [name="invoice"]'));
      if (!file) throw new Error('לא נבחר קובץ');
      await api.attachInvoice(expenseId, file);
      toast('החשבונית צורפה', 'success');
      onDone?.();
    },
  });
}
