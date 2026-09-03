/** מסכי רשימה: התחייבויות, תשלומים, הכנסות, הוראות קבע שוטפות, תזכורות, התראות. */

import { api } from '../api.js';
import { badge, date, dateTime, days, esc, money, number, toneFor } from '../format.js';
import { field, section, selectOptions, statCard, table, toast } from '../ui.js';
import { commitmentTypeOptions, label, organizationOptions, withOrg } from '../state.js';
import { navigate } from '../router.js';
import { openAssignPaymentModal, openPaymentModal } from './paymentForm.js';

// --- התחייבויות -------------------------------------------------------------

export async function renderCommitments(route) {
  const params = route.params;
  const data = await api.commitments(
    withOrg({
      memberSearch: params.memberSearch,
      organizationId: params.organizationId,
      status: params.status,
      fromDate: params.fromDate,
      toDate: params.toDate,
      eventId: params.eventId,
      commitmentTypeId: params.commitmentTypeId,
      minAgeDays: params.minAgeDays,
    }),
  );

  const rows = table(
    [
      { header: 'תאריך', cell: (row) => date(row.commitmentDate) },
      { header: 'חבר', cell: (row) => `<a href="#/members/${row.member.id}">${esc(row.member.name)}</a>` },
      { header: 'סוג', cell: (row) => esc(row.type.name) },
      { header: 'אירוע', cell: (row) => esc(row.event?.name ?? '—') },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'התחייב', className: 'num', cell: (row) => money(row.amountAgorot) },
      { header: 'שולם', className: 'num', cell: (row) => money(row.paidAgorot) },
      { header: 'יתרה', className: 'num', cell: (row) => `<strong>${money(row.balanceAgorot)}</strong>` },
      { header: 'מועד אחרון', cell: (row) => (row.dueDate ? date(row.dueDate) : '—') },
      { header: 'אמצעי מתוכנן', cell: (row) => esc(label('paymentMethods', row.plannedPaymentMethod) || '—') },
      { header: 'סטטוס', cell: (row) => badge(label('commitmentStatuses', row.status), toneFor('commitment', row.status)) },
      { header: 'הערות', cell: (row) => `<span class="small muted">${esc(row.notes ?? '')}</span>` },
      {
        header: '',
        cell: (row) =>
          row.balanceAgorot > 0 && row.status !== 'cancelled'
            ? `<button class="btn small primary" data-pay="${row.id}">תשלום</button>`
            : '',
      },
    ],
    data.items,
    'אין התחייבויות',
  );

  const cards = `
    <div class="card-grid" style="margin:0">
      ${statCard({ title: 'סך ההתחייבויות', amountAgorot: data.totals.amountAgorot, tone: 'neutral', link: '#/commitments' })}
      ${statCard({ title: 'שולם', amountAgorot: data.totals.paidAgorot, tone: 'positive', link: '#/incomes' })}
      ${statCard({ title: 'יתרה', amountAgorot: data.totals.balanceAgorot, tone: 'warning', link: '#/collections?status=outstanding' })}
    </div>`;

  return `
    ${section('סיכום', cards)}
    ${section('התחייבויות', rows, { hint: `${number(data.total)} רשומות`, flush: true })}`;
}

export function bindCommitments(root, reload) {
  root.querySelectorAll('[data-pay]').forEach((button) => {
    button.addEventListener('click', () =>
      openPaymentModal({ commitmentId: Number(button.dataset.pay), onDone: reload }),
    );
  });
}

// --- תשלומים ---------------------------------------------------------------

export async function renderPayments(route) {
  const params = route.params;
  const data = await api.payments(
    withOrg({
      memberSearch: params.memberSearch,
      organizationId: params.organizationId,
      fromDate: params.fromDate,
      toDate: params.toDate,
      unassigned: params.unassigned,
      status: params.status,
    }),
  );

  const filters = `
    <form id="payment-filters" class="filters">
      ${field('חבר', `<input type="search" name="memberSearch" value="${esc(params.memberSearch ?? '')}" />`)}
      ${field('עמותה', `<select name="organizationId">${selectOptions(organizationOptions(), params.organizationId, { placeholder: 'כל העמותות' })}</select>`)}
      ${field('מתאריך', `<input type="date" name="fromDate" value="${esc(params.fromDate ?? '')}" />`)}
      ${field('עד תאריך', `<input type="date" name="toDate" value="${esc(params.toDate ?? '')}" />`)}
      ${field(
        'שיוך',
        `<select name="unassigned">
           <option value="">הכל</option>
           <option value="1"${params.unassigned ? ' selected' : ''}>רק תשלומים שלא שויכו לחבר</option>
         </select>`,
      )}
      <div class="btn-row">
        <button type="submit" class="btn primary">סינון</button>
        <button type="button" class="btn" data-reset>ניקוי</button>
      </div>
    </form>`;

  const rows = table(
    [
      { header: 'תאריך', cell: (row) => date(row.paymentDate) },
      {
        header: 'חבר',
        cell: (row) =>
          row.member
            ? `<a href="#/members/${row.member.id}">${esc(row.member.name)}</a>`
            : '<span class="badge warning">לא שויך</span>',
      },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'סכום', className: 'num', cell: (row) => money(row.amountAgorot) },
      { header: 'אמצעי', cell: (row) => esc(label('paymentMethods', row.method)) },
      { header: 'סטטוס', cell: (row) => badge(label('paymentStatuses', row.status), toneFor('payment', row.status)) },
      {
        header: 'הכנסה',
        cell: (row) =>
          row.incomeId ? '<span class="badge positive">נרשמה</span>' : '<span class="muted">—</span>',
      },
      {
        header: 'קבלה',
        cell: (row) =>
          row.receipt
            ? row.receipt.number
              ? `<a href="#/receipts?receiptNumber=${encodeURIComponent(row.receipt.number)}" class="mono">${esc(row.receipt.number)}</a>`
              : badge(label('receiptStatuses', row.receipt.status), toneFor('receipt', row.receipt.status))
            : '<span class="muted">ללא</span>',
      },
      {
        header: '',
        cell: (row) =>
          row.unassigned ? `<button class="btn small primary" data-assign="${row.id}">שיוך לחבר</button>` : '',
      },
    ],
    data.items,
    'אין תשלומים',
  );

  return `
    ${section('סינון', filters)}
    ${section('תשלומים שהתקבלו בפועל', rows, {
      hint: `סה"כ ${money(data.totals.amountAgorot)} · ${number(data.items.length)} רשומות`,
      flush: true,
    })}`;
}

export function bindPayments(root, reload) {
  const form = root.querySelector('#payment-filters');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    navigate('payments', Object.fromEntries(new FormData(form).entries()));
  });
  form?.querySelector('[data-reset]')?.addEventListener('click', () => navigate('payments', {}));

  root.querySelectorAll('[data-assign]').forEach((button) => {
    button.addEventListener('click', async () => {
      const response = await api.get(`/payments/${button.dataset.assign}`);
      openAssignPaymentModal({ payment: response.payment, onDone: reload });
    });
  });
}

// --- הכנסות ----------------------------------------------------------------

const SOURCE_TONE = { recurring: 'positive', seats: 'neutral', other: 'warning' };

export async function renderIncomes(route) {
  const params = route.params;
  const data = await api.incomes(
    withOrg({
      organizationId: params.organizationId,
      commitmentTypeId: params.commitmentTypeId,
      source: params.source,
      fromDate: params.fromDate,
      toDate: params.toDate,
      receiptStatus: params.receiptStatus,
    }),
  );
  const summary = data.summary;

  // שלושה זרמי הכנסה נפרדים: דמי חבר חודשיים, תשלומי מקומות, וכל השאר.
  const cards = `
    <div class="card-grid" style="margin:0">
      ${statCard({
        title: 'סך ההכנסות',
        amountAgorot: summary.totalAgorot,
        tone: 'neutral',
        hint: `${number(summary.count)} רשומות`,
        link: '#/incomes',
      })}
      ${summary.bySource
        .map((row) =>
          statCard({
            title: `הכנסות ${row.label}`,
            amountAgorot: row.amountAgorot,
            tone: SOURCE_TONE[row.source] ?? 'neutral',
            hint: `${number(row.count)} תשלומים`,
            link: `#/incomes?source=${row.source}`,
          }),
        )
        .join('')}
    </div>`;

  const byType = table(
    [
      { header: 'סוג', cell: (row) => esc(row.label) },
      { header: 'סכום', className: 'num', cell: (row) => money(row.amountAgorot) },
      { header: 'רשומות', className: 'num', cell: (row) => number(row.count) },
      {
        header: '',
        cell: (row) =>
          row.id ? `<a class="btn small" href="#/incomes?commitmentTypeId=${row.id}">הצג</a>` : '',
      },
    ],
    summary.byType,
    'אין נתונים',
  );

  const sourceOptions = [
    { value: '', label: 'כל המקורות' },
    ...summary.bySource.map((row) => ({ value: row.source, label: row.label })),
  ];

  const filters = `
    <form id="income-filters" class="filters">
      ${field('מקור ההכנסה', `<select name="source">${selectOptions(sourceOptions, params.source ?? '')}</select>`)}
      ${field('סוג', `<select name="commitmentTypeId">${selectOptions(commitmentTypeOptions(), params.commitmentTypeId, { placeholder: 'כל הסוגים' })}</select>`)}
      ${field('עמותה', `<select name="organizationId">${selectOptions(organizationOptions(), params.organizationId, { placeholder: 'כל העמותות' })}</select>`)}
      ${field('מתאריך', `<input type="date" name="fromDate" value="${esc(params.fromDate ?? '')}" />`)}
      ${field('עד תאריך', `<input type="date" name="toDate" value="${esc(params.toDate ?? '')}" />`)}
      <div class="btn-row">
        <button type="submit" class="btn primary">סינון</button>
        <button type="button" class="btn" data-reset>ניקוי</button>
      </div>
    </form>`;

  const rows = table(
    [
      { header: 'תאריך', cell: (row) => date(row.incomeDate) },
      {
        header: 'חבר',
        cell: (row) =>
          row.member ? `<a href="#/members/${row.member.id}">${esc(row.member.name)}</a>` : '<span class="muted">ללא שיוך</span>',
      },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'מקור', cell: (row) => badge(row.sourceLabel, SOURCE_TONE[row.source] ?? 'neutral') },
      { header: 'סוג', cell: (row) => esc(row.typeName ?? '—') },
      { header: 'אירוע', cell: (row) => esc(row.eventName ?? '—') },
      { header: 'סכום', className: 'num', cell: (row) => money(row.amountAgorot) },
      { header: 'אמצעי', cell: (row) => esc(label('paymentMethods', row.paymentMethod)) },
      { header: 'נדרשת קבלה', cell: (row) => (row.receipt.required ? 'כן' : 'לא') },
      {
        header: 'מספר קבלה',
        cell: (row) => (row.receipt.number ? `<span class="mono">${esc(row.receipt.number)}</span>` : '—'),
      },
      { header: 'הופקה בתאריך', cell: (row) => date(row.receipt.issuedAt) },
      { header: 'מערכת קבלות', cell: (row) => esc(row.receipt.provider ?? '—') },
      {
        header: 'סטטוס הפקה',
        cell: (row) =>
          badge(label('incomeReceiptStatuses', row.receipt.status), toneFor('receipt', row.receipt.status)),
      },
      {
        header: 'שגיאה',
        cell: (row) => (row.receipt.error ? `<span class="small" style="color:var(--danger)">${esc(row.receipt.error)}</span>` : '—'),
      },
    ],
    data.items,
    'אין הכנסות',
  );

  return `
    ${section('סיכום ההכנסות', cards, { hint: 'לחיצה על כרטיס מסננת את הרשימה' })}
    ${section('לפי סוג', byType, { flush: true })}
    ${section('סינון', filters)}
    ${section('הכנסות בפועל', rows, {
      hint:
        summary.count > data.items.length
          ? `${number(data.items.length)} אחרונות מתוך ${number(summary.count)} · סה"כ ${money(summary.totalAgorot)}`
          : `סה"כ ${money(summary.totalAgorot)} · הכנסה נרשמת רק עם קבלת תשלום בפועל`,
      flush: true,
    })}`;
}

export function bindIncomes(root) {
  const form = root.querySelector('#income-filters');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    navigate('incomes', Object.fromEntries(new FormData(form).entries()));
  });
  form?.querySelector('[data-reset]')?.addEventListener('click', () => navigate('incomes', {}));
}

// --- הוראות קבע ------------------------------------------------------------

/**
 * המסך מציג הוראות קבע **שוטפות** בלבד - חיוב חודשי קבוע ללא סכום סופי.
 * הוראות שמשלמות התחייבות למקום/ריהוט הן דבר אחר לגמרי, יש להן סכום
 * כולל ויתרה, והן מוצגות במסך "מקומות וריהוט".
 */
export async function renderStandingOrders() {
  const data = await api.standingOrders(withOrg({ kind: 'recurring' }));
  const active = data.items.filter((row) => row.status === 'active');
  const monthlyAgorot = active.reduce((sum, row) => sum + row.amountAgorot, 0);

  const cards = `
    <div class="card-grid" style="margin:0">
      ${statCard({
        title: 'גבייה חודשית שוטפת',
        amountAgorot: monthlyAgorot,
        tone: 'positive',
        hint: `${number(active.length)} הוראות פעילות`,
        link: '#/standing-orders',
      })}
      ${statCard({
        title: 'הוראות שאינן פעילות',
        count: data.items.length - active.length,
        tone: data.items.length - active.length > 0 ? 'warning' : 'neutral',
        hint: 'מושהות, שנכשלו או שבוטלו',
        link: '#/standing-orders',
      })}
    </div>`;

  const rows = table(
    [
      { header: 'חבר', cell: (row) => `<a href="#/members/${row.member.id}">${esc(row.member.name)}</a>` },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'סכום חודשי', className: 'num', cell: (row) => money(row.amountAgorot) },
      { header: 'יום חיוב', className: 'num', cell: (row) => number(row.dayOfMonth) },
      { header: 'תחילת ההוראה', cell: (row) => date(row.startDate) },
      { header: 'סטטוס', cell: (row) => badge(label('standingOrderStatuses', row.status), toneFor('standingOrder', row.status)) },
      { header: 'כרטיס', cell: (row) => (row.cardLast4 ? `****${esc(row.cardLast4)} · ${esc(row.cardExpiry ?? '')}` : '—') },
      { header: 'חיוב אחרון', cell: (row) => dateTime(row.lastChargeAt) },
      {
        header: '',
        cell: (row) =>
          row.status === 'active' || row.status === 'failed'
            ? `<button class="btn small primary" data-charge="${row.id}">חיוב חודשי</button>`
            : '',
      },
    ],
    data.items,
    'אין הוראות קבע שוטפות',
  );

  return `
    ${section('סיכום', cards)}
    ${section('הוראות קבע שוטפות', rows, { hint: `${number(data.items.length)} רשומות`, flush: true })}
    <p class="small muted" style="padding:0 4px">
      כאן רק החיוב החודשי הקבוע. תשלומי מקום וריהוט הם התחייבות נפרדת עם סכום כולל ויתרה,
      והם מנוהלים במסך <a href="#/seats">מקומות וריהוט</a>.
    </p>`;
}

export function bindStandingOrders(root, reload) {
  root.querySelectorAll('[data-charge]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api.chargeStandingOrder(Number(button.dataset.charge));
        toast(
          result.payment.status === 'completed'
            ? `החיוב בוצע: ${money(result.payment.amountAgorot)}`
            : `החיוב נכשל: ${result.payment.failureReason ?? 'סיבה לא ידועה'}`,
          result.payment.status === 'completed' ? 'success' : 'error',
        );
        reload();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    });
  });
}

// --- תזכורות ---------------------------------------------------------------

export async function renderNotifications() {
  const data = await api.notifications({});
  const rows = table(
    [
      { header: 'נוצרה', cell: (row) => dateTime(row.createdAt) },
      { header: 'חבר', cell: (row) => `<a href="#/members/${row.member.id}">${esc(row.member.name)}</a>` },
      { header: 'ערוץ', cell: (row) => esc(label('notificationChannels', row.channel)) },
      { header: 'נמען', cell: (row) => esc(row.recipient ?? '—') },
      { header: 'נושא', cell: (row) => esc(row.subject ?? '—') },
      { header: 'סטטוס', cell: (row) => badge(label('notificationStatuses', row.status) || row.status, toneFor('notification', row.status)) },
      { header: 'שגיאה', cell: (row) => `<span class="small muted">${esc(row.errorMessage ?? '')}</span>` },
      { header: '', cell: (row) => `<button class="btn small" data-send="${row.id}">שליחה</button>` },
    ],
    data.items,
    'לא נשלחו תזכורות',
  );

  return `
    ${section('תזכורות לחברים', rows, {
      hint: 'תשתית מוכנה ל-WhatsApp / SMS / Email. ללא Integration פעיל ההודעות נשמרות בתור.',
      flush: true,
    })}`;
}

export function bindNotifications(root, reload) {
  root.querySelectorAll('[data-send]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api.post(`/notifications/${button.dataset.send}/send`);
        toast(
          result.notification.status === 'sent' ? 'ההודעה נשלחה' : `סטטוס: ${result.notification.status}`,
          result.notification.status === 'sent' ? 'success' : 'info',
        );
        reload();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    });
  });
}

// --- התראות מנהל -----------------------------------------------------------

export async function renderAlerts() {
  const open = await api.alerts({ resolved: 'false' });
  const rows = table(
    [
      { header: 'מתי', cell: (row) => dateTime(row.createdAt) },
      {
        header: 'חומרה',
        cell: (row) =>
          badge(
            row.severity === 'error' ? 'שגיאה' : row.severity === 'warning' ? 'אזהרה' : 'מידע',
            row.severity === 'error' ? 'danger' : row.severity === 'warning' ? 'warning' : 'neutral',
          ),
      },
      { header: 'כותרת', cell: (row) => esc(row.title) },
      { header: 'פירוט', cell: (row) => `<span class="small">${esc(row.message ?? '')}</span>` },
      {
        header: '',
        cell: (row) =>
          row.relatedType === 'receipt'
            ? `<div class="btn-row"><button class="btn small primary" data-retry-receipt="${row.relatedId}">הפקה חוזרת</button><button class="btn small" data-resolve="${row.id}">סגירה</button></div>`
            : `<button class="btn small" data-resolve="${row.id}">סגירה</button>`,
      },
    ],
    open.alerts,
    'אין התראות פתוחות',
  );
  return section('התראות למנהל', rows, {
    hint: 'כשל בהפקת קבלה או בחיוב אינו מוחק את התשלום - הוא נרשם כאן לטיפול',
    flush: true,
  });
}

export function bindAlerts(root, reload) {
  root.querySelectorAll('[data-resolve]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api.resolveAlert(Number(button.dataset.resolve));
      reload();
    });
  });
  root.querySelectorAll('[data-retry-receipt]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api.retryReceipt(Number(button.dataset.retryReceipt));
        toast(result.issued ? 'הקבלה הופקה' : `ההפקה נכשלה שוב: ${result.error ?? ''}`, result.issued ? 'success' : 'error');
        reload();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    });
  });
}

// --- דוחות (סעיף 25) --------------------------------------------------------

export async function renderReports() {
  const data = await api.report({});
  const columns = [
    { header: 'עמותה', cell: (row) => (row.organization ? esc(row.organization.name) : '<strong>סה"כ קהילה</strong>') },
    { header: 'התחייבויות', className: 'num', cell: (row) => money(row.committedAgorot) },
    { header: 'נגבה', className: 'num', cell: (row) => money(row.collectedAgorot) },
    { header: 'יתרה', className: 'num', cell: (row) => money(row.outstandingAgorot) },
    { header: 'הכנסות', className: 'num', cell: (row) => money(row.incomeAgorot) },
    { header: 'הוצאות', className: 'num', cell: (row) => money(row.expenseAgorot) },
    {
      header: 'נטו',
      className: 'num',
      cell: (row) =>
        `<strong style="color:${row.netAgorot >= 0 ? 'var(--positive)' : 'var(--danger)'}">${money(row.netAgorot)}</strong>`,
    },
    { header: 'קבלות הופקו', className: 'num', cell: (row) => number(row.receiptsIssued) },
    { header: 'ממתינות', className: 'num', cell: (row) => number(row.receiptsPending) },
  ];

  return `
    ${section('כל עמותה בנפרד', table(columns, data.perOrganization, 'אין עמותות'), {
      hint: 'הנתונים הכספיים של העמותות מופרדים לחלוטין',
      flush: true,
    })}
    ${section('תמונה מאוחדת של כלל פעילות הקהילה', table(columns, [data.combined], ''), { flush: true })}`;
}
