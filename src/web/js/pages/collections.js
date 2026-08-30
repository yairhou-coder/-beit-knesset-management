/** מסך "גבייה וחובות" (סעיף 23). */

import { api } from '../api.js';
import { badge, date, days, esc, money, number, toneFor } from '../format.js';
import { field, progressBar, section, selectOptions, statCard, table, toast } from '../ui.js';
import {
  commitmentTypeOptions,
  eventOptions,
  label,
  organizationOptions,
  state,
  withOrg,
} from '../state.js';
import { navigate } from '../router.js';
import { openPaymentModal } from './paymentForm.js';

/** טופס הסינון: חבר, סכום, סטטוס, תאריך, אירוע, עמותה, סוג התחייבות. */
function filtersForm(params) {
  const statusOptions = [
    { value: 'outstanding', label: 'עם יתרה פתוחה' },
    { value: 'open', label: 'פתוח' },
    { value: 'partially_paid', label: 'שולם חלקית' },
    { value: 'paid', label: 'שולם במלואו' },
    { value: 'cancelled', label: 'בוטל' },
  ];
  const ageOptions = [
    { value: '', label: 'הכל' },
    { value: '30', label: 'מעל 30 יום' },
    { value: '60', label: 'מעל 60 יום' },
    { value: '90', label: 'מעל 90 יום' },
  ];

  return `
    <form id="collection-filters" class="filters">
      ${field('חבר', `<input type="search" name="memberSearch" value="${esc(params.memberSearch ?? '')}" placeholder="שם החבר" />`)}
      ${field('עמותה', `<select name="organizationId">${selectOptions(organizationOptions(), params.organizationId, { placeholder: 'כל העמותות' })}</select>`)}
      ${field('סוג התחייבות', `<select name="commitmentTypeId">${selectOptions(commitmentTypeOptions(), params.commitmentTypeId, { placeholder: 'כל הסוגים' })}</select>`)}
      ${field('אירוע / שבת / חג', `<select name="eventId">${selectOptions(eventOptions(), params.eventId, { placeholder: 'כל האירועים' })}</select>`)}
      ${field('סטטוס', `<select name="status">${selectOptions(statusOptions, params.status ?? 'outstanding')}</select>`)}
      ${field('גיל החוב', `<select name="minAgeDays">${selectOptions(ageOptions, params.minAgeDays ?? '')}</select>`)}
      ${field('סכום מ־ (₪)', `<input type="number" name="minAmountShekels" min="0" step="1" value="${esc(params.minAmountShekels ?? '')}" />`)}
      ${field('סכום עד (₪)', `<input type="number" name="maxAmountShekels" min="0" step="1" value="${esc(params.maxAmountShekels ?? '')}" />`)}
      ${field('מתאריך', `<input type="date" name="fromDate" value="${esc(params.fromDate ?? '')}" />`)}
      ${field('עד תאריך', `<input type="date" name="toDate" value="${esc(params.toDate ?? '')}" />`)}
      <div class="btn-row">
        <button type="submit" class="btn primary">סינון</button>
        <button type="button" class="btn" data-reset>ניקוי</button>
      </div>
    </form>`;
}

function debtorsTable(debtors) {
  return table(
    [
      {
        header: 'חבר',
        cell: (row) => `<a href="#/members/${row.member.id}">${esc(row.member.name)}</a>`,
      },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'חוב', className: 'num', cell: (row) => `<strong>${money(row.outstandingAgorot)}</strong>` },
      { header: 'מתוך', className: 'num', cell: (row) => money(row.committedAgorot) },
      {
        header: 'התקדמות',
        cell: (row) => progressBar(row.paidAgorot, row.committedAgorot),
      },
      { header: 'התחייבויות', className: 'num', cell: (row) => number(row.openCommitments) },
      {
        header: 'החוב פתוח',
        className: 'num',
        cell: (row) =>
          row.oldestDebtDays >= 60
            ? `<span class="badge danger">${days(row.oldestDebtDays)}</span>`
            : row.oldestDebtDays >= 30
              ? `<span class="badge warning">${days(row.oldestDebtDays)}</span>`
              : days(row.oldestDebtDays),
      },
      {
        header: 'מועד אחרון',
        cell: (row) =>
          row.nearestDueDate
            ? `<span class="${row.overdue ? 'badge danger' : ''}">${date(row.nearestDueDate)}</span>`
            : '—',
      },
      {
        header: 'פעולות',
        cell: (row) => `
          <div class="btn-row">
            <button class="btn small" data-remind data-member="${row.member.id}" data-org="${row.organization.id}">תזכורת</button>
            <a class="btn small" href="#/members/${row.member.id}">כרטיס</a>
          </div>`,
      },
    ],
    debtors,
    'אין חברים עם חוב פתוח',
  );
}

function commitmentsTable(commitments) {
  return table(
    [
      {
        header: 'חבר',
        cell: (row) => `<a href="#/members/${row.member.id}">${esc(row.member.name)}</a>`,
      },
      { header: 'תאריך', cell: (row) => date(row.commitmentDate) },
      { header: 'סוג', cell: (row) => esc(row.type.name) },
      { header: 'אירוע', cell: (row) => esc(row.event?.name ?? '—') },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'התחייב', className: 'num', cell: (row) => money(row.amountAgorot) },
      { header: 'שולם', className: 'num', cell: (row) => money(row.paidAgorot) },
      {
        header: 'יתרה',
        className: 'num',
        cell: (row) => `<strong>${money(row.balanceAgorot)}</strong>`,
      },
      {
        header: 'מועד אחרון',
        cell: (row) =>
          row.dueDate
            ? row.isOverdue
              ? `<span class="badge danger">${date(row.dueDate)}</span>`
              : date(row.dueDate)
            : '—',
      },
      {
        header: 'גיל',
        className: 'num',
        cell: (row) => (row.ageDays ? days(row.ageDays) : '—'),
      },
      {
        header: 'סטטוס',
        cell: (row) => badge(label('commitmentStatuses', row.status), toneFor('commitment', row.status)),
      },
      {
        header: 'פעולות',
        cell: (row) =>
          row.balanceAgorot > 0 && row.status !== 'cancelled'
            ? `<button class="btn small primary" data-pay="${row.id}">רישום תשלום</button>`
            : '',
      },
    ],
    commitments,
    'לא נמצאו התחייבויות התואמות לסינון',
  );
}

export async function renderCollections(route) {
  const params = route.params;
  const query = withOrg({
    memberSearch: params.memberSearch,
    organizationId: params.organizationId,
    commitmentTypeId: params.commitmentTypeId,
    eventId: params.eventId,
    status: params.status ?? 'outstanding',
    minAgeDays: params.minAgeDays,
    fromDate: params.fromDate,
    toDate: params.toDate,
    minAmountAgorot: params.minAmountShekels ? Number(params.minAmountShekels) * 100 : undefined,
    maxAmountAgorot: params.maxAmountShekels ? Number(params.maxAmountShekels) * 100 : undefined,
  });

  const data = await api.collections(query);
  const summary = data.summary;

  const cards = `
    <div class="card-grid" style="margin:0">
      ${statCard({ title: 'סך החובות הפתוחים', amountAgorot: summary.outstandingAgorot, tone: 'warning', link: '#/collections?status=outstanding' })}
      ${statCard({ title: 'חברים עם חוב', count: summary.debtorCount, tone: 'neutral', link: '#/collections?status=outstanding' })}
      ${statCard({ title: 'התחייבויות חדשות', count: summary.openCommitmentCount, hint: 'טרם שולמו כלל', tone: 'neutral', link: '#/collections?status=open' })}
      ${statCard({ title: 'שולמו חלקית', count: summary.partiallyPaidCount, tone: 'warning', link: '#/collections?status=partially_paid' })}
      ${statCard({ title: 'שולמו במלואן', count: summary.paidCount, tone: 'positive', link: '#/collections?status=paid' })}
      ${statCard({ title: 'אחוז גבייה', count: `${summary.collectionRate}%`, hint: 'מתוך סך ההתחייבויות', tone: 'neutral', link: '#/collections' })}
    </div>`;

  const breakdown = (rows, param, title) =>
    section(
      title,
      table(
        [
          { header: 'שם', cell: (row) => esc(row.label) },
          { header: 'יתרה', className: 'num', cell: (row) => money(row.outstandingAgorot) },
          { header: 'חברים', className: 'num', cell: (row) => number(row.memberCount) },
          {
            header: '',
            cell: (row) => (row.id ? `<a class="btn small" href="#/collections?${param}=${row.id}">הצג</a>` : ''),
          },
        ],
        rows.filter((row) => row.outstandingAgorot > 0),
        'אין חובות',
      ),
      { flush: true },
    );

  return `
    ${section('סיכום גבייה', cards)}
    ${section('סינון', filtersForm({ ...params, ...(state.organizationId && !params.organizationId ? { organizationId: state.organizationId } : {}) }))}
    ${section('מי חייב כסף', debtorsTable(data.debtors), {
      hint: `${number(data.debtors.length)} חברים`,
      actions: '<button class="btn small" data-remind-all>שליחת תזכורות לכולם</button>',
      flush: true,
    })}
    ${section('התחייבויות', commitmentsTable(data.commitments), {
      hint: `${number(data.commitments.length)} רשומות`,
      flush: true,
    })}
    <div class="grid-2">
      ${breakdown(data.byOrganization, 'organizationId', 'חובות לפי עמותה')}
      ${breakdown(data.byEvent, 'eventId', 'חובות לפי שבת / חג / אירוע')}
      ${breakdown(data.byType, 'commitmentTypeId', 'חובות לפי סוג')}
    </div>`;
}

/** מחבר את מאזיני האירועים לאחר ההרכבה ל-DOM. */
export function bindCollections(root, reload) {
  const form = root.querySelector('#collection-filters');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    navigate('collections', data);
  });
  form?.querySelector('[data-reset]')?.addEventListener('click', () => {
    navigate('collections', {});
  });

  root.querySelectorAll('[data-pay]').forEach((button) => {
    button.addEventListener('click', () => {
      openPaymentModal({ commitmentId: Number(button.dataset.pay), onDone: reload });
    });
  });

  root.querySelectorAll('[data-remind]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api.sendDebtReminder({
          memberId: Number(button.dataset.member),
          organizationId: Number(button.dataset.org),
        });
        const status = result.notification.status;
        toast(
          status === 'sent'
            ? 'התזכורת נשלחה'
            : status === 'skipped'
              ? `התזכורת דולגה: ${result.notification.errorMessage ?? 'אין פרטי קשר'}`
              : 'התזכורת נוספה לתור השליחה (אין עדיין Integration פעיל)',
          status === 'sent' ? 'success' : 'info',
        );
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
  });

  root.querySelector('[data-remind-all]')?.addEventListener('click', async () => {
    const organizationId = state.organizationId ?? state.organizations[0]?.id;
    if (!organizationId) return;
    try {
      const result = await api.sendDebtRemindersBulk({ organizationId });
      toast(
        `נוצרו ${result.queued} תזכורות (נשלחו ${result.sent}, בתור ${result.queued - result.sent - result.skipped - result.failed}, דולגו ${result.skipped})`,
        'success',
      );
      reload();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}
