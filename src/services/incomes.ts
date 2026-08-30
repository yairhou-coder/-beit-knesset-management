/**
 * הכנסות בפועל (Income) - סעיף 23.
 * הכנסה נוצרת אך ורק דרך payments.recordPayment, כאשר מתקבל תשלום בפועל.
 * קובץ זה מספק שאילתות בלבד.
 */

import type { Db } from '../db/index.js';
import type { IncomeReceiptStatus } from '../domain/types.js';
import { NotFoundError } from './errors.js';
import { WhereBuilder, safeOrderBy } from './util.js';

export interface IncomeView {
  id: number;
  paymentId: number;
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

const JOINED_SELECT = `
  SELECT i.*, o.name AS organization_name,
         m.first_name AS member_first_name, m.last_name AS member_last_name,
         e.name AS event_name, ct.name AS type_name,
         p.method AS payment_method
  FROM incomes i
  JOIN organizations o ON o.id = i.organization_id
  JOIN payments p ON p.id = i.payment_id
  LEFT JOIN members m ON m.id = i.member_id
  LEFT JOIN events e ON e.id = i.event_id
  LEFT JOIN commitment_types ct ON ct.id = i.commitment_type_id
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
