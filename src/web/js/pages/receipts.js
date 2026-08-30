/** מסך "קבלות ומסמכים" (סעיף 24). */

import { api } from '../api.js';
import { badge, date, esc, money, number, toneFor } from '../format.js';
import { field, section, selectOptions, statCard, table, toast } from '../ui.js';
import { label, organizationOptions, state, withOrg } from '../state.js';
import { navigate } from '../router.js';

function filtersForm(params) {
  const statusOptions = [
    { value: '', label: 'כל הסטטוסים' },
    { value: 'issued', label: 'הופקה' },
    { value: 'pending', label: 'ממתין להפקה' },
    { value: 'awaiting_approval', label: 'ממתין לאישור' },
    { value: 'failed', label: 'הפקה נכשלה' },
    { value: 'cancelled', label: 'בוטלה' },
  ];
  const methodOptions = [
    { value: '', label: 'כל האמצעים' },
    ...Object.entries(state.lookups.paymentMethods ?? {}).map(([value, text]) => ({
      value,
      label: text,
    })),
  ];

  return `
    <form id="receipt-filters" class="filters">
      ${field('שם חבר', `<input type="search" name="memberSearch" value="${esc(params.memberSearch ?? '')}" placeholder="שם החבר" />`)}
      ${field('מספר קבלה', `<input type="search" name="receiptNumber" value="${esc(params.receiptNumber ?? '')}" placeholder="12548" />`)}
      ${field('עמותה', `<select name="organizationId">${selectOptions(organizationOptions(), params.organizationId, { placeholder: 'כל העמותות' })}</select>`)}
      ${field('סוג תשלום', `<select name="paymentMethod">${selectOptions(methodOptions, params.paymentMethod ?? '')}</select>`)}
      ${field('סטטוס', `<select name="status">${selectOptions(statusOptions, params.status ?? '')}</select>`)}
      ${field('סכום מ־ (₪)', `<input type="number" name="minAmountShekels" min="0" step="1" value="${esc(params.minAmountShekels ?? '')}" />`)}
      ${field('סכום עד (₪)', `<input type="number" name="maxAmountShekels" min="0" step="1" value="${esc(params.maxAmountShekels ?? '')}" />`)}
      ${field('מתאריך', `<input type="date" name="fromDate" value="${esc(params.fromDate ?? '')}" />`)}
      ${field('עד תאריך', `<input type="date" name="toDate" value="${esc(params.toDate ?? '')}" />`)}
      <div class="btn-row">
        <button type="submit" class="btn primary">חיפוש</button>
        <button type="button" class="btn" data-reset>ניקוי</button>
      </div>
    </form>`;
}

export async function renderReceipts(route) {
  const params = route.params;
  const data = await api.receipts(
    withOrg({
      memberSearch: params.memberSearch,
      receiptNumber: params.receiptNumber,
      organizationId: params.organizationId,
      paymentMethod: params.paymentMethod,
      status: params.status,
      fromDate: params.fromDate,
      toDate: params.toDate,
      minAmountAgorot: params.minAmountShekels ? Number(params.minAmountShekels) * 100 : undefined,
      maxAmountAgorot: params.maxAmountShekels ? Number(params.maxAmountShekels) * 100 : undefined,
    }),
  );

  const cards = `
    <div class="card-grid" style="margin:0">
      ${statCard({ title: 'סכום הקבלות שהופקו', amountAgorot: data.totals.amountAgorot, tone: 'positive', link: '#/receipts?status=issued' })}
      ${statCard({ title: 'הופקו', count: data.totals.issued, tone: 'positive', link: '#/receipts?status=issued' })}
      ${statCard({ title: 'ממתינות להפקה / לאישור', count: data.totals.pending, tone: data.totals.pending ? 'warning' : 'positive', link: '#/receipts?status=pending' })}
      ${statCard({ title: 'כשלים בהפקה', count: data.totals.failed, tone: data.totals.failed ? 'danger' : 'positive', link: '#/receipts?status=failed' })}
    </div>`;

  const receiptsTable = table(
    [
      { header: 'תאריך', cell: (row) => date(row.issuedAt ?? row.paymentDate) },
      {
        header: 'מספר קבלה',
        cell: (row) =>
          row.receiptNumber
            ? `<strong class="mono">${esc(row.receiptNumber)}</strong>`
            : '<span class="muted">טרם הופק</span>',
      },
      {
        header: 'חבר',
        cell: (row) =>
          row.member
            ? `<a href="#/members/${row.member.id}">${esc(row.member.name)}</a>`
            : '<span class="muted">ללא שיוך</span>',
      },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'סוג תשלום', cell: (row) => esc(label('paymentMethods', row.paymentMethod)) },
      { header: 'סוג מסמך', cell: (row) => esc(label('documentTypes', row.documentType)) },
      { header: 'סכום', className: 'num', cell: (row) => money(row.amountAgorot) },
      {
        header: 'סטטוס',
        cell: (row) => {
          const tag = badge(label('receiptStatuses', row.status), toneFor('receipt', row.status));
          return row.errorMessage
            ? `${tag}<div class="small muted" title="${esc(row.errorMessage)}">${esc(row.errorMessage.slice(0, 48))}</div>`
            : tag;
        },
      },
      {
        header: 'פעולות',
        cell: (row) => {
          const buttons = [];
          if (row.status === 'issued') {
            buttons.push(`<a class="btn small" href="/api/receipts/${row.id}/pdf" target="_blank" rel="noopener">PDF</a>`);
          }
          if (row.status === 'awaiting_approval') {
            buttons.push(`<button class="btn small primary" data-approve="${row.id}">אישור והפקה</button>`);
          }
          if (row.status === 'pending' || row.status === 'failed') {
            buttons.push(`<button class="btn small primary" data-retry="${row.id}">נסה שוב</button>`);
          }
          return `<div class="btn-row">${buttons.join('')}</div>`;
        },
      },
    ],
    data.items,
    'לא נמצאו קבלות התואמות לחיפוש',
  );

  return `
    ${section('סיכום קבלות', cards)}
    ${section('חיפוש וסינון', filtersForm(params))}
    ${section('קבלות ומסמכים', receiptsTable, {
      hint: `${number(data.items.length)} רשומות`,
      actions: '<button class="btn small" data-retry-all>הפקה חוזרת לכל הממתינות</button>',
      flush: true,
    })}`;
}

export function bindReceipts(root, reload) {
  const form = root.querySelector('#receipt-filters');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    navigate('receipts', Object.fromEntries(new FormData(form).entries()));
  });
  form?.querySelector('[data-reset]')?.addEventListener('click', () => navigate('receipts', {}));

  const act = async (button, action, successMessage) => {
    button.disabled = true;
    try {
      await action();
      toast(successMessage, 'success');
      reload();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  };

  root.querySelectorAll('[data-retry]').forEach((button) => {
    button.addEventListener('click', () =>
      act(button, () => api.retryReceipt(Number(button.dataset.retry)), 'בוצע ניסיון הפקה חוזר'),
    );
  });

  root.querySelectorAll('[data-approve]').forEach((button) => {
    button.addEventListener('click', () =>
      act(button, () => api.approveReceipt(Number(button.dataset.approve)), 'הקבלה אושרה והופקה'),
    );
  });

  root.querySelector('[data-retry-all]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api.retryAllReceipts(state.organizationId ?? undefined);
      toast(`בוצעו ${result.attempted} ניסיונות: ${result.issued} הופקו, ${result.failed} נכשלו`, 'success');
      reload();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });
}
