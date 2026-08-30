/** רשימת חברים וכרטיס חבר (סעיף 24). */

import { api } from '../api.js';
import { badge, date, days, esc, money, number, toneFor } from '../format.js';
import { field, openModal, section, statCard, table, toast } from '../ui.js';
import { label, withOrg, refreshMembers } from '../state.js';
import { navigate } from '../router.js';
import { openCommitmentModal, openPaymentModal } from './paymentForm.js';

export async function renderMembersList(route) {
  const search = route.params.search ?? '';
  const [membersResponse, debtorsResponse] = await Promise.all([
    api.members({ search }),
    api.debtors(withOrg({})),
  ]);

  // מפת חוב לכל חבר, לצירוף לרשימה.
  const debtByMember = new Map();
  for (const debtor of debtorsResponse.debtors) {
    const current = debtByMember.get(debtor.member.id) ?? 0;
    debtByMember.set(debtor.member.id, current + debtor.outstandingAgorot);
  }

  const rows = table(
    [
      { header: 'שם', cell: (row) => `<a href="#/members/${row.id}"><strong>${esc(row.fullName)}</strong></a>` },
      { header: 'שם לעליות', cell: (row) => esc(row.hebrewName ?? '—') },
      { header: 'טלפון', cell: (row) => esc(row.phone ?? '—') },
      { header: 'אימייל', cell: (row) => esc(row.email ?? '—') },
      { header: 'ערוץ מועדף', cell: (row) => esc(label('notificationChannels', row.preferredChannel) || '—') },
      {
        header: 'חוב פתוח',
        className: 'num',
        cell: (row) => {
          const debt = debtByMember.get(row.id) ?? 0;
          return debt > 0 ? `<span class="badge warning">${money(debt)}</span>` : '<span class="muted">—</span>';
        },
      },
      { header: '', cell: (row) => `<a class="btn small" href="#/members/${row.id}">כרטיס</a>` },
    ],
    membersResponse.items,
    'לא נמצאו חברים',
  );

  const searchForm = `
    <form id="member-search" class="filters">
      ${field('חיפוש', `<input type="search" name="search" value="${esc(search)}" placeholder="שם, טלפון או אימייל" />`)}
      <div class="btn-row"><button type="submit" class="btn primary">חיפוש</button></div>
    </form>`;

  return `
    ${section('חיפוש', searchForm)}
    ${section('חברי הקהילה', rows, { hint: `${number(membersResponse.items.length)} חברים`, flush: true })}`;
}

export function bindMembersList(root) {
  const form = root.querySelector('#member-search');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    navigate('members', Object.fromEntries(new FormData(form).entries()));
  });
}

/** כרטיס חבר מלא. */
export async function renderMemberCard(route) {
  const memberId = Number(route.segments[1]);
  const card = await api.memberCard(memberId, withOrg({}));
  const member = card.member;

  const details = `
    <dl class="kv">
      <dt>שם מלא</dt><dd>${esc(member.fullName)}</dd>
      <dt>שם לעליות</dt><dd>${esc(member.hebrewName ?? '—')}</dd>
      <dt>טלפון</dt><dd>${esc(member.phone ?? '—')}</dd>
      <dt>אימייל</dt><dd>${esc(member.email ?? '—')}</dd>
      <dt>כתובת</dt><dd>${esc(member.address ?? '—')}</dd>
      <dt>ערוץ מועדף</dt><dd>${esc(label('notificationChannels', member.preferredChannel) || '—')}</dd>
    </dl>`;

  const totals = `
    <div class="card-grid" style="margin:0">
      ${statCard({ title: 'סך התחייבויות', amountAgorot: card.totals.committedAgorot, tone: 'neutral', link: `#/members/${memberId}` })}
      ${statCard({ title: 'שולם בפועל', amountAgorot: card.totals.paidAgorot, tone: 'positive', link: `#/members/${memberId}` })}
      ${statCard({ title: 'יתרה לתשלום', amountAgorot: card.totals.outstandingAgorot, tone: card.totals.outstandingAgorot > 0 ? 'warning' : 'positive', link: `#/members/${memberId}` })}
      ${statCard({ title: 'קבלות שהופקו', count: card.totals.receiptsIssued, tone: 'neutral', link: `#/receipts?memberId=${memberId}` })}
    </div>`;

  const balancesTable = table(
    [
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'התחייב', className: 'num', cell: (row) => money(row.committedAgorot) },
      { header: 'שולם', className: 'num', cell: (row) => money(row.paidAgorot) },
      { header: 'יתרה', className: 'num', cell: (row) => `<strong>${money(row.outstandingAgorot)}</strong>` },
      { header: 'התחייבויות פתוחות', className: 'num', cell: (row) => number(row.openCommitments) },
      { header: 'חוב ותיק', className: 'num', cell: (row) => (row.oldestDebtDays ? days(row.oldestDebtDays) : '—') },
      {
        header: '',
        cell: (row) =>
          row.outstandingAgorot > 0
            ? `<button class="btn small" data-remind data-org="${row.organization.id}">תזכורת</button>`
            : '',
      },
    ],
    card.balancesByOrganization,
    'אין פעילות כספית',
  );

  const commitmentsTable = table(
    [
      { header: 'תאריך', cell: (row) => date(row.commitmentDate) },
      { header: 'סוג', cell: (row) => esc(row.type.name) },
      { header: 'אירוע', cell: (row) => esc(row.event?.name ?? '—') },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'סכום', className: 'num', cell: (row) => money(row.amountAgorot) },
      { header: 'שולם', className: 'num', cell: (row) => money(row.paidAgorot) },
      { header: 'יתרה', className: 'num', cell: (row) => money(row.balanceAgorot) },
      { header: 'סטטוס', cell: (row) => badge(label('commitmentStatuses', row.status), toneFor('commitment', row.status)) },
      {
        header: '',
        cell: (row) =>
          row.balanceAgorot > 0 && row.status !== 'cancelled'
            ? `<button class="btn small primary" data-pay="${row.id}">תשלום</button>`
            : '',
      },
    ],
    card.commitments,
    'אין התחייבויות',
  );

  // סעיף 24: "01/08/2026 – הוראת קבע – 250 ₪ – קבלה 12548"
  const receiptsTable = table(
    [
      { header: 'תאריך', cell: (row) => date(row.issuedAt ?? row.paymentDate) },
      { header: 'סוג תשלום', cell: (row) => esc(row.commitmentTypeName ?? label('paymentMethods', row.paymentMethod)) },
      { header: 'סכום', className: 'num', cell: (row) => money(row.amountAgorot) },
      {
        header: 'קבלה',
        cell: (row) => (row.receiptNumber ? `<strong class="mono">${esc(row.receiptNumber)}</strong>` : '—'),
      },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'סטטוס', cell: (row) => badge(label('receiptStatuses', row.status), toneFor('receipt', row.status)) },
      {
        header: '',
        cell: (row) =>
          row.status === 'issued'
            ? `<a class="btn small" href="/api/receipts/${row.id}/pdf" target="_blank" rel="noopener">PDF</a>`
            : '',
      },
    ],
    card.receipts,
    'לא הופקו קבלות עבור החבר',
  );

  const paymentsTable = table(
    [
      { header: 'תאריך', cell: (row) => date(row.paymentDate) },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'סכום', className: 'num', cell: (row) => money(row.amountAgorot) },
      { header: 'אמצעי', cell: (row) => esc(label('paymentMethods', row.method)) },
      { header: 'סטטוס', cell: (row) => badge(label('paymentStatuses', row.status), toneFor('payment', row.status)) },
    ],
    card.payments,
    'אין תשלומים',
  );

  const standingOrdersTable = table(
    [
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      { header: 'סכום', className: 'num', cell: (row) => money(row.amountAgorot) },
      { header: 'יום חיוב', className: 'num', cell: (row) => number(row.dayOfMonth) },
      { header: 'סטטוס', cell: (row) => badge(label('standingOrderStatuses', row.status), toneFor('standingOrder', row.status)) },
    ],
    card.standingOrders,
    'אין הוראות קבע',
  );

  return `
    ${section(member.fullName, totals, {
      actions: `
        <button class="btn small primary" data-new-commitment>התחייבות חדשה</button>
        <button class="btn small" data-new-payment>רישום תשלום</button>`,
    })}
    ${section('פרטי החבר', details)}
    ${section('יתרות לפי עמותה', balancesTable, { flush: true })}
    ${section('התחייבויות', commitmentsTable, { flush: true })}
    ${section('קבלות שהופקו עבור החבר', receiptsTable, { flush: true })}
    ${section('תשלומים', paymentsTable, { flush: true })}
    ${section('הוראות קבע', standingOrdersTable, { flush: true })}`;
}

export function bindMemberCard(root, reload, route) {
  const memberId = Number(route.segments[1]);

  root.querySelector('[data-new-commitment]')?.addEventListener('click', () =>
    openCommitmentModal({ memberId, onDone: reload }),
  );
  root.querySelector('[data-new-payment]')?.addEventListener('click', () =>
    openPaymentModal({ memberId, onDone: reload }),
  );
  root.querySelectorAll('[data-pay]').forEach((button) => {
    button.addEventListener('click', () =>
      openPaymentModal({ commitmentId: Number(button.dataset.pay), onDone: reload }),
    );
  });
  root.querySelectorAll('[data-remind]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api.sendDebtReminder({
          memberId,
          organizationId: Number(button.dataset.org),
        });
        toast(
          result.notification.status === 'sent'
            ? 'התזכורת נשלחה'
            : 'התזכורת נוספה לתור השליחה',
          'success',
        );
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
  });
}

/** יצירת חבר חדש. */
export function openMemberModal(onDone) {
  const channelOptions = ['whatsapp', 'sms', 'email'];
  openModal({
    title: 'חבר קהילה חדש',
    bodyHtml: `
      <div class="form-grid">
        ${field('שם פרטי', '<input type="text" name="firstName" required />')}
        ${field('שם משפחה', '<input type="text" name="lastName" required />')}
        ${field('שם לעליות', '<input type="text" name="hebrewName" placeholder="יעקב בן יצחק" />')}
        ${field('טלפון', '<input type="tel" name="phone" placeholder="050-0000000" />')}
        ${field('אימייל', '<input type="email" name="email" />')}
        ${field(
          'ערוץ מועדף',
          `<select name="preferredChannel">
             <option value="">לא נקבע</option>
             ${channelOptions.map((value) => `<option value="${value}">${label('notificationChannels', value)}</option>`).join('')}
           </select>`,
        )}
        ${field('כתובת', '<input type="text" name="address" />', { className: 'full' })}
      </div>`,
    submitLabel: 'הוספת חבר',
    onSubmit: async (formData) => {
      await api.createMember(Object.fromEntries(formData.entries()));
      await refreshMembers();
      toast('החבר נוסף בהצלחה', 'success');
      onDone?.();
    },
  });
}
