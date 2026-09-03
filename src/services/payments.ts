/**
 * תשלומים והכנסות - תהליך התשלום המלא (סעיף 27).
 *
 * ה-Workflow:
 *   1. נוצרת התחייבות (commitments.ts).
 *   2. מתקבל תשלום בפועל -> נרשם Payment.
 *      א. יתרת ההתחייבות מתעדכנת אוטומטית.
 *      ב. נרשמת Income - רק עכשיו, כי רק כסף שהתקבל בפועל הוא הכנסה.
 *      ג. נוצרת רשומת Receipt ומופקת קבלה (אוטומטית או לאחר אישור, סעיף 29).
 *   3. תשלום היתרה חוזר על אותו תהליך, וההתחייבות מסומנת "שולם במלואו".
 *
 * שלבים 2א-2ג רצים בטרנזקציה אחת. הקריאה לספק הקבלות מתבצעת רק *אחרי*
 * ה-commit, כדי שכשל אצל הספק לא ימחק את התשלום ואת ההכנסה (סעיף 28).
 */

import crypto from 'node:crypto';
import type { Db } from '../db/index.js';
import { assertPositiveAgorot } from '../domain/money.js';
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  isOneOf,
  type DocumentType,
  type PaymentMethod,
  type PaymentStatus,
} from '../domain/types.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { getCommitmentRow, recalculateCommitmentTotals } from './commitments.js';
import { getOrganizationRow } from './organizations.js';
import {
  ensureReceiptRecord,
  issueReceipt,
  syncIncomeReceiptFields,
  type IssueResult,
} from './receipts.js';
import { WhereBuilder, safeOrderBy, today } from './util.js';

export interface PaymentRow {
  id: number;
  organization_id: number;
  member_id: number | null;
  commitment_id: number | null;
  standing_order_id: number | null;
  amount_agorot: number;
  payment_date: string;
  method: PaymentMethod;
  status: PaymentStatus;
  idempotency_key: string;
  provider: string | null;
  provider_reference: string | null;
  provider_payload: string | null;
  failure_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface PaymentJoinedRow extends PaymentRow {
  member_first_name: string | null;
  member_last_name: string | null;
  organization_name: string;
  income_id: number | null;
  receipt_id: number | null;
  receipt_number: string | null;
  receipt_status: string | null;
}

export interface PaymentView {
  id: number;
  organization: { id: number; name: string };
  member: { id: number; name: string } | null;
  commitmentId: number | null;
  standingOrderId: number | null;
  amountAgorot: number;
  paymentDate: string;
  method: PaymentMethod;
  status: PaymentStatus;
  provider: string | null;
  providerReference: string | null;
  failureReason: string | null;
  notes: string | null;
  incomeId: number | null;
  receipt: { id: number; number: string | null; status: string } | null;
  /** תשלום שאינו משויך לחבר (סעיף 30). */
  unassigned: boolean;
  createdAt: string;
}

const JOINED_SELECT = `
  SELECT p.*,
         m.first_name AS member_first_name, m.last_name AS member_last_name,
         o.name AS organization_name,
         i.id AS income_id,
         r.id AS receipt_id, r.receipt_number AS receipt_number, r.status AS receipt_status
  FROM payments p
  JOIN organizations o ON o.id = p.organization_id
  LEFT JOIN members m ON m.id = p.member_id
  LEFT JOIN incomes i ON i.payment_id = p.id
  LEFT JOIN receipts r ON r.payment_id = p.id AND r.status != 'cancelled'
`;

const SORT_COLUMNS: Record<string, string> = {
  date: 'p.payment_date',
  amount: 'p.amount_agorot',
  member: 'm.last_name',
  status: 'p.status',
  created: 'p.created_at',
};

export function toPaymentView(row: PaymentJoinedRow): PaymentView {
  return {
    id: row.id,
    organization: { id: row.organization_id, name: row.organization_name },
    member:
      row.member_id !== null
        ? {
            id: row.member_id,
            name: `${row.member_first_name ?? ''} ${row.member_last_name ?? ''}`.trim(),
          }
        : null,
    commitmentId: row.commitment_id,
    standingOrderId: row.standing_order_id,
    amountAgorot: row.amount_agorot,
    paymentDate: row.payment_date,
    method: row.method,
    status: row.status,
    provider: row.provider,
    providerReference: row.provider_reference,
    failureReason: row.failure_reason,
    notes: row.notes,
    incomeId: row.income_id,
    receipt:
      row.receipt_id !== null
        ? { id: row.receipt_id, number: row.receipt_number, status: row.receipt_status ?? 'pending' }
        : null,
    unassigned: row.member_id === null,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// רישום תשלום
// ---------------------------------------------------------------------------

export interface RecordPaymentInput {
  /** אם צוינה התחייבות, העמותה והחבר נלקחים ממנה ואינם ניתנים לסתירה. */
  commitmentId?: number | null;
  organizationId?: number;
  memberId?: number | null;
  standingOrderId?: number | null;
  amountAgorot: number;
  paymentDate?: string;
  method: PaymentMethod;
  status?: PaymentStatus;
  /** מפתח למניעת רישום כפול של אותו תשלום. נוצר אוטומטית אם לא סופק. */
  idempotencyKey?: string;
  provider?: string | null;
  providerReference?: string | null;
  providerPayload?: unknown;
  failureReason?: string | null;
  notes?: string | null;
  /** האם ההכנסה דורשת קבלה. ברירת מחדל: כן. */
  receiptRequired?: boolean;
  /** סוג המסמך שיופק. ברירת מחדל: לפי סוג ההתחייבות או ברירת המחדל של העמותה. */
  documentType?: DocumentType;
  /**
   * סוג ההתחייבות שיירשם על ההכנסה, כאשר התשלום אינו קשור להתחייבות.
   * כך חיוב הוראת קבע שוטפת נרשם כ"דמי חבר" ולא ללא סוג.
   * כשיש התחייבות, הסוג נלקח ממנה והשדה הזה אינו בשימוש.
   */
  commitmentTypeId?: number | null;
  description?: string | null;
}

export interface RecordPaymentResult {
  payment: PaymentView;
  incomeId: number | null;
  receiptId: number | null;
  /** תוצאת ההפקה מול הספק, אם בוצע ניסיון הפקה. */
  receiptIssue?: IssueResult;
  /** מצב ההתחייבות לאחר התשלום. */
  commitment: { id: number; amountAgorot: number; paidAgorot: number; balanceAgorot: number; status: string } | null;
}

/**
 * רושם תשלום שהתקבל בפועל, מעדכן את ההתחייבות, רושם הכנסה ומפיק קבלה.
 *
 * הפעולה כולה אידמפוטנטית: קריאה חוזרת עם אותו idempotencyKey מחזירה את
 * התוצאה הקיימת ואינה יוצרת תשלום, הכנסה או קבלה נוספים (סעיף 28).
 */
export async function recordPayment(db: Db, input: RecordPaymentInput): Promise<RecordPaymentResult> {
  assertPositiveAgorot(input.amountAgorot, 'סכום התשלום');

  if (!isOneOf(PAYMENT_METHODS, input.method)) {
    throw new ValidationError(`אמצעי תשלום לא מוכר: ${String(input.method)}`);
  }
  const status = input.status ?? 'completed';
  if (!isOneOf(PAYMENT_STATUSES, status)) {
    throw new ValidationError(`סטטוס תשלום לא מוכר: ${String(status)}`);
  }

  const idempotencyKey = input.idempotencyKey?.trim() || `pay-${crypto.randomUUID()}`;

  // תשלום קיים עם אותו מפתח - מחזירים את מה שכבר נרשם.
  const existing = db
    .prepare('SELECT id FROM payments WHERE idempotency_key = ?')
    .get(idempotencyKey) as { id: number } | undefined;
  if (existing) {
    return buildResult(db, existing.id);
  }

  // --- שלב א: אימות והשלמת פרטים -------------------------------------------
  let organizationId = input.organizationId;
  let memberId = input.memberId ?? null;
  let commitmentTypeId: number | null = input.commitmentTypeId ?? null;
  let eventId: number | null = null;
  let documentType = input.documentType;

  if (input.commitmentId) {
    const commitment = getCommitmentRow(db, input.commitmentId);
    if (commitment.status === 'cancelled') {
      throw new ConflictError('לא ניתן לרשום תשלום עבור התחייבות שבוטלה');
    }
    if (organizationId !== undefined && organizationId !== commitment.organization_id) {
      throw new ValidationError('העמותה בתשלום אינה תואמת את העמותה בהתחייבות');
    }
    if (memberId !== null && memberId !== commitment.member_id) {
      throw new ValidationError('החבר בתשלום אינו תואם את החבר בהתחייבות');
    }
    // כשהסכום הכולל של ההתחייבות אינו ידוע אין יתרה לחסום מולה. הסכום
    // הרשום שם הוא רק המצטבר ששולם, וחסימה מולו הייתה דוחה כל תשלום.
    if (
      commitment.amount_confirmed === 1 &&
      status === 'completed' &&
      input.amountAgorot > commitment.balance_agorot
    ) {
      throw new ValidationError(
        `סכום התשלום (${input.amountAgorot / 100} ₪) גבוה מיתרת ההתחייבות (${commitment.balance_agorot / 100} ₪)`,
      );
    }
    organizationId = commitment.organization_id;
    memberId = commitment.member_id;
    commitmentTypeId = commitment.commitment_type_id;
    eventId = commitment.event_id;

    if (!documentType) {
      const type = db
        .prepare('SELECT document_type FROM commitment_types WHERE id = ?')
        .get(commitment.commitment_type_id) as { document_type: DocumentType } | undefined;
      documentType = type?.document_type;
    }
  }

  if (organizationId === undefined) {
    throw new ValidationError('יש לציין עמותה עבור התשלום');
  }
  const org = getOrganizationRow(db, organizationId);

  if (memberId !== null) {
    const member = db.prepare('SELECT id FROM members WHERE id = ?').get(memberId);
    if (!member) throw new NotFoundError(`חבר ${memberId}`);
  }

  // סוג המסמך חייב להיות מותר לעמותה (סעיף 25).
  const allowedTypes = parseAllowedTypes(org.allowed_document_types);
  if (!documentType || !allowedTypes.includes(documentType)) {
    documentType = allowedTypes.includes(org.default_document_type as DocumentType)
      ? (org.default_document_type as DocumentType)
      : (allowedTypes[0] ?? 'receipt');
  }

  const paymentDate = input.paymentDate ?? today();
  const receiptRequired = input.receiptRequired !== false;

  // סעיף 29: אוטומטי או רק לאחר אישור ידני, לפי הגדרת העמותה.
  const initialReceiptStatus =
    org.receipt_issue_mode === 'manual_approval' ? 'awaiting_approval' : 'pending';

  // --- שלב ב: טרנזקציה - תשלום + הכנסה + עדכון התחייבות + רשומת קבלה --------
  const txResult = db.transaction((): { paymentId: number; incomeId: number | null; receiptId: number | null } => {
    const paymentResult = db
      .prepare(
        `INSERT INTO payments
           (organization_id, member_id, commitment_id, standing_order_id, amount_agorot,
            payment_date, method, status, idempotency_key, provider, provider_reference,
            provider_payload, failure_reason, notes)
         VALUES (@organization_id, @member_id, @commitment_id, @standing_order_id, @amount_agorot,
                 @payment_date, @method, @status, @idempotency_key, @provider, @provider_reference,
                 @provider_payload, @failure_reason, @notes)`,
      )
      .run({
        organization_id: organizationId,
        member_id: memberId,
        commitment_id: input.commitmentId ?? null,
        standing_order_id: input.standingOrderId ?? null,
        amount_agorot: input.amountAgorot,
        payment_date: paymentDate,
        method: input.method,
        status,
        idempotency_key: idempotencyKey,
        provider: input.provider ?? null,
        provider_reference: input.providerReference ?? null,
        provider_payload: input.providerPayload ? JSON.stringify(input.providerPayload) : null,
        failure_reason: input.failureReason ?? null,
        notes: input.notes ?? null,
      });
    const paymentId = Number(paymentResult.lastInsertRowid);

    // תשלום שנכשל או ממתין אינו הכנסה ואינו מקטין את יתרת ההתחייבות.
    if (status !== 'completed') {
      return { paymentId, incomeId: null, receiptId: null };
    }

    // עדכון ההתחייבות: הסכום ששולם מחושב מחדש מכלל התשלומים שהושלמו.
    if (input.commitmentId) {
      recalculateCommitmentTotals(db, input.commitmentId);
    }

    // רק עכשיו נרשמת הכנסה - כסף שהתקבל בפועל (סעיף 23).
    const incomeResult = db
      .prepare(
        `INSERT INTO incomes
           (payment_id, organization_id, member_id, commitment_id, event_id, commitment_type_id,
            amount_agorot, income_date, description, receipt_required, receipt_status)
         VALUES (@payment_id, @organization_id, @member_id, @commitment_id, @event_id,
                 @commitment_type_id, @amount_agorot, @income_date, @description,
                 @receipt_required, @receipt_status)`,
      )
      .run({
        payment_id: paymentId,
        organization_id: organizationId,
        member_id: memberId,
        commitment_id: input.commitmentId ?? null,
        event_id: eventId,
        commitment_type_id: commitmentTypeId,
        amount_agorot: input.amountAgorot,
        income_date: paymentDate,
        description: input.description ?? null,
        receipt_required: receiptRequired ? 1 : 0,
        receipt_status: receiptRequired ? initialReceiptStatus : 'not_required',
      });
    const incomeId = Number(incomeResult.lastInsertRowid);

    if (!receiptRequired) {
      return { paymentId, incomeId, receiptId: null };
    }

    // רשומת הקבלה נוצרת לפני הקריאה לספק - זהו העוגן שמונע כפילות (סעיף 28).
    const receipt = ensureReceiptRecord(db, {
      paymentId,
      incomeId,
      organizationId: organizationId!,
      memberId,
      amountAgorot: input.amountAgorot,
      documentType: documentType!,
      initialStatus: initialReceiptStatus,
    });
    syncIncomeReceiptFields(db, incomeId);

    return { paymentId, incomeId, receiptId: receipt.id };
  })();

  // --- שלב ג: הפקת הקבלה מול הספק, מחוץ לטרנזקציה ---------------------------
  // אם השלב הזה נכשל, התשלום וההכנסה כבר נשמרו ואינם הולכים לאיבוד (סעיף 28).
  let receiptIssue: IssueResult | undefined;
  if (txResult.receiptId !== null && initialReceiptStatus === 'pending') {
    receiptIssue = await issueReceipt(db, txResult.receiptId);
  }

  const result = buildResult(db, txResult.paymentId);
  return receiptIssue ? { ...result, receiptIssue } : result;
}

function parseAllowedTypes(raw: string): DocumentType[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DocumentType[]) : ['receipt'];
  } catch {
    return ['receipt'];
  }
}

function buildResult(db: Db, paymentId: number): RecordPaymentResult {
  const payment = getPayment(db, paymentId);
  const commitment = payment.commitmentId ? getCommitmentRow(db, payment.commitmentId) : null;
  return {
    payment,
    incomeId: payment.incomeId,
    receiptId: payment.receipt?.id ?? null,
    commitment: commitment
      ? {
          id: commitment.id,
          amountAgorot: commitment.amount_agorot,
          paidAgorot: commitment.paid_agorot,
          balanceAgorot: commitment.balance_agorot,
          status: commitment.status,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// שאילתות
// ---------------------------------------------------------------------------

export interface PaymentFilters {
  memberId?: number;
  memberSearch?: string;
  organizationId?: number;
  commitmentId?: number;
  method?: PaymentMethod;
  status?: PaymentStatus | PaymentStatus[];
  fromDate?: string;
  toDate?: string;
  minAmountAgorot?: number;
  maxAmountAgorot?: number;
  /** רק תשלומים שלא שויכו לחבר (סעיף 30). */
  unassignedOnly?: boolean;
  sort?: string;
  limit?: number;
  offset?: number;
}

function buildWhere(filters: PaymentFilters): WhereBuilder {
  const where = new WhereBuilder();
  where.addIf(filters.memberId, 'p.member_id = ?', filters.memberId);
  where.addIf(filters.organizationId, 'p.organization_id = ?', filters.organizationId);
  where.addIf(filters.commitmentId, 'p.commitment_id = ?', filters.commitmentId);
  where.addIf(filters.method, 'p.method = ?', filters.method);
  where.addIf(filters.fromDate, 'p.payment_date >= ?', filters.fromDate);
  where.addIf(filters.toDate, 'p.payment_date <= ?', filters.toDate);
  where.addIf(filters.minAmountAgorot, 'p.amount_agorot >= ?', filters.minAmountAgorot);
  where.addIf(filters.maxAmountAgorot, 'p.amount_agorot <= ?', filters.maxAmountAgorot);
  if (filters.unassignedOnly) where.add('p.member_id IS NULL');
  if (filters.status) {
    where.addIn('p.status', Array.isArray(filters.status) ? filters.status : [filters.status]);
  }
  if (filters.memberSearch?.trim()) {
    const term = `%${filters.memberSearch.trim()}%`;
    where.add(
      "(m.first_name LIKE ? OR m.last_name LIKE ? OR (m.first_name || ' ' || m.last_name) LIKE ?)",
      term,
      term,
      term,
    );
  }
  return where;
}

export function listPayments(db: Db, filters: PaymentFilters = {}): PaymentView[] {
  const where = buildWhere(filters);
  const orderBy = safeOrderBy(filters.sort, SORT_COLUMNS, 'p.payment_date DESC, p.id DESC');
  const rows = db
    .prepare(`${JOINED_SELECT} ${where.sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(
      ...where.values,
      Math.min(Math.max(filters.limit ?? 200, 1), 1000),
      Math.max(filters.offset ?? 0, 0),
    ) as PaymentJoinedRow[];
  return rows.map(toPaymentView);
}

export function getPayment(db: Db, id: number): PaymentView {
  const row = db.prepare(`${JOINED_SELECT} WHERE p.id = ?`).get(id) as PaymentJoinedRow | undefined;
  if (!row) throw new NotFoundError(`תשלום ${id}`);
  return toPaymentView(row);
}

/** שיוך תשלום "יתום" לחבר, ועדכון ההכנסה והקבלה בהתאם (סעיף 30). */
export function assignPaymentToMember(
  db: Db,
  paymentId: number,
  memberId: number,
  commitmentId?: number | null,
): PaymentView {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as
    | PaymentRow
    | undefined;
  if (!payment) throw new NotFoundError(`תשלום ${paymentId}`);

  const member = db.prepare('SELECT id FROM members WHERE id = ?').get(memberId);
  if (!member) throw new NotFoundError(`חבר ${memberId}`);

  db.transaction(() => {
    let commitmentTypeId: number | null = null;
    let eventId: number | null = null;

    if (commitmentId) {
      const commitment = getCommitmentRow(db, commitmentId);
      if (commitment.member_id !== memberId) {
        throw new ValidationError('ההתחייבות שייכת לחבר אחר');
      }
      if (commitment.organization_id !== payment.organization_id) {
        throw new ValidationError('ההתחייבות שייכת לעמותה אחרת');
      }
      if (payment.status === 'completed' && payment.amount_agorot > commitment.balance_agorot) {
        throw new ValidationError('סכום התשלום גבוה מיתרת ההתחייבות');
      }
      commitmentTypeId = commitment.commitment_type_id;
      eventId = commitment.event_id;
    }

    db.prepare(
      `UPDATE payments SET member_id = ?, commitment_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(memberId, commitmentId ?? payment.commitment_id, paymentId);

    db.prepare(
      `UPDATE incomes SET member_id = ?, commitment_id = ?, commitment_type_id = ?, event_id = ?,
         updated_at = datetime('now') WHERE payment_id = ?`,
    ).run(
      memberId,
      commitmentId ?? payment.commitment_id,
      commitmentTypeId,
      eventId,
      paymentId,
    );

    db.prepare(`UPDATE receipts SET member_id = ?, updated_at = datetime('now') WHERE payment_id = ?`).run(
      memberId,
      paymentId,
    );

    if (commitmentId) recalculateCommitmentTotals(db, commitmentId);
    if (payment.commitment_id && payment.commitment_id !== commitmentId) {
      recalculateCommitmentTotals(db, payment.commitment_id);
    }
  })();

  return getPayment(db, paymentId);
}

/**
 * זיכוי תשלום. ההכנסה מבוטלת ויתרת ההתחייבות גדלה בחזרה.
 * הקבלה נותרת לצורכי ביקורת - ביטולה מול הספק נעשה בנפרד.
 */
export function refundPayment(db: Db, paymentId: number, reason?: string): PaymentView {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as
    | PaymentRow
    | undefined;
  if (!payment) throw new NotFoundError(`תשלום ${paymentId}`);
  if (payment.status === 'refunded') return getPayment(db, paymentId);
  if (payment.status !== 'completed') {
    throw new ConflictError('ניתן לזכות רק תשלום שהושלם');
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE payments SET status = 'refunded', failure_reason = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(reason ?? null, paymentId);
    // ההכנסה אינה נמחקת אלא מסומנת כמבוטלת - רשומה כספית נשמרת לצורכי ביקורת,
    // והדוחות סופרים רק הכנסות בסטטוס recorded.
    db.prepare(
      `UPDATE incomes SET status = 'reversed', reversed_at = datetime('now'),
         reversal_reason = ?, updated_at = datetime('now')
       WHERE payment_id = ? AND status = 'recorded'`,
    ).run(reason ?? null, paymentId);
    if (payment.commitment_id) recalculateCommitmentTotals(db, payment.commitment_id);
  })();

  return getPayment(db, paymentId);
}
