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
        title: 'שולם עד היום',
        amountAgorot: summary.paidAgorot,
        tone: 'positive',
        hint: `${number(summary.count)} התחייבויות`,
        link: '#/seats',
      })}
      ${statCard({
        title: 'סך ההתחייבויות הידועות',
        amountAgorot: summary.committedAgorot,
        tone: 'neutral',
        hint:
          summary.unknownAmountCount > 0
            ? `לא כולל ${number(summary.unknownAmountCount)} שסכומם טרם הוזן`
            : 'כל הסכומים הוזנו',
        link: '#/seats',
      })}
      ${statCard({
        title: 'יתרה לגבייה',
        amountAgorot: summary.balanceAgorot,
        tone: 'warning',
        hint:
          summary.unknownAmountCount > 0
            ? 'חלקית - חסרים סכומים'
            : `${number(summary.inProgressCount)} באמצע תשלומים`,
        link: '#/seats?state=outstanding',
      })}
      ${statCard({
        title: 'סכום כולל טרם הוזן',
        count: summary.unknownAmountCount,
        tone: summary.unknownAmountCount > 0 ? 'warning' : 'positive',
        hint: `שולם עד היום ${money(summary.unknownAmountPaidAgorot)}`,
        link: '#/seats?state=unknown',
      })}
    </div>
    <p class="small muted" style="padding:4px">
      צפי גבייה חודשי מהוראות הקבע הפעילות של המקומות:
      <strong>${money(summary.monthlyExpectedAgorot)}</strong>
    </p>`;

  const modeRows = table(
    [
      { header: 'אופן תשלום', cell: (row) => esc(row.label) },
      { header: 'חברים', className: 'num', cell: (row) => number(row.count) },
      {
        header: 'יתרה ידועה',
        className: 'num',
        cell: (row) =>
          row.unknownAmountCount === row.count
            ? '<span class="muted">—</span>'
            : money(row.balanceAgorot),
      },
      {
        header: 'ללא סכום',
        className: 'num',
        cell: (row) =>
          row.unknownAmountCount > 0
            ? `<span class="badge warning">${number(row.unknownAmountCount)}</span>`
            : '<span class="muted">—</span>',
      },
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
           <option value="unknown"${params.state === 'unknown' ? ' selected' : ''}>סכום כולל טרם הוזן</option>
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
        // סכום שלא הוזן מוצג ככזה. מספר משוער היה נראה בדיוק כמו אמיתי.
        cell: (row) =>
          row.amountConfirmed
            ? `<strong>${money(row.amountAgorot)}</strong>`
            : `<button class="btn small" data-edit="${row.commitmentId}">הזנת סכום</button>`,
      },
      {
        header: 'תשלום חודשי',
        className: 'num',
        cell: (row) => (row.instalmentAgorot ? money(row.instalmentAgorot) : '—'),
      },
      {
        header: 'תשלומים',
        className: 'num',
        // "20 מתוך 30" ולא "20 / 30": בטקסט מימין לשמאל שני מספרים משני
        // צדי לוכסן מתהפכים בתצוגה, ו-20 מתוך 30 נקרא כ-30 מתוך 20.
        cell: (row) =>
          row.instalmentsCount
            ? `${number(row.instalmentsPaid)} מתוך ${number(row.instalmentsCount)}`
            : `${number(row.instalmentsPaid)}<div class="small muted">עד היום</div>`,
      },
      { header: 'תשלום ראשון', cell: (row) => (row.firstPaymentDate ? date(row.firstPaymentDate) : '—') },
      { header: 'יום חיוב', className: 'num', cell: (row) => (row.dayOfMonth ? number(row.dayOfMonth) : '—') },
      { header: 'חיוב הבא', cell: (row) => (row.nextChargeDate ? date(row.nextChargeDate) : '—') },
      { header: 'שולם', className: 'num', cell: (row) => `<strong>${money(row.paidAgorot)}</strong>` },
      {
        header: 'יתרה',
        className: 'num',
        cell: (row) => {
          if (!row.amountConfirmed) return '<span class="badge warning">לא ידוע</span>';
          return row.balanceAgorot > 0
            ? `<strong>${money(row.balanceAgorot)}</strong>`
            : '<span class="badge positive">שולם</span>';
        },
      },
      {
        header: 'התקדמות',
        cell: (row) =>
          row.amountConfirmed ? progressBar(row.paidAgorot, row.amountAgorot) : '<span class="muted">—</span>',
      },
      {
        header: 'אופן תשלום',
        cell: (row) => badge(row.paymentModeLabel, MODE_TONE[row.paymentMode] ?? 'neutral'),
      },
      {
        header: '',
        cell: (row) => `
          <div class="btn-row">
            ${
              !row.amountConfirmed || row.balanceAgorot > 0
                ? `<button class="btn small primary" data-pay="${row.commitmentId}">תשלום</button>`
                : ''
            }
            <button class="btn small" data-edit="${row.commitmentId}">עריכה</button>
          </div>`,
      },
    ],
    data.items,
    'אין עדיין התחייבויות למקום/ריהוט',
  );

  const missingNote =
    summary.unknownAmountCount > 0
      ? `<p class="small full" style="padding:0 4px">
           אצל <strong>${number(summary.unknownAmountCount)}</strong> חברים הסכום הכולל שסוכם עדיין
           לא הוזן, ולכן היתרה שלהם אינה ידועה. מה שכן ידוע - התשלום החודשי, כמה שולם עד היום
           ומתי התחיל - מוצג כרגיל, וההוראות ממשיכות לחייב.
           <a href="#/seats?state=unknown">הצגת מי שחסר לו סכום</a>
         </p>`
      : '';

  return `
    ${section('סיכום מקומות וריהוט', cards)}
    ${section('לפי אופן תשלום', modeRows, { hint: `${number(summary.notStartedCount)} טרם שילמו דבר` })}
    ${section('סינון', filters)}
    ${section('התחייבויות מקום וריהוט', rows + missingNote, {
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

  root.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () =>
      void openSeatEditModal({ commitmentId: Number(button.dataset.edit), onDone: reload }),
    );
  });
}

/**
 * עריכת שורת מקום/ריהוט.
 *
 * כל מה שקשור לחבר הזה במקום אחד: הסכום שסוכם, פריסת התשלומים, החיוב
 * החודשי, יום החיוב ומצב ההוראה. הגבאי לא צריך לדעת שמאחורי הקלעים
 * מדובר בשתי רשומות נפרדות.
 */
export async function openSeatEditModal({ commitmentId, onDone }) {
  const all = await api.seats({ state: 'all' });
  const row = all.items.find((item) => item.commitmentId === commitmentId);
  if (!row) {
    toast('ההתחייבות לא נמצאה', 'error');
    return;
  }

  const hasOrder = row.standingOrder !== null;
  const orderStatus = row.standingOrder?.status ?? '';

  openModal({
    title: `מקום וריהוט · ${row.member.name}`,
    bodyHtml: `
      <div class="section-body" style="padding:0">
        <dl class="kv">
          <dt>שולם עד היום</dt><dd><strong>${money(row.paidAgorot)}</strong></dd>
          <dt>תשלומים שבוצעו</dt><dd>${number(row.instalmentsPaid)}</dd>
          <dt>עמותה</dt><dd>${esc(row.organization.name)}</dd>
        </dl>
      </div>

      <div class="form-grid">
        ${field(
          'הסכום הכולל שסוכם (₪)',
          `<input type="number" name="amountShekels" min="0" step="0.01"
                  value="${row.amountConfirmed ? row.amountAgorot / 100 : ''}"
                  placeholder="ריק = עדיין לא ידוע" />`,
        )}
        ${field(
          'מספר תשלומים',
          `<input type="number" name="instalmentsCount" min="1" step="1"
                  value="${row.instalmentsCount ?? ''}" placeholder="אם ידוע" />`,
        )}
        ${field(
          'סכום החיוב החודשי (₪)',
          `<input type="number" name="instalmentShekels" min="0.01" step="0.01"
                  value="${row.instalmentAgorot ? row.instalmentAgorot / 100 : ''}"
                  ${hasOrder ? '' : 'disabled'} />`,
        )}
        ${field(
          'יום החיוב בחודש',
          `<input type="number" name="dayOfMonth" min="1" max="28" step="1"
                  value="${row.dayOfMonth ?? ''}" ${hasOrder ? '' : 'disabled'} />`,
        )}
        ${field(
          'תאריך התשלום הראשון',
          `<input type="date" name="firstPaymentDate" value="${esc(row.firstPaymentDate ?? '')}" />`,
        )}
        ${field(
          'מצב הוראת הקבע',
          `<select name="orderStatus" ${hasOrder ? '' : 'disabled'}>
             <option value="active"${orderStatus === 'active' ? ' selected' : ''}>פעילה</option>
             <option value="paused"${orderStatus === 'paused' ? ' selected' : ''}>מושהית</option>
             <option value="cancelled"${orderStatus === 'cancelled' ? ' selected' : ''}>מבוטלת</option>
           </select>`,
        )}
      </div>
      <p class="small muted full">
        ${
          hasOrder
            ? 'שינוי הסכום החודשי או יום החיוב משפיע על החיובים הבאים בלבד; חיובים שכבר נרשמו אינם משתנים.'
            : 'להתחייבות הזו אין הוראת קבע, ולכן אין סכום חודשי לערוך. התשלומים נרשמים ידנית.'
        }
        ${
          row.amountConfirmed
            ? 'מחיקת הסכום הכולל תחזיר אותו למצב "לא ידוע".'
            : 'הסכום הכולל חייב להיות לפחות כגובה מה שכבר שולם.'
        }
      </p>`,
    submitLabel: 'שמירה',
    onSubmit: async (formData) => {
      const total = formData.get('amountShekels');
      const payload = {
        amountShekels: total === '' ? null : total,
        instalmentsCount: formData.get('instalmentsCount')
          ? Number(formData.get('instalmentsCount'))
          : null,
        firstPaymentDate: formData.get('firstPaymentDate') || null,
      };
      if (hasOrder) {
        if (formData.get('instalmentShekels')) {
          payload.instalmentShekels = formData.get('instalmentShekels');
        }
        if (formData.get('dayOfMonth')) payload.dayOfMonth = Number(formData.get('dayOfMonth'));
        payload.orderStatus = formData.get('orderStatus');
      }

      const result = await api.updateSeat(commitmentId, payload);
      const item = result.item;
      toast(
        item.amountConfirmed
          ? `עודכן · התחייבות ${money(item.amountAgorot)} · יתרה ${money(item.balanceAgorot)}`
          : 'עודכן · הסכום הכולל עדיין לא הוזן',
        'success',
      );
      onDone?.();
    },
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
        'הסכום הכולל שסוכם (₪)',
        `<input type="number" name="amountShekels" min="0.01" step="0.01" placeholder="השאירו ריק אם עדיין לא ידוע" />`,
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
        אם הסכום הכולל עדיין לא ידוע, מלאו רק את הסכום החודשי - היתרה תוצג
        כ"לא ידועה" עד שתזינו אותו.
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
      const total = formData.get('amountShekels');
      const payload = {
        memberId: Number(formData.get('memberId')),
        organizationId: Number(formData.get('organizationId')),
        amountShekels: total || null,
        commitmentDate: formData.get('commitmentDate'),
        paymentMode: mode,
        notes: formData.get('notes') || null,
      };

      if (mode !== 'standing_order' && !total) {
        throw new Error('יש למלא את הסכום');
      }

      if (mode === 'standing_order') {
        const count = formData.get('instalmentsCount');
        const instalment = formData.get('instalmentShekels');
        if (!total && !instalment) {
          throw new Error('בלי סכום כולל יש למלא את סכום התשלום החודשי');
        }
        if (total && !count && !instalment) {
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
        seat.amountConfirmed
          ? `נרשמה התחייבות על ${money(seat.amountAgorot)} עבור ${seat.member.name} · יתרה ${money(seat.balanceAgorot)}`
          : `נרשמה התחייבות עבור ${seat.member.name} · הסכום הכולל יוזן בהמשך`,
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
