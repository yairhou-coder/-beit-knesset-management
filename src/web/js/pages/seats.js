/**
 * מסך מקומות וריהוט.
 *
 * נפרד לחלוטין ממסך הוראות הקבע: כאן כל שורה היא **התחייבות** של חבר
 * לסכום כולל - כמה התחייב, מתי התחיל לשלם, כמה כבר שילם, ומה נותר.
 * הוראת הקבע, אם קיימת, היא רק אמצעי התשלום ולא העיקר.
 */

import { api } from '../api.js';
import { badge, date, esc, money, number } from '../format.js';
import { field, openModal, progressBar, section, selectOptions, statCard, table, toast } from '../ui.js';
import { memberOptions, organizationOptions, state, withOrg } from '../state.js';
import { navigate } from '../router.js';
import { openPaymentModal } from './paymentForm.js';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function methodOptions() {
  return Object.entries(state.lookups.paymentMethods ?? {}).map(([value, text]) => ({
    value,
    label: text,
  }));
}

const MODE_TONE = {
  standing_order: 'neutral',
  paid_upfront: 'positive',
  manual: 'warning',
};

export async function renderSeats(route) {
  const params = route.params;
  const data = await api.seats(
    withOrg({
      memberSearch: params.memberSearch,
      organizationId: params.organizationId,
      state: params.state,
      paymentMode: params.paymentMode,
    }),
  );
  const summary = data.summary;

  const cards = `
    <div class="card-grid" style="margin:0">
      ${statCard({
        title: 'סך ההתחייבויות',
        amountAgorot: summary.committedAgorot,
        count: summary.count,
        tone: 'neutral',
        hint: `${number(summary.count)} התחייבויות`,
        link: '#/seats',
      })}
      ${statCard({
        title: 'שולם עד היום',
        amountAgorot: summary.paidAgorot,
        tone: 'positive',
        hint: `${number(summary.settledCount)} סיימו לשלם`,
        link: '#/seats?state=paid',
      })}
      ${statCard({
        title: 'יתרה לגבייה',
        amountAgorot: summary.balanceAgorot,
        tone: 'warning',
        hint: `${number(summary.inProgressCount)} באמצע תשלומים`,
        link: '#/seats?state=outstanding',
      })}
      ${statCard({
        title: 'צפי גבייה חודשי',
        amountAgorot: summary.monthlyExpectedAgorot,
        tone: 'neutral',
        hint: 'מהוראות הקבע הפעילות של המקומות',
        link: '#/seats?paymentMode=standing_order',
      })}
    </div>`;

  const modeRows = table(
    [
      { header: 'אופן תשלום', cell: (row) => esc(row.label) },
      { header: 'חברים', className: 'num', cell: (row) => number(row.count) },
      { header: 'יתרה', className: 'num', cell: (row) => money(row.balanceAgorot) },
      {
        header: '',
        cell: (row) => `<a class="small" href="#/seats?paymentMode=${row.mode}">הצגה</a>`,
      },
    ],
    summary.byMode.filter((row) => row.count > 0),
    'אין נתונים',
  );

  const filters = `
    <form id="seat-filters" class="filters">
      ${field('חבר', `<input type="search" name="memberSearch" value="${esc(params.memberSearch ?? '')}" placeholder="שם או טלפון" />`)}
      ${field('עמותה', `<select name="organizationId">${selectOptions(organizationOptions(), params.organizationId, { placeholder: 'כל העמותות' })}</select>`)}
      ${field(
        'מצב',
        `<select name="state">
           <option value="">הכל</option>
           <option value="outstanding"${params.state === 'outstanding' ? ' selected' : ''}>נותרה יתרה</option>
           <option value="paid"${params.state === 'paid' ? ' selected' : ''}>שולם במלואו</option>
         </select>`,
      )}
      ${field(
        'אופן תשלום',
        `<select name="paymentMode">
           <option value="">הכל</option>
           <option value="standing_order"${params.paymentMode === 'standing_order' ? ' selected' : ''}>הוראת קבע</option>
           <option value="paid_upfront"${params.paymentMode === 'paid_upfront' ? ' selected' : ''}>שולם מראש</option>
           <option value="manual"${params.paymentMode === 'manual' ? ' selected' : ''}>תשלומים ידניים</option>
         </select>`,
      )}
      <div class="btn-row">
        <button type="submit" class="btn primary">סינון</button>
        <button type="button" class="btn" data-reset>ניקוי</button>
      </div>
    </form>`;

  const rows = table(
    [
      {
        header: 'חבר',
        cell: (row) => `<a href="#/members/${row.member.id}">${esc(row.member.name)}</a>`,
      },
      { header: 'עמותה', cell: (row) => esc(row.organization.name) },
      {
        header: 'התחייב',
        className: 'num',
        cell: (row) => `<strong>${money(row.amountAgorot)}</strong>`,
      },
      {
        header: 'תשלום חודשי',
        className: 'num',
        cell: (row) => (row.instalmentAgorot ? money(row.instalmentAgorot) : '—'),
      },
      {
        header: 'תשלומים',
        className: 'num',
        cell: (row) =>
          row.instalmentsCount
            ? `${number(row.instalmentsPaid)} / ${number(row.instalmentsCount)}`
            : number(row.instalmentsPaid),
      },
      { header: 'תשלום ראשון', cell: (row) => (row.firstPaymentDate ? date(row.firstPaymentDate) : '—') },
      { header: 'יום חיוב', className: 'num', cell: (row) => (row.dayOfMonth ? number(row.dayOfMonth) : '—') },
      { header: 'חיוב הבא', cell: (row) => (row.nextChargeDate ? date(row.nextChargeDate) : '—') },
      { header: 'שולם', className: 'num', cell: (row) => money(row.paidAgorot) },
      {
        header: 'יתרה',
        className: 'num',
        cell: (row) =>
          row.balanceAgorot > 0
            ? `<strong>${money(row.balanceAgorot)}</strong>`
            : '<span class="badge positive">שולם</span>',
      },
      { header: 'התקדמות', cell: (row) => progressBar(row.paidAgorot, row.amountAgorot) },
      {
        header: 'אופן תשלום',
        cell: (row) => badge(row.paymentModeLabel, MODE_TONE[row.paymentMode] ?? 'neutral'),
      },
      {
        header: '',
        cell: (row) =>
          row.balanceAgorot > 0
            ? `<button class="btn small primary" data-pay="${row.commitmentId}">תשלום</button>`
            : '',
      },
    ],
    data.items,
    'אין עדיין התחייבויות למקום/ריהוט',
  );

  return `
    ${section('סיכום מקומות וריהוט', cards)}
    ${section('לפי אופן תשלום', modeRows, { hint: `${number(summary.notStartedCount)} טרם שילמו דבר` })}
    ${section('סינון', filters)}
    ${section('התחייבויות מקום וריהוט', rows, {
      hint: `${number(data.items.length)} רשומות`,
      flush: true,
    })}
    <p class="small muted" style="padding:0 4px">
      מסך זה נפרד מהוראות הקבע השוטפות. הוראת קבע שוטפת היא חיוב חודשי קבוע ללא סכום סופי;
      מקום וריהוט הוא סכום שהחבר התחייב לו, ולכן יש לו יתרה.
    </p>`;
}

export function bindSeats(root, reload) {
  const form = root.querySelector('#seat-filters');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    navigate('seats', Object.fromEntries(new FormData(form).entries()));
  });
  form?.querySelector('[data-reset]')?.addEventListener('click', () => navigate('seats', {}));

  root.querySelectorAll('[data-pay]').forEach((button) => {
    button.addEventListener('click', () =>
      openPaymentModal({ commitmentId: Number(button.dataset.pay), onDone: reload }),
    );
  });
}

/**
 * טופס התחייבות מקום/ריהוט.
 *
 * שלוש דרכי התשלום שהקהילה משתמשת בהן בפועל, ולכן הטופס מציג שדות
 * שונים לכל אחת ולא מבקש מידע שאינו רלוונטי.
 */
export function openSeatModal({ memberId, onDone }) {
  const orgId = state.organizationId ?? state.organizations[0]?.id;

  const bodyHtml = `
    <div class="form-grid">
      ${field('חבר', `<select name="memberId" required>${selectOptions(memberOptions(), memberId, { placeholder: 'בחרו חבר' })}</select>`)}
      ${field('עמותה', `<select name="organizationId" required>${selectOptions(organizationOptions(), orgId)}</select>`)}
      ${field(
        'סכום ההתחייבות (₪)',
        `<input type="number" name="amountShekels" min="0.01" step="0.01" required placeholder="20000" />`,
      )}
      ${field('תאריך ההתחייבות', `<input type="date" name="commitmentDate" value="${todayIso()}" required />`)}
      ${field(
        'אופן תשלום',
        `<select name="paymentMode">
           <option value="standing_order" selected>תשלומים בהוראת קבע</option>
           <option value="paid_upfront">שולם במלואו מראש</option>
           <option value="manual">תשלומים ידניים, ללא הוראת קבע</option>
         </select>`,
        { className: 'full' },
      )}
    </div>

    <div class="form-grid" data-when="standing_order">
      ${field('מספר תשלומים', `<input type="number" name="instalmentsCount" min="1" step="1" placeholder="40" />`)}
      ${field('סכום כל תשלום (₪)', `<input type="number" name="instalmentShekels" min="0.01" step="0.01" placeholder="500" />`)}
      ${field('תאריך התשלום הראשון', `<input type="date" name="firstPaymentDate" value="${todayIso()}" />`)}
      ${field('יום החיוב בחודש', `<input type="number" name="dayOfMonth" min="1" max="28" placeholder="לפי תאריך התשלום הראשון" />`)}
      <p class="small muted full">
        אפשר למלא מספר תשלומים או סכום חודשי - המערכת משלימה את השני.
        כל חיוב מקטין את היתרה, וההוראה מסתיימת מאליה כשההתחייבות שולמה.
      </p>
    </div>

    <div class="form-grid" data-when="paid_upfront" hidden>
      ${field('אמצעי התשלום', `<select name="paidMethod">${selectOptions(methodOptions(), 'cash')}</select>`)}
      ${field('תאריך התשלום', `<input type="date" name="paidDate" value="${todayIso()}" />`)}
      <p class="small muted full">
        התשלום המלא יירשם מיד, ההכנסה תיווצר וקבלה תופק לפי הגדרת העמותה.
      </p>
    </div>

    <div class="form-grid" data-when="manual" hidden>
      <p class="small muted full">
        ההתחייבות תירשם עם יתרה מלאה. כל תשלום שיתקבל יירשם ידנית ויקטין את היתרה.
      </p>
    </div>

    <div class="form-grid">
      ${field('הערות', `<textarea name="notes" placeholder="למשל: 2 מקומות בשורה שלישית"></textarea>`, { className: 'full' })}
    </div>`;

  openModal({
    title: 'התחייבות מקום/ריהוט',
    bodyHtml,
    submitLabel: 'יצירת ההתחייבות',
    onSubmit: async (formData) => {
      const mode = formData.get('paymentMode');
      const payload = {
        memberId: Number(formData.get('memberId')),
        organizationId: Number(formData.get('organizationId')),
        amountShekels: formData.get('amountShekels'),
        commitmentDate: formData.get('commitmentDate'),
        paymentMode: mode,
        notes: formData.get('notes') || null,
      };

      if (mode === 'standing_order') {
        const count = formData.get('instalmentsCount');
        const instalment = formData.get('instalmentShekels');
        if (!count && !instalment) {
          throw new Error('יש למלא מספר תשלומים או סכום חודשי');
        }
        if (count) payload.instalmentsCount = Number(count);
        if (instalment) payload.instalmentShekels = instalment;
        payload.firstPaymentDate = formData.get('firstPaymentDate') || null;
        if (formData.get('dayOfMonth')) payload.dayOfMonth = Number(formData.get('dayOfMonth'));
      } else if (mode === 'paid_upfront') {
        payload.paidMethod = formData.get('paidMethod');
        payload.paidDate = formData.get('paidDate') || null;
      }

      const result = await api.createSeatCommitment(payload);
      const seat = result.commitment;
      toast(
        `נרשמה התחייבות על ${money(seat.amountAgorot)} עבור ${seat.member.name} · יתרה ${money(seat.balanceAgorot)}`,
        'success',
      );
      onDone?.();
    },
  });

  // הצגת השדות הרלוונטיים בלבד לאופן התשלום שנבחר.
  const modal = document.querySelector('.modal');
  const modeSelect = modal?.querySelector('[name="paymentMode"]');
  const applyMode = () => {
    modal?.querySelectorAll('[data-when]').forEach((block) => {
      block.hidden = block.dataset.when !== modeSelect.value;
    });
  };
  modeSelect?.addEventListener('change', applyMode);
  applyMode();
}
