/**
 * אודות המערכת.
 * כאן מוצג הלוגו המלא של בית המדרש, כולל הקדשת הלע"נ, שאינה קריאה
 * בגודל הסמל הקטן שבסרגל הצד.
 */

import { api } from '../api.js';
import { esc, money } from '../format.js';
import { section, table } from '../ui.js';
import { state } from '../state.js';

export async function renderAbout() {
  const report = await api.report({});

  const identity = `
    <div class="about-logo">
      <img src="/assets/logo.jpg" alt="לוגו בית המדרש אנשי מעשה" />
    </div>
    <p class="about-dedication">
      <strong>נוסד לעילוי נשמת</strong><br />
      ר׳ אהרן ב״ר שמואל בוימל ז״ל<br />
      מרת חסיה נירה ב״ר גדליהו פוגל ע״ה<br />
      ר׳ שמואל ב״ר צבי זאב פריד ז״ל
    </p>`;

  const organizations = table(
    [
      { header: 'עמותה', cell: (row) => `<strong>${esc(row.name)}</strong>` },
      { header: 'מספר עמותה / ח.פ.', cell: (row) => esc(row.legalNumber ?? '—') },
      { header: 'מערכת קבלות', cell: (row) => esc(row.integrations.receipt.provider) },
      { header: 'מערכת סליקה', cell: (row) => esc(row.integrations.payment.provider) },
    ],
    state.organizations,
    'לא הוגדרו עמותות',
  );

  const totals = table(
    [
      {
        header: 'עמותה',
        cell: (row) => (row.organization ? esc(row.organization.name) : '<strong>סה"כ קהילה</strong>'),
      },
      { header: 'התחייבויות', className: 'num', cell: (row) => money(row.committedAgorot) },
      { header: 'נגבה בפועל', className: 'num', cell: (row) => money(row.collectedAgorot) },
      { header: 'יתרה לגבייה', className: 'num', cell: (row) => money(row.outstandingAgorot) },
    ],
    [...report.perOrganization, report.combined],
    '',
  );

  return `
    <div class="grid-2">
      ${section('בית המדרש אנשי מעשה', identity)}
      ${section('העמותות במערכת', organizations, { flush: true })}
    </div>
    ${section('תמונת מצב כספית', totals, {
      hint: 'התחייבויות, כספים שנגבו בפועל ויתרות שטרם נגבו - בהפרדה לפי עמותה',
      flush: true,
    })}`;
}
