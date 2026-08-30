/**
 * Dashboard ראשי + אזור גבייה (סעיפים 23, 30).
 *
 * כל כרטיס מחזיר גם `link` - נתיב במסך הגבייה/קבלות עם המסננים המתאימים,
 * כדי שלחיצה על כרטיס תוביל לרשימה המתאימה (סעיף 30).
 */

import type { Db } from '../db/index.js';
import {
  collectedBetween,
  collectedThisMonthOnPriorDebt,
  debtByEvent,
  debtByOrganization,
  debtByType,
  getAgingBuckets,
  getCollectionSummary,
  outstandingOlderThan,
  type CollectionScope,
} from './collections.js';
import { startOfMonth, today } from './util.js';

export interface DashboardCard {
  key: string;
  title: string;
  /** סכום באגורות, אם הכרטיס מציג כסף. */
  amountAgorot?: number;
  count?: number;
  hint?: string;
  tone: 'neutral' | 'positive' | 'warning' | 'danger';
  /** נתיב במסכי המערכת, כולל מסננים - לחיצה על הכרטיס מובילה לרשימה. */
  link: string;
}

export interface DashboardData {
  generatedAt: string;
  scope: { organizationId: number | null; organizationName: string | null };
  /** כרטיסי הראש של הדשבורד הראשי (סעיף 23). */
  headline: DashboardCard[];
  /** אזור הגבייה (סעיף 30). */
  collection: DashboardCard[];
  summary: ReturnType<typeof getCollectionSummary>;
  aging: ReturnType<typeof getAgingBuckets>;
  breakdowns: {
    byOrganization: ReturnType<typeof debtByOrganization>;
    byEvent: ReturnType<typeof debtByEvent>;
    byType: ReturnType<typeof debtByType>;
  };
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export function getDashboard(db: Db, options: { organizationId?: number } = {}): DashboardData {
  const scope: CollectionScope = {};
  if (options.organizationId) scope.organizationId = options.organizationId;
  const orgParam = options.organizationId;

  const summary = getCollectionSummary(db, scope);
  const monthStart = startOfMonth();
  const now = today();

  const collectedThisMonth = collectedBetween(db, monthStart, now, {
    ...(orgParam ? { organizationId: orgParam } : {}),
  });
  const priorDebtCollected = collectedThisMonthOnPriorDebt(
    db,
    orgParam ? { organizationId: orgParam } : {},
  );
  const over30 = outstandingOlderThan(db, 30, scope);
  const over60 = outstandingOlderThan(db, 60, scope);

  const newCommitments = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_agorot), 0) AS amount
       FROM commitments
       WHERE commitment_date >= ? AND status != 'cancelled'
         ${orgParam ? 'AND organization_id = ?' : ''}`,
    )
    .get(...(orgParam ? [monthStart, orgParam] : [monthStart])) as {
    count: number;
    amount: number;
  };

  const receiptStats = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('pending','awaiting_approval') THEN 1 ELSE 0 END) AS awaiting,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM receipts ${orgParam ? 'WHERE organization_id = ?' : ''}`,
    )
    .get(...(orgParam ? [orgParam] : [])) as { awaiting: number | null; failed: number | null };

  const unassigned = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_agorot), 0) AS amount
       FROM payments
       WHERE member_id IS NULL AND status = 'completed'
         ${orgParam ? 'AND organization_id = ?' : ''}`,
    )
    .get(...(orgParam ? [orgParam] : [])) as { count: number; amount: number };

  const orgQuery = orgParam ? { organizationId: orgParam } : {};

  // --- כרטיסי הדשבורד הראשי (סעיף 23) ---------------------------------------
  const headline: DashboardCard[] = [
    {
      key: 'total_outstanding',
      title: 'סך החובות הפתוחים',
      amountAgorot: summary.outstandingAgorot,
      count: summary.openCommitmentCount + summary.partiallyPaidCount,
      tone: summary.outstandingAgorot > 0 ? 'warning' : 'positive',
      link: `#/collections${queryString({ ...orgQuery, status: 'outstanding' })}`,
    },
    {
      key: 'debtors',
      title: 'חברים עם חוב פתוח',
      count: summary.debtorCount,
      tone: summary.debtorCount > 0 ? 'warning' : 'positive',
      link: `#/collections${queryString({ ...orgQuery, view: 'debtors' })}`,
    },
    {
      key: 'long_overdue',
      title: 'התחייבויות שלא שולמו זמן ממושך',
      amountAgorot: over60.amountAgorot,
      count: over60.commitmentCount,
      hint: 'פתוחות מעל 60 יום',
      tone: over60.commitmentCount > 0 ? 'danger' : 'positive',
      link: `#/collections${queryString({ ...orgQuery, status: 'outstanding', minAgeDays: 60 })}`,
    },
    {
      key: 'collected_prior_debt',
      title: 'נגבה החודש בגין חובות קודמים',
      amountAgorot: priorDebtCollected.amountAgorot,
      count: priorDebtCollected.paymentCount,
      tone: 'positive',
      link: `#/payments${queryString({ ...orgQuery, fromDate: monthStart, priorDebt: 1 })}`,
    },
  ];

  // --- אזור הגבייה (סעיף 30) -------------------------------------------------
  const collection: DashboardCard[] = [
    {
      key: 'open_commitments',
      title: 'התחייבויות פתוחות',
      count: summary.openCommitmentCount + summary.partiallyPaidCount,
      tone: 'neutral',
      link: `#/collections${queryString({ ...orgQuery, status: 'outstanding' })}`,
    },
    {
      key: 'total_to_collect',
      title: 'סכום כולל לגבייה',
      amountAgorot: summary.outstandingAgorot,
      tone: summary.outstandingAgorot > 0 ? 'warning' : 'positive',
      link: `#/collections${queryString({ ...orgQuery, status: 'outstanding' })}`,
    },
    {
      key: 'collected_this_month',
      title: 'נגבה החודש',
      amountAgorot: collectedThisMonth.amountAgorot,
      count: collectedThisMonth.paymentCount,
      tone: 'positive',
      link: `#/payments${queryString({ ...orgQuery, fromDate: monthStart, toDate: now })}`,
    },
    {
      key: 'new_commitments',
      title: 'התחייבויות שנוצרו החודש',
      amountAgorot: newCommitments.amount,
      count: newCommitments.count,
      tone: 'neutral',
      link: `#/collections${queryString({ ...orgQuery, fromDate: monthStart, toDate: now })}`,
    },
    {
      key: 'over_30',
      title: 'חובות מעל 30 יום',
      amountAgorot: over30.amountAgorot,
      count: over30.commitmentCount,
      tone: over30.commitmentCount > 0 ? 'warning' : 'positive',
      link: `#/collections${queryString({ ...orgQuery, status: 'outstanding', minAgeDays: 30 })}`,
    },
    {
      key: 'over_60',
      title: 'חובות מעל 60 יום',
      amountAgorot: over60.amountAgorot,
      count: over60.commitmentCount,
      tone: over60.commitmentCount > 0 ? 'danger' : 'positive',
      link: `#/collections${queryString({ ...orgQuery, status: 'outstanding', minAgeDays: 60 })}`,
    },
    {
      key: 'receipts_awaiting',
      title: 'קבלות שממתינות להפקה',
      count: receiptStats.awaiting ?? 0,
      tone: (receiptStats.awaiting ?? 0) > 0 ? 'warning' : 'positive',
      link: `#/receipts${queryString({ ...orgQuery, status: 'pending' })}`,
    },
    {
      key: 'receipts_failed',
      title: 'כשלים בהפקת קבלה',
      count: receiptStats.failed ?? 0,
      tone: (receiptStats.failed ?? 0) > 0 ? 'danger' : 'positive',
      link: `#/receipts${queryString({ ...orgQuery, status: 'failed' })}`,
    },
    {
      key: 'unassigned_payments',
      title: 'תשלומים שלא שויכו לחבר',
      amountAgorot: unassigned.amount,
      count: unassigned.count,
      tone: unassigned.count > 0 ? 'warning' : 'positive',
      link: `#/payments${queryString({ ...orgQuery, unassigned: 1 })}`,
    },
  ];

  const organizationName = orgParam
    ? ((db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgParam) as
        | { name: string }
        | undefined)?.name ?? null)
    : null;

  return {
    generatedAt: new Date().toISOString(),
    scope: { organizationId: orgParam ?? null, organizationName },
    headline,
    collection,
    summary,
    aging: getAgingBuckets(db, scope),
    breakdowns: {
      byOrganization: debtByOrganization(db, scope),
      byEvent: debtByEvent(db, scope),
      byType: debtByType(db, scope),
    },
  };
}
