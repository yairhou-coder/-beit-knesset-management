/** דשבורד ראשי + אזור גבייה (סעיפים 23, 30). */

import { api } from '../api.js';
import { esc, money, number } from '../format.js';
import { section, statCard, table } from '../ui.js';
import { withOrg } from '../state.js';

export async function renderDashboard() {
  const data = await api.dashboard(withOrg());

  const headline = `<div class="card-grid">${data.headline.map(statCard).join('')}</div>`;
  const collection = `<div class="card-grid">${data.collection.map(statCard).join('')}</div>`;

  const summary = data.summary;
  const summaryHtml = `
    <div class="card-grid" style="margin:0">
      ${statCard({
        title: 'סך ההתחייבויות',
        amountAgorot: summary.committedAgorot,
        hint: 'התחייבויות אינן הכנסה',
        tone: 'neutral',
        link: '#/commitments',
      })}
      ${statCard({
        title: 'נגבה בפועל',
        amountAgorot: summary.collectedAgorot,
        hint: `${summary.collectionRate}% מההתחייבויות`,
        tone: 'positive',
        link: '#/incomes',
      })}
      ${statCard({
        title: 'יתרות שטרם נגבו',
        amountAgorot: summary.outstandingAgorot,
        hint: `${number(summary.debtorCount)} חברים`,
        tone: summary.outstandingAgorot > 0 ? 'warning' : 'positive',
        link: '#/collections?status=outstanding',
      })}
    </div>`;

  const agingTable = table(
    [
      { header: 'גיל החוב', cell: (row) => esc(row.label) },
      { header: 'סכום', className: 'num', cell: (row) => money(row.outstandingAgorot) },
      { header: 'התחייבויות', className: 'num', cell: (row) => number(row.commitmentCount) },
      { header: 'חברים', className: 'num', cell: (row) => number(row.memberCount) },
      {
        header: '',
        cell: (row) =>
          `<a class="btn small" href="#/collections?status=outstanding&minAgeDays=${row.minDays}">הצג</a>`,
      },
    ],
    data.aging.filter((bucket) => bucket.commitmentCount > 0),
    'אין חובות פתוחים',
  );

  const breakdownTable = (rows, linkParam) =>
    table(
      [
        { header: 'שם', cell: (row) => esc(row.label) },
        { header: 'יתרה לגבייה', className: 'num', cell: (row) => money(row.outstandingAgorot) },
        { header: 'מתוך', className: 'num', cell: (row) => money(row.committedAgorot) },
        {
          header: '',
          cell: (row) =>
            row.id
              ? `<a class="btn small" href="#/collections?${linkParam}=${row.id}">הצג</a>`
              : '',
        },
      ],
      rows,
      'אין נתונים',
    );

  return `
    ${section('תמונת מצב כספית', summaryHtml, {
      hint: 'הפרדה בין התחייבויות, כספים שנגבו בפועל ויתרות',
    })}
    ${section('מדדים ראשיים', headline, { flush: false })}
    ${section('גבייה', collection, { hint: 'לחיצה על כרטיס מובילה לרשימה המתאימה' })}
    <div class="grid-2">
      ${section('גיל החוב', agingTable, { flush: true })}
      ${section('חובות לפי עמותה', breakdownTable(data.breakdowns.byOrganization, 'organizationId'), { flush: true })}
      ${section('חובות לפי שבת / חג / אירוע', breakdownTable(data.breakdowns.byEvent, 'eventId'), { flush: true })}
      ${section('חובות לפי סוג התחייבות', breakdownTable(data.breakdowns.byType, 'commitmentTypeId'), { flush: true })}
    </div>`;
}
