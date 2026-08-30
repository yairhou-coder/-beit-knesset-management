/**
 * מסך "גבייה וחובות" (סעיף 23) ואזור הגבייה בדשבורד (סעיף 30).
 *
 * הפרדה מהותית בדוחות:
 *   committed  - סך ההתחייבויות שנוצרו (אינן הכנסה).
 *   collected  - כסף שנגבה בפועל (הכנסות).
 *   outstanding- יתרות שטרם נגבו.
 */

import type { Db } from '../db/index.js';
import { WhereBuilder, startOfMonth, today } from './util.js';

export interface CollectionScope {
  organizationId?: number;
  fromDate?: string;
  toDate?: string;
  eventId?: number;
  commitmentTypeId?: number;
}

function commitmentWhere(scope: CollectionScope, alias = 'c'): WhereBuilder {
  const where = new WhereBuilder();
  where.addIf(scope.organizationId, `${alias}.organization_id = ?`, scope.organizationId);
  where.addIf(scope.eventId, `${alias}.event_id = ?`, scope.eventId);
  where.addIf(scope.commitmentTypeId, `${alias}.commitment_type_id = ?`, scope.commitmentTypeId);
  where.addIf(scope.fromDate, `${alias}.commitment_date >= ?`, scope.fromDate);
  where.addIf(scope.toDate, `${alias}.commitment_date <= ?`, scope.toDate);
  return where;
}

// ---------------------------------------------------------------------------
// סיכום כללי
// ---------------------------------------------------------------------------

export interface CollectionSummary {
  /** סך ההתחייבויות שנוצרו (לא כולל מבוטלות). */
  committedAgorot: number;
  /** סך מה שנגבה בפועל כנגד התחייבויות. */
  collectedAgorot: number;
  /** סך החובות הפתוחים - היתרה שטרם נגבתה. */
  outstandingAgorot: number;
  /** אחוז הגבייה מתוך ההתחייבויות. */
  collectionRate: number;
  commitmentCount: number;
  openCommitmentCount: number;
  partiallyPaidCount: number;
  paidCount: number;
  cancelledCount: number;
  /** מספר חברים עם חוב פתוח. */
  debtorCount: number;
}

export function getCollectionSummary(db: Db, scope: CollectionScope = {}): CollectionSummary {
  const where = commitmentWhere(scope);
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN c.status != 'cancelled' THEN c.amount_agorot END), 0) AS committed,
         COALESCE(SUM(CASE WHEN c.status != 'cancelled' THEN c.paid_agorot END), 0) AS collected,
         COALESCE(SUM(CASE WHEN c.status IN ('open','partially_paid') THEN c.balance_agorot END), 0) AS outstanding,
         COUNT(*) AS total,
         SUM(CASE WHEN c.status = 'open' THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN c.status = 'partially_paid' THEN 1 ELSE 0 END) AS partial_count,
         SUM(CASE WHEN c.status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
         SUM(CASE WHEN c.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
         COUNT(DISTINCT CASE WHEN c.status IN ('open','partially_paid') THEN c.member_id END) AS debtors
       FROM commitments c ${where.sql}`,
    )
    .get(...where.values) as {
    committed: number;
    collected: number;
    outstanding: number;
    total: number;
    open_count: number;
    partial_count: number;
    paid_count: number;
    cancelled_count: number;
    debtors: number;
  };

  return {
    committedAgorot: row.committed,
    collectedAgorot: row.collected,
    outstandingAgorot: row.outstanding,
    collectionRate: row.committed > 0 ? Math.round((row.collected / row.committed) * 1000) / 10 : 0,
    commitmentCount: row.total,
    openCommitmentCount: row.open_count,
    partiallyPaidCount: row.partial_count,
    paidCount: row.paid_count,
    cancelledCount: row.cancelled_count,
    debtorCount: row.debtors,
  };
}

// ---------------------------------------------------------------------------
// מי חייב כסף וכמה (סעיף 23)
// ---------------------------------------------------------------------------

export interface DebtorRow {
  member: { id: number; name: string; phone: string | null; email: string | null };
  organization: { id: number; name: string };
  outstandingAgorot: number;
  committedAgorot: number;
  paidAgorot: number;
  openCommitments: number;
  /** כמה זמן החוב הוותיק ביותר פתוח, בימים. */
  oldestDebtDays: number;
  oldestCommitmentDate: string;
  nearestDueDate: string | null;
  overdue: boolean;
}

export function listDebtors(
  db: Db,
  scope: CollectionScope & { minOutstandingAgorot?: number; minAgeDays?: number; limit?: number } = {},
): DebtorRow[] {
  const where = commitmentWhere(scope);
  where.add("c.status IN ('open','partially_paid')");
  if (scope.minAgeDays !== undefined) {
    where.add("c.commitment_date <= date('now', ?)", `-${Math.max(0, scope.minAgeDays)} days`);
  }

  const rows = db
    .prepare(
      `SELECT c.member_id, c.organization_id,
              m.first_name, m.last_name, m.phone, m.email,
              o.name AS organization_name,
              SUM(c.balance_agorot) AS outstanding,
              SUM(c.amount_agorot) AS committed,
              SUM(c.paid_agorot) AS paid,
              COUNT(*) AS open_commitments,
              MIN(c.commitment_date) AS oldest_date,
              MIN(c.due_date) AS nearest_due,
              CAST(julianday('now') - julianday(MIN(c.commitment_date)) AS INTEGER) AS oldest_days
       FROM commitments c
       JOIN members m ON m.id = c.member_id
       JOIN organizations o ON o.id = c.organization_id
       ${where.sql}
       GROUP BY c.member_id, c.organization_id
       HAVING outstanding >= ?
       ORDER BY outstanding DESC
       LIMIT ?`,
    )
    .all(
      ...where.values,
      scope.minOutstandingAgorot ?? 1,
      Math.min(scope.limit ?? 200, 1000),
    ) as Array<{
    member_id: number;
    organization_id: number;
    first_name: string;
    last_name: string;
    phone: string | null;
    email: string | null;
    organization_name: string;
    outstanding: number;
    committed: number;
    paid: number;
    open_commitments: number;
    oldest_date: string;
    nearest_due: string | null;
    oldest_days: number;
  }>;

  const now = today();
  return rows.map((row) => ({
    member: {
      id: row.member_id,
      name: `${row.first_name} ${row.last_name}`.trim(),
      phone: row.phone,
      email: row.email,
    },
    organization: { id: row.organization_id, name: row.organization_name },
    outstandingAgorot: row.outstanding,
    committedAgorot: row.committed,
    paidAgorot: row.paid,
    openCommitments: row.open_commitments,
    oldestDebtDays: Math.max(0, row.oldest_days),
    oldestCommitmentDate: row.oldest_date,
    nearestDueDate: row.nearest_due,
    overdue: row.nearest_due !== null && row.nearest_due < now,
  }));
}

// ---------------------------------------------------------------------------
// פילוחי חובות (סעיף 23)
// ---------------------------------------------------------------------------

export interface BreakdownRow {
  id: number | null;
  label: string;
  outstandingAgorot: number;
  committedAgorot: number;
  collectedAgorot: number;
  commitmentCount: number;
  memberCount: number;
}

function breakdown(
  db: Db,
  scope: CollectionScope,
  groupSql: { join: string; idColumn: string; labelColumn: string },
): BreakdownRow[] {
  const where = commitmentWhere(scope);
  where.add("c.status != 'cancelled'");
  const rows = db
    .prepare(
      `SELECT ${groupSql.idColumn} AS group_id, ${groupSql.labelColumn} AS label,
              COALESCE(SUM(CASE WHEN c.status IN ('open','partially_paid') THEN c.balance_agorot END), 0) AS outstanding,
              SUM(c.amount_agorot) AS committed,
              SUM(c.paid_agorot) AS collected,
              COUNT(*) AS commitment_count,
              COUNT(DISTINCT c.member_id) AS member_count
       FROM commitments c
       ${groupSql.join}
       ${where.sql}
       GROUP BY group_id, label
       ORDER BY outstanding DESC, committed DESC`,
    )
    .all(...where.values) as Array<{
    group_id: number | null;
    label: string | null;
    outstanding: number;
    committed: number;
    collected: number;
    commitment_count: number;
    member_count: number;
  }>;

  return rows.map((row) => ({
    id: row.group_id,
    label: row.label ?? 'ללא שיוך',
    outstandingAgorot: row.outstanding,
    committedAgorot: row.committed,
    collectedAgorot: row.collected,
    commitmentCount: row.commitment_count,
    memberCount: row.member_count,
  }));
}

/** חובות לפי עמותה. */
export function debtByOrganization(db: Db, scope: CollectionScope = {}): BreakdownRow[] {
  return breakdown(db, scope, {
    join: 'JOIN organizations o ON o.id = c.organization_id',
    idColumn: 'c.organization_id',
    labelColumn: 'o.name',
  });
}

/** חובות לפי שבת / חג / אירוע. */
export function debtByEvent(db: Db, scope: CollectionScope = {}): BreakdownRow[] {
  return breakdown(db, scope, {
    join: 'LEFT JOIN events e ON e.id = c.event_id',
    idColumn: 'c.event_id',
    labelColumn: "COALESCE(e.name, 'ללא אירוע')",
  });
}

/** חובות לפי סוג התחייבות (עליות, תרומות, אירועים וכדומה). */
export function debtByType(db: Db, scope: CollectionScope = {}): BreakdownRow[] {
  return breakdown(db, scope, {
    join: 'JOIN commitment_types ct ON ct.id = c.commitment_type_id',
    idColumn: 'c.commitment_type_id',
    labelColumn: 'ct.name',
  });
}

// ---------------------------------------------------------------------------
// גיל החוב (סעיף 30: מעל 30 יום, מעל 60 יום)
// ---------------------------------------------------------------------------

export interface AgingBucket {
  label: string;
  minDays: number;
  maxDays: number | null;
  outstandingAgorot: number;
  commitmentCount: number;
  memberCount: number;
}

export function getAgingBuckets(db: Db, scope: CollectionScope = {}): AgingBucket[] {
  const definitions: Array<{ label: string; min: number; max: number | null }> = [
    { label: 'עד 30 יום', min: 0, max: 30 },
    { label: '31-60 יום', min: 31, max: 60 },
    { label: '61-90 יום', min: 61, max: 90 },
    { label: 'מעל 90 יום', min: 91, max: null },
  ];

  return definitions.map((definition) => {
    const where = commitmentWhere(scope);
    where.add("c.status IN ('open','partially_paid')");
    where.add(
      "CAST(julianday('now') - julianday(c.commitment_date) AS INTEGER) >= ?",
      definition.min,
    );
    if (definition.max !== null) {
      where.add(
        "CAST(julianday('now') - julianday(c.commitment_date) AS INTEGER) <= ?",
        definition.max,
      );
    }
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(c.balance_agorot), 0) AS outstanding, COUNT(*) AS commitment_count,
                COUNT(DISTINCT c.member_id) AS member_count
         FROM commitments c ${where.sql}`,
      )
      .get(...where.values) as {
      outstanding: number;
      commitment_count: number;
      member_count: number;
    };
    return {
      label: definition.label,
      minDays: definition.min,
      maxDays: definition.max,
      outstandingAgorot: row.outstanding,
      commitmentCount: row.commitment_count,
      memberCount: row.member_count,
    };
  });
}

/** סך החוב הפתוח מעל גיל מסוים (למשל 30 או 60 יום). */
export function outstandingOlderThan(
  db: Db,
  days: number,
  scope: CollectionScope = {},
): { amountAgorot: number; commitmentCount: number; memberCount: number } {
  const where = commitmentWhere(scope);
  where.add("c.status IN ('open','partially_paid')");
  where.add("c.commitment_date <= date('now', ?)", `-${Math.max(0, days)} days`);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(c.balance_agorot), 0) AS amount, COUNT(*) AS commitment_count,
              COUNT(DISTINCT c.member_id) AS member_count
       FROM commitments c ${where.sql}`,
    )
    .get(...where.values) as { amount: number; commitment_count: number; member_count: number };
  return {
    amountAgorot: row.amount,
    commitmentCount: row.commitment_count,
    memberCount: row.member_count,
  };
}

// ---------------------------------------------------------------------------
// גבייה בפועל
// ---------------------------------------------------------------------------

/** סך ההכנסות שנרשמו בטווח תאריכים (כסף שנגבה בפועל). */
export function collectedBetween(
  db: Db,
  fromDate: string,
  toDate: string,
  scope: { organizationId?: number; againstCommitmentsOnly?: boolean } = {},
): { amountAgorot: number; paymentCount: number } {
  const where = new WhereBuilder()
    .add("i.status = 'recorded'")
    .add('i.income_date >= ?', fromDate)
    .add('i.income_date <= ?', toDate);
  where.addIf(scope.organizationId, 'i.organization_id = ?', scope.organizationId);
  if (scope.againstCommitmentsOnly) where.add('i.commitment_id IS NOT NULL');

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(i.amount_agorot), 0) AS amount, COUNT(*) AS payment_count
       FROM incomes i ${where.sql}`,
    )
    .get(...where.values) as { amount: number; payment_count: number };
  return { amountAgorot: row.amount, paymentCount: row.payment_count };
}

/**
 * תשלומים שהתקבלו החודש בגין חובות קודמים (סעיף 23).
 * כלומר הכנסות של החודש הנוכחי כנגד התחייבויות שנוצרו לפני תחילת החודש.
 */
export function collectedThisMonthOnPriorDebt(
  db: Db,
  scope: { organizationId?: number } = {},
): { amountAgorot: number; paymentCount: number; memberCount: number } {
  const monthStart = startOfMonth();
  const where = new WhereBuilder()
    .add("i.status = 'recorded'")
    .add('i.income_date >= ?', monthStart)
    .add('c.commitment_date < ?', monthStart);
  where.addIf(scope.organizationId, 'i.organization_id = ?', scope.organizationId);

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(i.amount_agorot), 0) AS amount, COUNT(*) AS payment_count,
              COUNT(DISTINCT i.member_id) AS member_count
       FROM incomes i
       JOIN commitments c ON c.id = i.commitment_id
       ${where.sql}`,
    )
    .get(...where.values) as { amount: number; payment_count: number; member_count: number };
  return {
    amountAgorot: row.amount,
    paymentCount: row.payment_count,
    memberCount: row.member_count,
  };
}

// ---------------------------------------------------------------------------
// דוח מאוחד / לפי עמותה (סעיף 25)
// ---------------------------------------------------------------------------

export interface OrganizationFinancialReport {
  organization: { id: number; name: string } | null;
  committedAgorot: number;
  collectedAgorot: number;
  outstandingAgorot: number;
  incomeAgorot: number;
  expenseAgorot: number;
  netAgorot: number;
  receiptsIssued: number;
  receiptsPending: number;
}

/**
 * דוח כספי לכל עמותה בנפרד, ובנוסף שורה מאוחדת של כלל פעילות הקהילה.
 * הנתונים לעולם אינם מעורבבים בין העמותות - האיחוד הוא סכימה ולא ערבוב.
 */
export function getFinancialReport(
  db: Db,
  range: { fromDate?: string; toDate?: string } = {},
): { perOrganization: OrganizationFinancialReport[]; combined: OrganizationFinancialReport } {
  const organizations = db
    .prepare('SELECT id, name FROM organizations ORDER BY name')
    .all() as Array<{ id: number; name: string }>;

  const perOrganization = organizations.map((org) => buildReport(db, org, range));
  const combined = perOrganization.reduce<OrganizationFinancialReport>(
    (total, report) => ({
      organization: null,
      committedAgorot: total.committedAgorot + report.committedAgorot,
      collectedAgorot: total.collectedAgorot + report.collectedAgorot,
      outstandingAgorot: total.outstandingAgorot + report.outstandingAgorot,
      incomeAgorot: total.incomeAgorot + report.incomeAgorot,
      expenseAgorot: total.expenseAgorot + report.expenseAgorot,
      netAgorot: total.netAgorot + report.netAgorot,
      receiptsIssued: total.receiptsIssued + report.receiptsIssued,
      receiptsPending: total.receiptsPending + report.receiptsPending,
    }),
    {
      organization: null,
      committedAgorot: 0,
      collectedAgorot: 0,
      outstandingAgorot: 0,
      incomeAgorot: 0,
      expenseAgorot: 0,
      netAgorot: 0,
      receiptsIssued: 0,
      receiptsPending: 0,
    },
  );

  return { perOrganization, combined };
}

function buildReport(
  db: Db,
  org: { id: number; name: string },
  range: { fromDate?: string; toDate?: string },
): OrganizationFinancialReport {
  const scope: CollectionScope = { organizationId: org.id };
  if (range.fromDate) scope.fromDate = range.fromDate;
  if (range.toDate) scope.toDate = range.toDate;
  const summary = getCollectionSummary(db, scope);

  const incomeWhere = new WhereBuilder()
    .add("i.status = 'recorded'")
    .add('i.organization_id = ?', org.id);
  incomeWhere.addIf(range.fromDate, 'i.income_date >= ?', range.fromDate);
  incomeWhere.addIf(range.toDate, 'i.income_date <= ?', range.toDate);
  const income = db
    .prepare(`SELECT COALESCE(SUM(i.amount_agorot), 0) AS amount FROM incomes i ${incomeWhere.sql}`)
    .get(...incomeWhere.values) as { amount: number };

  const expenseWhere = new WhereBuilder().add('e.organization_id = ?', org.id);
  expenseWhere.addIf(range.fromDate, 'e.expense_date >= ?', range.fromDate);
  expenseWhere.addIf(range.toDate, 'e.expense_date <= ?', range.toDate);
  const expense = db
    .prepare(`SELECT COALESCE(SUM(e.amount_agorot), 0) AS amount FROM expenses e ${expenseWhere.sql}`)
    .get(...expenseWhere.values) as { amount: number };

  const receipts = db
    .prepare(
      `SELECT SUM(CASE WHEN status = 'issued' THEN 1 ELSE 0 END) AS issued,
              SUM(CASE WHEN status IN ('pending','awaiting_approval','failed') THEN 1 ELSE 0 END) AS pending
       FROM receipts WHERE organization_id = ?`,
    )
    .get(org.id) as { issued: number | null; pending: number | null };

  return {
    organization: org,
    committedAgorot: summary.committedAgorot,
    collectedAgorot: summary.collectedAgorot,
    outstandingAgorot: summary.outstandingAgorot,
    incomeAgorot: income.amount,
    expenseAgorot: expense.amount,
    netAgorot: income.amount - expense.amount,
    receiptsIssued: receipts.issued ?? 0,
    receiptsPending: receipts.pending ?? 0,
  };
}
