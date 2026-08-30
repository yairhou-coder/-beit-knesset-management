/**
 * התחייבויות כספיות (Commitment / Pledge) - סעיף 23.
 *
 * עיקרון מרכזי: התחייבות איננה הכנסה. היא מייצגת חוב שנוצר.
 * ההכנסה נרשמת רק כאשר מתקבל תשלום בפועל (ראו payments.ts).
 */

import type { Db } from '../db/index.js';
import { assertPositiveAgorot } from '../domain/money.js';
import {
  COMMITMENT_STATUSES,
  PAYMENT_METHODS,
  isOneOf,
  type CommitmentStatus,
  type PaymentMethod,
} from '../domain/types.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { WhereBuilder, daysSince, safeOrderBy, today } from './util.js';

export interface CommitmentRow {
  id: number;
  member_id: number;
  organization_id: number;
  commitment_type_id: number;
  event_id: number | null;
  commitment_date: string;
  due_date: string | null;
  amount_agorot: number;
  paid_agorot: number;
  balance_agorot: number;
  status: CommitmentStatus;
  planned_payment_method: PaymentMethod | null;
  notes: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** שורת התחייבות מועשרת בשמות, כפי שהיא מוצגת במסכי הגבייה. */
interface CommitmentJoinedRow extends CommitmentRow {
  member_first_name: string;
  member_last_name: string;
  member_phone: string | null;
  member_email: string | null;
  organization_name: string;
  commitment_type_key: string;
  commitment_type_name: string;
  event_name: string | null;
  event_kind: string | null;
}

export interface CommitmentView {
  id: number;
  member: { id: number; name: string; phone: string | null; email: string | null };
  organization: { id: number; name: string };
  type: { id: number; key: string; name: string };
  event: { id: number; name: string; kind: string } | null;
  commitmentDate: string;
  dueDate: string | null;
  amountAgorot: number;
  paidAgorot: number;
  balanceAgorot: number;
  status: CommitmentStatus;
  plannedPaymentMethod: PaymentMethod | null;
  notes: string | null;
  /** כמה זמן החוב פתוח, בימים (סעיף 23). */
  ageDays: number;
  /** מספר ימי פיגור מעבר למועד האחרון לתשלום, אם קיים. */
  overdueDays: number;
  isOverdue: boolean;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommitmentInput {
  memberId: number;
  organizationId: number;
  commitmentTypeId: number;
  eventId?: number | null;
  commitmentDate?: string;
  dueDate?: string | null;
  amountAgorot: number;
  plannedPaymentMethod?: PaymentMethod | null;
  notes?: string | null;
}

/** מסננים למסך "גבייה וחובות" (סעיף 23). */
export interface CommitmentFilters {
  memberId?: number;
  memberSearch?: string;
  organizationId?: number;
  commitmentTypeId?: number;
  eventId?: number;
  status?: CommitmentStatus | CommitmentStatus[];
  /** true = רק התחייבויות עם יתרה פתוחה (פתוח או שולם חלקית). */
  outstandingOnly?: boolean;
  minAmountAgorot?: number;
  maxAmountAgorot?: number;
  fromDate?: string;
  toDate?: string;
  dueBefore?: string;
  /** חובות שפתוחים לפחות N ימים (למשל 30 / 60 בדשבורד הגבייה). */
  minAgeDays?: number;
  maxAgeDays?: number;
  overdueOnly?: boolean;
  sort?: string;
  limit?: number;
  offset?: number;
}

const JOINED_SELECT = `
  SELECT c.*,
         m.first_name AS member_first_name, m.last_name AS member_last_name,
         m.phone AS member_phone, m.email AS member_email,
         o.name AS organization_name,
         ct.key AS commitment_type_key, ct.name AS commitment_type_name,
         e.name AS event_name, e.kind AS event_kind
  FROM commitments c
  JOIN members m ON m.id = c.member_id
  JOIN organizations o ON o.id = c.organization_id
  JOIN commitment_types ct ON ct.id = c.commitment_type_id
  LEFT JOIN events e ON e.id = c.event_id
`;

const SORT_COLUMNS: Record<string, string> = {
  date: 'c.commitment_date',
  amount: 'c.amount_agorot',
  balance: 'c.balance_agorot',
  due: 'c.due_date',
  member: 'm.last_name',
  status: 'c.status',
  created: 'c.created_at',
};

export function toCommitmentView(row: CommitmentJoinedRow, reference = today()): CommitmentView {
  const isOpen = row.status === 'open' || row.status === 'partially_paid';
  const overdueDays =
    isOpen && row.due_date && row.due_date < reference ? daysSince(row.due_date, reference) : 0;
  return {
    id: row.id,
    member: {
      id: row.member_id,
      name: `${row.member_first_name} ${row.member_last_name}`.trim(),
      phone: row.member_phone,
      email: row.member_email,
    },
    organization: { id: row.organization_id, name: row.organization_name },
    type: { id: row.commitment_type_id, key: row.commitment_type_key, name: row.commitment_type_name },
    event:
      row.event_id && row.event_name
        ? { id: row.event_id, name: row.event_name, kind: row.event_kind ?? 'event' }
        : null,
    commitmentDate: row.commitment_date,
    dueDate: row.due_date,
    amountAgorot: row.amount_agorot,
    paidAgorot: row.paid_agorot,
    balanceAgorot: row.balance_agorot,
    status: row.status,
    plannedPaymentMethod: row.planned_payment_method,
    notes: row.notes,
    ageDays: isOpen ? daysSince(row.commitment_date, reference) : 0,
    overdueDays,
    isOverdue: overdueDays > 0,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildWhere(filters: CommitmentFilters): WhereBuilder {
  const where = new WhereBuilder();
  where.addIf(filters.memberId, 'c.member_id = ?', filters.memberId);
  where.addIf(filters.organizationId, 'c.organization_id = ?', filters.organizationId);
  where.addIf(filters.commitmentTypeId, 'c.commitment_type_id = ?', filters.commitmentTypeId);
  where.addIf(filters.eventId, 'c.event_id = ?', filters.eventId);

  if (filters.memberSearch?.trim()) {
    const term = `%${filters.memberSearch.trim()}%`;
    where.add(
      "(m.first_name LIKE ? OR m.last_name LIKE ? OR (m.first_name || ' ' || m.last_name) LIKE ? OR m.hebrew_name LIKE ?)",
      term,
      term,
      term,
      term,
    );
  }

  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    for (const status of statuses) {
      if (!isOneOf(COMMITMENT_STATUSES, status)) {
        throw new ValidationError(`סטטוס לא מוכר: ${String(status)}`);
      }
    }
    where.addIn('c.status', statuses);
  }

  if (filters.outstandingOnly) {
    where.add("c.status IN ('open','partially_paid')");
  }

  where.addIf(filters.minAmountAgorot, 'c.amount_agorot >= ?', filters.minAmountAgorot);
  where.addIf(filters.maxAmountAgorot, 'c.amount_agorot <= ?', filters.maxAmountAgorot);
  where.addIf(filters.fromDate, 'c.commitment_date >= ?', filters.fromDate);
  where.addIf(filters.toDate, 'c.commitment_date <= ?', filters.toDate);
  where.addIf(filters.dueBefore, 'c.due_date IS NOT NULL AND c.due_date <= ?', filters.dueBefore);

  // גיל החוב מחושב מתאריך ההתחייבות ביחס להיום.
  if (filters.minAgeDays !== undefined) {
    where.add("c.commitment_date <= date('now', ?)", `-${Math.max(0, filters.minAgeDays)} days`);
  }
  if (filters.maxAgeDays !== undefined) {
    where.add("c.commitment_date > date('now', ?)", `-${Math.max(0, filters.maxAgeDays)} days`);
  }
  if (filters.overdueOnly) {
    where.add("c.due_date IS NOT NULL AND c.due_date < date('now') AND c.status IN ('open','partially_paid')");
  }
  return where;
}

export function listCommitments(db: Db, filters: CommitmentFilters = {}): CommitmentView[] {
  const where = buildWhere(filters);
  const orderBy = safeOrderBy(filters.sort, SORT_COLUMNS, 'c.commitment_date DESC, c.id DESC');
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  const offset = Math.max(filters.offset ?? 0, 0);
  const rows = db
    .prepare(`${JOINED_SELECT} ${where.sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...where.values, limit, offset) as CommitmentJoinedRow[];
  return rows.map((row) => toCommitmentView(row));
}

export function countCommitments(db: Db, filters: CommitmentFilters = {}): number {
  const where = buildWhere(filters);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM commitments c
       JOIN members m ON m.id = c.member_id ${where.sql}`,
    )
    .get(...where.values) as { total: number };
  return row.total;
}

export function getCommitmentRow(db: Db, id: number): CommitmentRow {
  const row = db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as
    | CommitmentRow
    | undefined;
  if (!row) throw new NotFoundError(`התחייבות ${id}`);
  return row;
}

export function getCommitment(db: Db, id: number): CommitmentView {
  const row = db.prepare(`${JOINED_SELECT} WHERE c.id = ?`).get(id) as
    | CommitmentJoinedRow
    | undefined;
  if (!row) throw new NotFoundError(`התחייבות ${id}`);
  return toCommitmentView(row);
}

export function createCommitment(db: Db, input: CommitmentInput): CommitmentView {
  assertPositiveAgorot(input.amountAgorot, 'סכום ההתחייבות');

  if (input.plannedPaymentMethod && !isOneOf(PAYMENT_METHODS, input.plannedPaymentMethod)) {
    throw new ValidationError(`אמצעי תשלום לא מוכר: ${String(input.plannedPaymentMethod)}`);
  }

  const commitmentDate = input.commitmentDate ?? today();
  if (input.dueDate && input.dueDate < commitmentDate) {
    throw new ValidationError('המועד האחרון לתשלום אינו יכול להקדים את תאריך ההתחייבות');
  }

  // האירוע, אם צוין, חייב להשתייך לאותה עמותה (או להיות כלל-קהילתי).
  if (input.eventId) {
    const event = db
      .prepare('SELECT organization_id FROM events WHERE id = ?')
      .get(input.eventId) as { organization_id: number | null } | undefined;
    if (!event) throw new NotFoundError(`אירוע ${input.eventId}`);
    if (event.organization_id !== null && event.organization_id !== input.organizationId) {
      throw new ValidationError('האירוע משויך לעמותה אחרת');
    }
  }

  const result = db
    .prepare(
      `INSERT INTO commitments
         (member_id, organization_id, commitment_type_id, event_id, commitment_date, due_date,
          amount_agorot, paid_agorot, status, planned_payment_method, notes)
       VALUES (@member_id, @organization_id, @commitment_type_id, @event_id, @commitment_date,
               @due_date, @amount_agorot, 0, 'open', @planned_payment_method, @notes)`,
    )
    .run({
      member_id: input.memberId,
      organization_id: input.organizationId,
      commitment_type_id: input.commitmentTypeId,
      event_id: input.eventId ?? null,
      commitment_date: commitmentDate,
      due_date: input.dueDate ?? null,
      amount_agorot: input.amountAgorot,
      planned_payment_method: input.plannedPaymentMethod ?? null,
      notes: input.notes ?? null,
    });

  return getCommitment(db, Number(result.lastInsertRowid));
}

export function updateCommitment(
  db: Db,
  id: number,
  input: Partial<Omit<CommitmentInput, 'organizationId' | 'memberId'>>,
): CommitmentView {
  const existing = getCommitmentRow(db, id);
  if (existing.status === 'cancelled') {
    throw new ConflictError('לא ניתן לעדכן התחייבות שבוטלה');
  }

  const amount = input.amountAgorot ?? existing.amount_agorot;
  assertPositiveAgorot(amount, 'סכום ההתחייבות');
  if (amount < existing.paid_agorot) {
    throw new ValidationError(
      'לא ניתן להקטין את סכום ההתחייבות מתחת לסכום ששולם בפועל. יש לזכות תשלום תחילה.',
    );
  }

  const commitmentDate = input.commitmentDate ?? existing.commitment_date;
  const dueDate = input.dueDate !== undefined ? input.dueDate : existing.due_date;
  if (dueDate && dueDate < commitmentDate) {
    throw new ValidationError('המועד האחרון לתשלום אינו יכול להקדים את תאריך ההתחייבות');
  }

  db.prepare(
    `UPDATE commitments SET
       commitment_type_id = @commitment_type_id, event_id = @event_id,
       commitment_date = @commitment_date, due_date = @due_date,
       amount_agorot = @amount_agorot, planned_payment_method = @planned_payment_method,
       notes = @notes, status = @status, updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id,
    commitment_type_id: input.commitmentTypeId ?? existing.commitment_type_id,
    event_id: input.eventId !== undefined ? input.eventId : existing.event_id,
    commitment_date: commitmentDate,
    due_date: dueDate,
    amount_agorot: amount,
    planned_payment_method:
      input.plannedPaymentMethod !== undefined
        ? input.plannedPaymentMethod
        : existing.planned_payment_method,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    status: deriveStatus(amount, existing.paid_agorot),
  });

  return getCommitment(db, id);
}

/**
 * חישוב הסטטוס מתוך הסכומים. מקור אמת יחיד לחוקי המעבר בין הסטטוסים,
 * כדי שלא ייווצר מצב של יתרה 0 עם סטטוס "פתוח".
 */
export function deriveStatus(amountAgorot: number, paidAgorot: number): CommitmentStatus {
  if (paidAgorot <= 0) return 'open';
  if (paidAgorot >= amountAgorot) return 'paid';
  return 'partially_paid';
}

/**
 * מסנכרן את הסכום ששולם ואת הסטטוס מתוך סכום התשלומים שהושלמו.
 * זהו מקור האמת: הסכום מחושב מחדש מהתשלומים ולא מתעדכן בהפרשים,
 * כך שגם זיכוי או מחיקת תשלום מביאים ליתרה נכונה.
 *
 * חייב להיקרא בתוך טרנזקציה יחד עם השינוי בתשלומים.
 */
export function recalculateCommitmentTotals(db: Db, commitmentId: number): CommitmentRow {
  const existing = getCommitmentRow(db, commitmentId);
  const { paid } = db
    .prepare(
      `SELECT COALESCE(SUM(amount_agorot), 0) AS paid
       FROM payments WHERE commitment_id = ? AND status = 'completed'`,
    )
    .get(commitmentId) as { paid: number };

  if (paid > existing.amount_agorot) {
    throw new ConflictError(
      `סך התשלומים (${paid / 100} ₪) חורג מסכום ההתחייבות (${existing.amount_agorot / 100} ₪)`,
    );
  }

  // התחייבות שבוטלה נשארת מבוטלת; הסכום ששולם עדיין מתעדכן לצורכי דיווח.
  const status = existing.status === 'cancelled' ? 'cancelled' : deriveStatus(existing.amount_agorot, paid);

  db.prepare(
    `UPDATE commitments SET paid_agorot = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(paid, status, commitmentId);

  return getCommitmentRow(db, commitmentId);
}

export function cancelCommitment(db: Db, id: number, reason?: string): CommitmentView {
  const existing = getCommitmentRow(db, id);
  if (existing.status === 'cancelled') return getCommitment(db, id);
  if (existing.paid_agorot > 0) {
    throw new ConflictError(
      'לא ניתן לבטל התחייבות שכבר שולמה בחלקה. יש לזכות את התשלומים תחילה.',
    );
  }
  db.prepare(
    `UPDATE commitments SET status = 'cancelled', cancelled_at = datetime('now'),
       cancel_reason = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(reason ?? null, id);
  return getCommitment(db, id);
}

/** מחזיר התחייבות שבוטלה למצב פעיל. */
export function reopenCommitment(db: Db, id: number): CommitmentView {
  const existing = getCommitmentRow(db, id);
  if (existing.status !== 'cancelled') return getCommitment(db, id);
  db.prepare(
    `UPDATE commitments SET status = ?, cancelled_at = NULL, cancel_reason = NULL,
       updated_at = datetime('now') WHERE id = ?`,
  ).run(deriveStatus(existing.amount_agorot, existing.paid_agorot), id);
  return getCommitment(db, id);
}
