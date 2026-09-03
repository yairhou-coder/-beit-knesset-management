/**
 * מסך תקציב: מה נכנס כל חודש, מה יוצא, ועד איזו שורה הכסף מגיע.
 *
 * האומדנים בקטגוריות הם הערכות שנמסרו, ולא הוצאות שנרשמו. הם משמשים
 * לתחזית בלבד, ולעולם אינם מתערבבים עם ההוצאות בפועל - שתי העמודות
 * מוצגות זו לצד זו כדי שההבדל יהיה גלוי.
 */

import { api } from '../api.js';
import { esc, money, number } from '../format.js';
import { field, openModal, section, selectOptions, statCard, table, toast } from '../ui.js';
import { withOrg } from '../state.js';

const KIND_ORDER = ['salary', 'ongoing', 'events', 'maintenance', 'other'];

function periodOptions() {
  return [
    { value: '', label: 'לא נקבעה' },
    { value: 'monthly', label: 'חודשי' },
    { value: 'yearly', label: 'שנתי' },
    { value: 'occasional', label: 'לפי הצורך' },
  ];
}

export async function renderBudget() {
  const orgParams = withOrg();
  const [budget, orders, seats] = await Promise.all([
    api.budget(orgParams),
    api.standingOrders(withOrg({ kind: 'recurring' })),
    api.seats(orgParams),
  ]);

  // --- הכנסה חודשית צפויה ---------------------------------------------------
  const activeOrders = orders.items.filter((row) => row.status === 'active');
  const duesMonthly = activeOrders.reduce((sum, row) => sum + row.amountAgorot, 0);
  const seatsMonthly = seats.summary.monthlyExpectedAgorot;
  const incomeMonthly = duesMonthly + seatsMonthly;

  const gap = incomeMonthly - budget.plannedMonthlyAgorot;

  const cards = `
    <div class="card-grid" style="margin:0">
      ${statCard({
        title: 'הכנסה חודשית צפויה',
        amountAgorot: incomeMonthly,
        tone: 'positive',
        hint: `${number(activeOrders.length)} הו״ק שוטפות + מקומות`,
        link: '#/standing-orders',
      })}
      ${statCard({
        title: 'הוצאה חודשית מתוכננת',
        amountAgorot: budget.plannedMonthlyAgorot,
        tone: 'warning',
        hint: 'אומדן, בשקלול חודשי',
        link: '#/budget',
      })}
      ${statCard({
        title: gap >= 0 ? 'עודף חודשי' : 'גירעון חודשי',
        amountAgorot: Math.abs(gap),
        tone: gap >= 0 ? 'positive' : 'danger',
        hint: gap >= 0 ? 'ההכנסה מכסה את התכנון' : 'ההכנסה אינה מכסה את התכנון',
        link: '#/budget',
      })}
      ${statCard({
        title: 'הוצאה חודשית בפועל',
        amountAgorot: budget.actualMonthlyAgorot,
        tone: 'neutral',
        hint: `ממוצע ${number(budget.monthsMeasured)} חודשים אחרונים`,
        link: '#/expenses',
      })}
    </div>`;

  // --- עד איפה מגיע הכסף ----------------------------------------------------
  // השורות מסודרות לפי סדר הקטגוריות, וסכום מצטבר מראה בדיוק היכן
  // ההכנסה החודשית נגמרת. זו התשובה לשאלה "איזו שורה הכסף מכסה".
  const planned = budget.lines
    .filter((line) => line.plannedMonthlyAgorot !== null && line.plannedMonthlyAgorot > 0)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

  let running = 0;
  const coverageRows = planned.map((line) => {
    const before = running;
    running += line.plannedMonthlyAgorot;
    return {
      ...line,
      cumulativeAgorot: running,
      covered: running <= incomeMonthly,
      // השורה שבה הכסף נגמר: מתחילה בתוך הטווח ומסתיימת מחוצה לו
      partial: before < incomeMonthly && running > incomeMonthly,
      coveredAgorot: Math.max(0, Math.min(line.plannedMonthlyAgorot, incomeMonthly - before)),
    };
  });

  const coverage = table(
    [
      { header: 'קטגוריה', cell: (row) => esc(row.name) },
      { header: 'אופי', cell: (row) => `<span class="small muted">${esc(row.kindLabel)}</span>` },
      { header: 'לחודש', className: 'num', cell: (row) => money(row.plannedMonthlyAgorot) },
      { header: 'מצטבר', className: 'num', cell: (row) => money(row.cumulativeAgorot) },
      {
        header: 'כיסוי',
        cell: (row) =>
          row.covered
            ? '<span class="badge positive">מכוסה</span>'
            : row.partial
              ? `<span class="badge warning">מכוסה חלקית · ${money(row.coveredAgorot)}</span>`
              : '<span class="badge danger">לא מכוסה</span>',
      },
    ],
    coverageRows,
    'טרם הוזנו אומדנים',
  );

  const coveredCount = coverageRows.filter((row) => row.covered).length;
  const lastCovered = coverageRows.filter((row) => row.covered).at(-1);
  const firstUncovered = coverageRows.find((row) => !row.covered);

  const verdict = coverageRows.length === 0
    ? ''
    : firstUncovered
      ? `<p class="small full" style="padding:0 4px">
           ההכנסה החודשית (<strong>${money(incomeMonthly)}</strong>) מכסה
           ${coveredCount > 0 ? `את הקטגוריות עד <strong>${esc(lastCovered.name)}</strong> כולל` : 'פחות מקטגוריה אחת מלאה'},
           ונעצרת ב<strong>${esc(firstUncovered.name)}</strong>${firstUncovered.partial ? ` (מכוסה ${money(firstUncovered.coveredAgorot)} מתוך ${money(firstUncovered.plannedMonthlyAgorot)})` : ''}.
         </p>`
      : `<p class="small full" style="padding:0 4px">
           ההכנסה החודשית (<strong>${money(incomeMonthly)}</strong>) מכסה את כל שורות התקציב המתוכננות,
           ונותר עודף של <strong>${money(gap)}</strong>.
         </p>`;

  // --- טבלת התקציב המלאה ----------------------------------------------------
  const lines = table(
    [
      { header: 'קטגוריה', cell: (row) => esc(row.name) },
      { header: 'אופי', cell: (row) => `<span class="small muted">${esc(row.kindLabel)}</span>` },
      {
        header: 'אומדן מתוכנן',
        className: 'num',
        cell: (row) =>
          row.plannedAmountAgorot === null
            ? '<span class="muted">טרם הוזן</span>'
            : money(row.plannedAmountAgorot),
      },
      { header: 'תדירות', cell: (row) => esc(row.plannedPeriodLabel ?? '—') },
      {
        header: 'לחודש',
        className: 'num',
        cell: (row) => (row.plannedMonthlyAgorot === null ? '—' : money(row.plannedMonthlyAgorot)),
      },
      {
        header: 'בפועל (ממוצע חודשי)',
        className: 'num',
        cell: (row) => (row.expenseCount > 0 ? money(row.actualMonthlyAgorot) : '—'),
      },
      {
        header: 'פער',
        className: 'num',
        cell: (row) => {
          if (row.plannedMonthlyAgorot === null || row.expenseCount === 0) return '—';
          const diff = row.actualMonthlyAgorot - row.plannedMonthlyAgorot;
          if (diff === 0) return '<span class="badge positive">בדיוק</span>';
          return diff > 0
            ? `<span class="badge warning">חריגה ${money(diff)}</span>`
            : `<span class="badge positive">חיסכון ${money(-diff)}</span>`;
        },
      },
      { header: 'הערה', cell: (row) => `<span class="small muted">${esc(row.plannedNote ?? '')}</span>` },
      {
        header: '',
        cell: (row) => `<button class="btn small" data-budget="${row.categoryId}">עריכת אומדן</button>`,
      },
    ],
    budget.lines,
    'אין קטגוריות הוצאה',
  );

  // ההבחנה בין תכנון לביצוע היא כל העניין של המסך הזה, ולכן היא כתובה
  // בראשו במפורש ולא מונחת כידועה מאליה.
  const intro = `
    <p class="small" style="padding:4px">
      <strong>מסך זה אינו רושם הוצאות.</strong> הוא מציג את מה ש<strong>תכננת</strong> להוציא
      (אומדן) מול מה ש<strong>יצא בפועל</strong> — והנתונים בעמודת "בפועל" נלקחים
      ממסך <a href="#/expenses">ההוצאות</a>. כאן רואים את הפער; שם רושמים כל הוצאה.
    </p>`;

  return `
    ${section('תמונת המצב החודשית', intro + cards)}
    ${section('עד לאן מגיע הכסף', coverage + verdict, {
      hint: 'לפי סדר הקטגוריות',
      flush: true,
    })}
    ${section('תקציב מול ביצוע', lines, {
      hint: `${number(budget.withoutPlanCount)} קטגוריות ללא אומדן`,
      flush: true,
    })}
    <p class="small muted" style="padding:0 4px">
      האומדנים הם הערכות שהוזנו ידנית ואינם הוצאות שנרשמו. עמודת "בפועל" מחושבת
      מההוצאות שנרשמו במערכת ב-${number(budget.monthsMeasured)} החודשים האחרונים.
      ההכנסה הצפויה מחושבת מהוראות הקבע הפעילות בלבד, ואינה כוללת תרומות חד-פעמיות.
    </p>`;
}

export function bindBudget(root, reload) {
  root.querySelectorAll('[data-budget]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = Number(button.dataset.budget);
      const row = (await api.expenseCategories()).items.find((item) => item.id === id);
      if (!row) return;

      openModal({
        title: `אומדן תקציב · ${row.name}`,
        bodyHtml: `
          <div class="form-grid">
            ${field(
              'סכום האומדן (₪)',
              `<input type="number" name="plannedShekels" min="0" step="0.01"
                      value="${row.plannedAmountAgorot === null ? '' : row.plannedAmountAgorot / 100}"
                      placeholder="השאירו ריק כדי לבטל את האומדן" />`,
            )}
            ${field('תדירות', `<select name="plannedPeriod">${selectOptions(periodOptions(), row.plannedPeriod ?? '')}</select>`)}
            ${field('הערה', `<input type="text" name="plannedNote" value="${esc(row.plannedNote ?? '')}" />`, { className: 'full' })}
          </div>
          <p class="small muted full">
            האומדן משמש לתחזית בלבד. הוא אינו נרשם כהוצאה ואינו משפיע על אף רשומה קיימת.
          </p>`,
        submitLabel: 'שמירת האומדן',
        onSubmit: async (formData) => {
          const raw = formData.get('plannedShekels');
          await api.updateCategoryBudget(id, {
            plannedShekels: raw === '' ? null : raw,
            plannedPeriod: formData.get('plannedPeriod') || null,
            plannedNote: formData.get('plannedNote') || null,
          });
          toast('האומדן עודכן', 'success');
          reload();
        },
      });
    });
  });
}
