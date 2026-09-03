/**
 * הכנסות בפועל (Income) - סעיף 23.
 * הכנסה נוצרת אך ורק דרך payments.recordPayment, כאשר מתקבל תשלום בפועל.
 * קובץ זה מספק שאילתות בלבד.
 */

import type { Db } from '../db/index.js';
import type { IncomeReceiptStatus } from '../domain/types.js';
import { NotFoundError } from './errors.js';
import { WhereBuilder, safeOrderBy } from './util.js';

/**
 * מקור ההכנסה - מאיפה הכסף הגיע.
 *
 * ההפרדה חשובה כי מדובר בשלושה זרמים שונים לגמרי: דמי החבר החודשיים
 * הם הכנסה קבועה ללא סוף, תשלומי המקומות הם הכנסה עם סוף (היא נגמרת
 * כשההתחייבות מסולקת), וכל השאר הוא חד-פעמי.
 */
export const INCOME_SOURCES = ['recurring', 'seats', 'other'] as const;
export type IncomeSource = (typeof INCOME_SOURCES)[number];

export const INCOME_SOURCE_LABELS: Record<IncomeSource, string> = {
  recurring: 'הו״ק שוטפת',
  seats: 'הו״ק מקומות וריהוט',
  other: 'הכנסות אחרות',
};

export interface IncomeView {
  id: number;
  paymentId: number;
  source: IncomeSource;
  sourceLabel: string;
  organization: { id: number; name: string };
  member: { id: number; name: string } | null;
  commitmentId: number | null;
  eventName: string | null;
  typeName: string | null;
  amountAgorot: number;
  incomeDate: string;
  description: string | null;
  status: 'recorded' | 'reversed';
  paymentMethod: string;
  receipt: {
    required: boolean;
    issued: boolean;
    id: number | null;
    number: string | null;
    issuedAt: string | null;
    provider: string | null;
    url: string | null;
    status: IncomeReceiptStatus;
    error: string | null;
  };
  createdAt: string;
}

interface IncomeJoinedRow {
  id: number;
  payment_id: number;
  organization_id: number;
  organization_name: string;
  member_id: number | null;
  member_first_name: string | null;
  member_last_name: string | null;
  commitment_id: number | null;
  event_name: string | null;
  type_name: string | null;
  amount_agorot: number;
  income_date: string;
  description: string | null;
  status: 'recorded' | 'reversed';
  payment_method: string;
  source: IncomeSource;
  receipt_required: number;
  receipt_issued: number;
  receipt_id: number | null;
  receipt_number: string | null;
  receipt_issued_at: string | null;
  receipt_provider: string | null;
  receipt_url: string | null;
  receipt_status: IncomeReceiptStatus;
  receipt_error: string | null;
  created_at: string;
}

/**
 * סיווג מקור ההכנסה.
 *
 * הוראה שמשלמת התחייבות, או הוראה שסוגה מקום/ריהוט, היא הכנסת מקומות.
 * התנאי השני הוא רשת ביטחון עבור הוראות ישנות שאיבדו את הקישור.
 */
const SOURCE_EXPRESSION = `
  CASE
    WHEN p.standing_order_id IS NULL THEN 'other'
    WHEN so.commitment_id IS NOT NULL
      OR so.commitment_type_id = (SELECT id FROM commitment_types WHERE key = 'seat')
      THEN 'seats'
    ELSE 'recurring'
  END`;

const FROM_CLAUSE = `
  FROM incomes i
  JOIN organizations o ON o.id = i.organization_id
  JOIN payments p ON p.id = i.payment_id
  LEFT JOIN standing_orders so ON so.id = p.standing_order_id
  LEFT JOIN members m ON m.id = i.member_id
  LEFT JOIN events e ON e.id = i.event_id
  LEFT JOIN commitment_types ct ON ct.id = i.commitment_type_id
`;

const JOINED_SELECT = `
  SELECT i.*, o.name AS organization_name,
         m.first_name AS member_first_name, m.last_name AS member_last_name,
         e.name AS event_name, ct.name AS type_name,
         p.method AS payment_method,
         ${SOURCE_EXPRESSION} AS source
  ${FROM_CLAUSE}
`;

const SORT_COLUMNS: Record<string, string> = {
  date: 'i.income_date',
  amount: 'i.amount_agorot',
  member: 'm.last_name',
  receipt: 'i.receipt_status',
};

function toView(row: IncomeJoinedRow): IncomeView {
  return {
    id: row.id,
    paymentId: row.payment_id,
    source: row.source,
    sourceLabel: INCOME_SOURCE_LABELS[row.source] ?? row.source,
    organization: { id: row.organization_id, name: row.organization_name },
    member:
      row.member_id !== null
        ? {
            id: row.member_id,
            name: `${row.member_first_name ?? ''} ${row.member_last_name ?? ''}`.trim(),
          }
        : null,
    commitmentId: row.commitment_id,
    eventName: row.event_name,
    typeName: row.type_name,
    amountAgorot: row.amount_agorot,
    incomeDate: row.income_date,
    description: row.description,
    status: row.status,
    paymentMethod: row.payment_method,
    receipt: {
      required: row.receipt_required === 1,
      issued: row.receipt_issued === 1,
      id: row.receipt_id,
      number: row.receipt_number,
      issuedAt: row.receipt_issued_at,
      provider: row.receipt_provider,
      url: row.receipt_url,
      status: row.receipt_status,
      error: row.receipt_error,
    },
    createdAt: row.created_at,
  };
}

export interface IncomeFilters {
  memberId?: number;
  organizationId?: number;
  commitmentId?: number;
  eventId?: number;
  commitmentTypeId?: number;
  /** סינון לפי מקור ההכנסה. */
  source?: IncomeSource;
  fromDate?: string;
  toDate?: string;
  receiptStatus?: IncomeReceiptStatus | IncomeReceiptStatus[];
  /** ברירת מחדל: רק הכנסות תקפות. */
  includeReversed?: boolean;
  sort?: string;
  limit?: number;
  offset?: number;
}

export function listIncomes(db: Db, filters: IncomeFilters = {}): IncomeView[] {
  const where = new WhereBuilder();
  if (!filters.includeReversed) where.add("i.status = 'recorded'");
  where.addIf(filters.memberId, 'i.member_id = ?', filters.memberId);
  where.addIf(filters.organizationId, 'i.organization_id = ?', filters.organizationId);
  where.addIf(filters.commitmentId, 'i.commitment_id = ?', filters.commitmentId);
  where.addIf(filters.eventId, 'i.event_id = ?', filters.eventId);
  where.addIf(filters.commitmentTypeId, 'i.commitment_type_id = ?', filters.commitmentTypeId);
  where.addIf(filters.source, `${SOURCE_EXPRESSION} = ?`, filters.source);
  where.addIf(filters.fromDate, 'i.income_date >= ?', filters.fromDate);
  where.addIf(filters.toDate, 'i.income_date <= ?', filters.toDate);
  if (filters.receiptStatus) {
    where.addIn(
      'i.receipt_status',
      Array.isArray(filters.receiptStatus) ? filters.receiptStatus : [filters.receiptStatus],
    );
  }

  const rows = db
    .prepare(
      `${JOINED_SELECT} ${where.sql}
       ORDER BY ${safeOrderBy(filters.sort, SORT_COLUMNS, 'i.income_date DESC, i.id DESC')}
       LIMIT ? OFFSET ?`,
    )
    .all(
      ...where.values,
      Math.min(Math.max(filters.limit ?? 200, 1), 1000),
      Math.max(filters.offset ?? 0, 0),
    ) as IncomeJoinedRow[];
  return rows.map(toView);
}

/**
 * סיכום ההכנסות לפי מקור ולפי סוג.
 *
 * הסיכום מחושב על **כל** ההכנסות התואמות למסננים, ולא רק על השורות
 * שנטענו לרשימה, כדי שהמספרים למעלה לא יסתרו את מה שרואים למטה.
 */
export interface IncomeSummary {
  totalAgorot: number;
  count: number;
  bySource: Array<{
    source: IncomeSource;
    label: string;
    amountAgorot: number;
    count: number;
  }>;
  byType: Array<{ id: number | null; label: string; amountAgorot: number; count: number }>;
}

export function getIncomeSummary(db: Db, filters: IncomeFilters = {}): IncomeSummary {
  const where = new WhereBuilder();
  if (!filters.includeReversed) where.add("i.status = 'recorded'");
  where.addIf(filters.memberId, 'i.member_id = ?', filters.memberId);
  where.addIf(filters.organizationId, 'i.organization_id = ?', filters.organizationId);
  where.addIf(filters.commitmentId, 'i.commitment_id = ?', filters.commitmentId);
  where.addIf(filters.eventId, 'i.event_id = ?', filters.eventId);
  where.addIf(filters.commitmentTypeId, 'i.commitment_type_id = ?', filters.commitmentTypeId);
  where.addIf(filters.source, `${SOURCE_EXPRESSION} = ?`, filters.source);
  where.addIf(filters.fromDate, 'i.income_date >= ?', filters.fromDate);
  where.addIf(filters.toDate, 'i.income_date <= ?', filters.toDate);
  if (filters.receiptStatus) {
    where.addIn(
      'i.receipt_status',
      Array.isArray(filters.receiptStatus) ? filters.receiptStatus : [filters.receiptStatus],
    );
  }

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(i.amount_agorot), 0) AS amount, COUNT(*) AS count
       ${FROM_CLAUSE} ${where.sql}`,
    )
    .get(...where.values) as { amount: number; count: number };

  const sourceRows = db
    .prepare(
      `SELECT ${SOURCE_EXPRESSION} AS source,
              COALESCE(SUM(i.amount_agorot), 0) AS amount, COUNT(*) AS count
       ${FROM_CLAUSE} ${where.sql} GROUP BY source`,
    )
    .all(...where.values) as Array<{ source: IncomeSource; amount: number; count: number }>;
  const bySourceMap = new Map(sourceRows.map((row) => [row.source, row]));

  const typeRows = db
    .prepare(
      `SELECT i.commitment_type_id AS id, ct.name AS label,
              COALESCE(SUM(i.amount_agorot), 0) AS amount, COUNT(*) AS count
       ${FROM_CLAUSE} ${where.sql} GROUP BY i.commitment_type_id, ct.name
       ORDER BY amount DESC`,
    )
    .all(...where.values) as Array<{
    id: number | null;
    label: string | null;
    amount: number;
    count: number;
  }>;

  return {
    totalAgorot: totals.amount,
    count: totals.count,
    // כל שלושת המקורות מוחזרים תמיד, גם כשהם אפס, כדי שהמסך יציג
    // שורה יציבה ולא יקפוץ בין שתי שורות לשלוש.
    bySource: INCOME_SOURCES.map((source) => ({
      source,
      label: INCOME_SOURCE_LABELS[source],
      amountAgorot: bySourceMap.get(source)?.amount ?? 0,
      count: bySourceMap.get(source)?.count ?? 0,
    })),
    byType: typeRows.map((row) => ({
      id: row.id,
      label: row.label ?? 'ללא סוג',
      amountAgorot: row.amount,
      count: row.count,
    })),
  };
}

export function getIncome(db: Db, id: number): IncomeView {
  const row = db.prepare(`${JOINED_SELECT} WHERE i.id = ?`).get(id) as IncomeJoinedRow | undefined;
  if (!row) throw new NotFoundError(`הכנסה ${id}`);
  return toView(row);
}

/** מסמן אם הכנסה דורשת קבלה (סעיף 24). */
export function setReceiptRequired(db: Db, incomeId: number, required: boolean): IncomeView {
  const income = db.prepare('SELECT receipt_status FROM incomes WHERE id = ?').get(incomeId) as
    | { receipt_status: IncomeReceiptStatus }
    | undefined;
  if (!income) throw new NotFoundError(`הכנסה ${incomeId}`);
  if (income.receipt_status === 'issued') {
    return getIncome(db, incomeId);
  }
  db.prepare(
    `UPDATE incomes SET receipt_required = ?, receipt_status = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(required ? 1 : 0, required ? 'pending' : 'not_required', incomeId);
  return getIncome(db, incomeId);
}
