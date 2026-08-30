/**
 * קבלות ומסמכים כספיים (סעיפים 24, 28, 29).
 *
 * עקרונות:
 *  1. רשומת הקבלה נוצרת בבסיס הנתונים *לפני* הקריאה לספק, עם מפתח ייחודי.
 *     כך גם אם הקריאה נכשלת או נקטעת - התשלום וההכנסה נשמרים, והקבלה
 *     נשארת בסטטוס "ממתין להפקה" עם אפשרות לנסות שוב (סעיף 28).
 *  2. אינדקס ייחודי על payment_id (למעט קבלות מבוטלות) + idempotency_key
 *     מונעים הפקת שתי קבלות לאותו תשלום.
 *  3. אופן ההפקה - אוטומטי או לאחר אישור ידני - נקבע לכל עמותה בנפרד (סעיף 29).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import type { DocumentType, ReceiptStatus } from '../domain/types.js';
import { ProviderError, ProviderNotSupportedError } from '../integrations/types.js';
import { resolveReceiptProvider } from '../integrations/registry.js';
import { raiseAlert, resolveAlertsFor } from './alerts.js';
import { AppError, ConflictError, NotFoundError } from './errors.js';
import { getOrganizationRow } from './organizations.js';
import { WhereBuilder, safeOrderBy } from './util.js';

export interface ReceiptRow {
  id: number;
  organization_id: number;
  payment_id: number;
  income_id: number;
  member_id: number | null;
  idempotency_key: string;
  document_type: DocumentType;
  amount_agorot: number;
  status: ReceiptStatus;
  provider: string;
  provider_receipt_id: string | null;
  receipt_number: string | null;
  issued_at: string | null;
  url: string | null;
  pdf_path: string | null;
  attempts: number;
  last_attempt_at: string | null;
  error_message: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ReceiptJoinedRow extends ReceiptRow {
  member_first_name: string | null;
  member_last_name: string | null;
  organization_name: string;
  payment_method: string;
  payment_date: string;
  commitment_type_name: string | null;
}

export interface ReceiptView {
  id: number;
  organization: { id: number; name: string };
  member: { id: number; name: string } | null;
  paymentId: number;
  incomeId: number;
  documentType: DocumentType;
  amountAgorot: number;
  status: ReceiptStatus;
  provider: string;
  providerReceiptId: string | null;
  receiptNumber: string | null;
  issuedAt: string | null;
  url: string | null;
  hasPdf: boolean;
  attempts: number;
  lastAttemptAt: string | null;
  errorMessage: string | null;
  paymentMethod: string;
  paymentDate: string;
  commitmentTypeName: string | null;
  createdAt: string;
}

const JOINED_SELECT = `
  SELECT r.*,
         m.first_name AS member_first_name, m.last_name AS member_last_name,
         o.name AS organization_name,
         p.method AS payment_method, p.payment_date AS payment_date,
         ct.name AS commitment_type_name
  FROM receipts r
  JOIN organizations o ON o.id = r.organization_id
  JOIN payments p ON p.id = r.payment_id
  LEFT JOIN members m ON m.id = r.member_id
  LEFT JOIN incomes i ON i.id = r.income_id
  LEFT JOIN commitment_types ct ON ct.id = i.commitment_type_id
`;

const SORT_COLUMNS: Record<string, string> = {
  date: 'COALESCE(r.issued_at, r.created_at)',
  amount: 'r.amount_agorot',
  number: 'r.receipt_number',
  status: 'r.status',
  member: 'm.last_name',
};

function toView(row: ReceiptJoinedRow): ReceiptView {
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
    paymentId: row.payment_id,
    incomeId: row.income_id,
    documentType: row.document_type,
    amountAgorot: row.amount_agorot,
    status: row.status,
    provider: row.provider,
    providerReceiptId: row.provider_receipt_id,
    receiptNumber: row.receipt_number,
    issuedAt: row.issued_at,
    url: row.url,
    hasPdf: Boolean(row.pdf_path),
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    errorMessage: row.error_message,
    paymentMethod: row.payment_method,
    paymentDate: row.payment_date,
    commitmentTypeName: row.commitment_type_name,
    createdAt: row.created_at,
  };
}

/** מסננים למסך "קבלות ומסמכים" (סעיף 24). */
export interface ReceiptFilters {
  memberId?: number;
  memberSearch?: string;
  receiptNumber?: string;
  organizationId?: number;
  status?: ReceiptStatus | ReceiptStatus[];
  documentType?: DocumentType;
  paymentMethod?: string;
  fromDate?: string;
  toDate?: string;
  minAmountAgorot?: number;
  maxAmountAgorot?: number;
  sort?: string;
  limit?: number;
  offset?: number;
}

function buildWhere(filters: ReceiptFilters): WhereBuilder {
  const where = new WhereBuilder();
  where.addIf(filters.memberId, 'r.member_id = ?', filters.memberId);
  where.addIf(filters.organizationId, 'r.organization_id = ?', filters.organizationId);
  where.addIf(filters.documentType, 'r.document_type = ?', filters.documentType);
  where.addIf(filters.paymentMethod, 'p.method = ?', filters.paymentMethod);
  where.addIf(filters.minAmountAgorot, 'r.amount_agorot >= ?', filters.minAmountAgorot);
  where.addIf(filters.maxAmountAgorot, 'r.amount_agorot <= ?', filters.maxAmountAgorot);
  where.addIf(filters.fromDate, 'date(COALESCE(r.issued_at, r.created_at)) >= ?', filters.fromDate);
  where.addIf(filters.toDate, 'date(COALESCE(r.issued_at, r.created_at)) <= ?', filters.toDate);
  if (filters.receiptNumber?.trim()) {
    where.add('r.receipt_number LIKE ?', `%${filters.receiptNumber.trim()}%`);
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
  if (filters.status) {
    where.addIn('r.status', Array.isArray(filters.status) ? filters.status : [filters.status]);
  }
  return where;
}

export function listReceipts(db: Db, filters: ReceiptFilters = {}): ReceiptView[] {
  const where = buildWhere(filters);
  const orderBy = safeOrderBy(filters.sort, SORT_COLUMNS, 'COALESCE(r.issued_at, r.created_at) DESC, r.id DESC');
  const rows = db
    .prepare(`${JOINED_SELECT} ${where.sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(
      ...where.values,
      Math.min(Math.max(filters.limit ?? 200, 1), 1000),
      Math.max(filters.offset ?? 0, 0),
    ) as ReceiptJoinedRow[];
  return rows.map(toView);
}

export function getReceipt(db: Db, id: number): ReceiptView {
  const row = db.prepare(`${JOINED_SELECT} WHERE r.id = ?`).get(id) as ReceiptJoinedRow | undefined;
  if (!row) throw new NotFoundError(`קבלה ${id}`);
  return toView(row);
}

export function getReceiptRow(db: Db, id: number): ReceiptRow {
  const row = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as ReceiptRow | undefined;
  if (!row) throw new NotFoundError(`קבלה ${id}`);
  return row;
}

// ---------------------------------------------------------------------------
// יצירת רשומת קבלה ו"הפקה" בפועל
// ---------------------------------------------------------------------------

/**
 * בונה מפתח idempotency יציב לתשלום.
 * ה-generation עולה רק כאשר קבלה קודמת בוטלה ומופקת קבלה חלופית,
 * כך שניסיון חוזר רגיל תמיד משתמש באותו מפתח ולא יוצר כפילות.
 */
export function buildIdempotencyKey(paymentId: number, generation: number): string {
  return `payment-${paymentId}-receipt-${generation}`;
}

interface EnsureReceiptOptions {
  paymentId: number;
  incomeId: number;
  organizationId: number;
  memberId: number | null;
  amountAgorot: number;
  documentType: DocumentType;
  /** 'pending' = ימתין להפקה, 'awaiting_approval' = ימתין לאישור גזבר (סעיף 29). */
  initialStatus: Extract<ReceiptStatus, 'pending' | 'awaiting_approval'>;
}

/**
 * מבטיח קיום רשומת קבלה פעילה אחת בדיוק לתשלום.
 * חייב לרוץ בתוך אותה טרנזקציה שבה נרשמים התשלום וההכנסה.
 */
export function ensureReceiptRecord(db: Db, options: EnsureReceiptOptions): ReceiptRow {
  const existing = db
    .prepare(`SELECT * FROM receipts WHERE payment_id = ? AND status != 'cancelled'`)
    .get(options.paymentId) as ReceiptRow | undefined;
  if (existing) return existing;

  const cancelledCount = db
    .prepare(`SELECT COUNT(*) AS total FROM receipts WHERE payment_id = ?`)
    .get(options.paymentId) as { total: number };

  const org = getOrganizationRow(db, options.organizationId);
  const key = buildIdempotencyKey(options.paymentId, cancelledCount.total);

  const result = db
    .prepare(
      `INSERT INTO receipts
         (organization_id, payment_id, income_id, member_id, idempotency_key,
          document_type, amount_agorot, status, provider)
       VALUES (@organization_id, @payment_id, @income_id, @member_id, @idempotency_key,
               @document_type, @amount_agorot, @status, @provider)`,
    )
    .run({
      organization_id: options.organizationId,
      payment_id: options.paymentId,
      income_id: options.incomeId,
      member_id: options.memberId,
      idempotency_key: key,
      document_type: options.documentType,
      amount_agorot: options.amountAgorot,
      status: options.initialStatus,
      provider: org.receipt_provider,
    });

  return getReceiptRow(db, Number(result.lastInsertRowid));
}

/** מסנכרן את שדות הקבלה שעל ההכנסה (סעיף 24). */
export function syncIncomeReceiptFields(db: Db, incomeId: number): void {
  const receipt = db
    .prepare(`SELECT * FROM receipts WHERE income_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1`)
    .get(incomeId) as ReceiptRow | undefined;

  if (!receipt) {
    const income = db
      .prepare('SELECT receipt_required FROM incomes WHERE id = ?')
      .get(incomeId) as { receipt_required: number } | undefined;
    if (!income) return;
    db.prepare(
      `UPDATE incomes SET receipt_id = NULL, receipt_issued = 0, receipt_number = NULL,
         receipt_issued_at = NULL, receipt_provider = NULL, receipt_url = NULL,
         receipt_status = ?, receipt_error = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(income.receipt_required === 1 ? 'pending' : 'not_required', incomeId);
    return;
  }

  db.prepare(
    `UPDATE incomes SET
       receipt_id = @receipt_id, receipt_issued = @receipt_issued, receipt_number = @receipt_number,
       receipt_issued_at = @receipt_issued_at, receipt_provider = @receipt_provider,
       receipt_url = @receipt_url, receipt_status = @receipt_status, receipt_error = @receipt_error,
       updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id: incomeId,
    receipt_id: receipt.id,
    receipt_issued: receipt.status === 'issued' ? 1 : 0,
    receipt_number: receipt.receipt_number,
    receipt_issued_at: receipt.issued_at,
    receipt_provider: receipt.provider,
    receipt_url: receipt.url,
    receipt_status: receipt.status,
    receipt_error: receipt.error_message,
  });
}

export interface IssueResult {
  receipt: ReceiptView;
  issued: boolean;
  error?: string;
}

/**
 * מפיק קבלה מול הספק.
 *
 * הקריאה לספק נעשית *מחוץ* לטרנזקציה, ולאחר שהתשלום וההכנסה כבר נשמרו.
 * כשל בהפקה לעולם אינו מבטל את התשלום או ההכנסה (סעיף 28).
 */
export async function issueReceipt(db: Db, receiptId: number): Promise<IssueResult> {
  const receipt = getReceiptRow(db, receiptId);

  if (receipt.status === 'issued') {
    // כבר הופקה - מניעת הפקה כפולה.
    return { receipt: getReceipt(db, receiptId), issued: true };
  }
  if (receipt.status === 'cancelled') {
    throw new ConflictError('לא ניתן להפיק קבלה שבוטלה. יש להפיק קבלה חדשה.');
  }

  const org = getOrganizationRow(db, receipt.organization_id);
  const provider = resolveReceiptProvider(org);

  const details = db
    .prepare(
      `SELECT p.method, p.payment_date, i.description, i.commitment_id,
              m.first_name, m.last_name, m.email, m.phone, m.address
       FROM payments p
       JOIN incomes i ON i.id = ?
       LEFT JOIN members m ON m.id = p.member_id
       WHERE p.id = ?`,
    )
    .get(receipt.income_id, receipt.payment_id) as
    | {
        method: string;
        payment_date: string;
        description: string | null;
        commitment_id: number | null;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        address: string | null;
      }
    | undefined;

  if (!details) throw new NotFoundError(`נתוני התשלום עבור קבלה ${receiptId}`);

  db.prepare(
    `UPDATE receipts SET attempts = attempts + 1, last_attempt_at = datetime('now'),
       provider = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(provider.key, receiptId);

  try {
    const result = await provider.createReceipt({
      idempotencyKey: receipt.idempotency_key,
      documentType: receipt.document_type,
      amountAgorot: receipt.amount_agorot,
      currency: 'ILS',
      issueDate: details.payment_date,
      description: details.description ?? 'תשלום',
      paymentMethod: details.method,
      customer: {
        memberId: receipt.member_id,
        name:
          `${details.first_name ?? ''} ${details.last_name ?? ''}`.trim() || 'תורם ללא שיוך לחבר',
        email: details.email,
        phone: details.phone,
        address: details.address,
      },
      reference: {
        paymentId: receipt.payment_id,
        incomeId: receipt.income_id,
        commitmentId: details.commitment_id,
        organizationId: receipt.organization_id,
      },
    });

    const status: ReceiptStatus =
      result.status === 'issued' ? 'issued' : result.status === 'cancelled' ? 'cancelled' : 'pending';

    db.prepare(
      `UPDATE receipts SET status = ?, provider_receipt_id = ?, receipt_number = ?,
         issued_at = ?, url = ?, error_message = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      status,
      result.providerReceiptId,
      result.receiptNumber,
      result.issuedAt,
      result.url,
      receiptId,
    );

    syncIncomeReceiptFields(db, receipt.income_id);
    resolveAlertsFor(db, 'receipt', receiptId, 'receipt_failed');

    return { receipt: getReceipt(db, receiptId), issued: status === 'issued' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = error instanceof ProviderError ? error.retryable : true;

    // סעיף 28: התשלום וההכנסה נשארים. הקבלה נשארת "ממתין להפקה" אם ניתן לנסות שוב.
    db.prepare(
      `UPDATE receipts SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(retryable ? 'pending' : 'failed', message, receiptId);

    syncIncomeReceiptFields(db, receipt.income_id);

    raiseAlert(db, {
      severity: 'error',
      kind: 'receipt_failed',
      title: `הפקת קבלה נכשלה (תשלום ${receipt.payment_id})`,
      message: retryable
        ? `${message}. הקבלה ממתינה להפקה וניתן לנסות שוב.`
        : `${message}. נדרשת התערבות ידנית.`,
      organizationId: receipt.organization_id,
      relatedType: 'receipt',
      relatedId: receiptId,
    });

    return { receipt: getReceipt(db, receiptId), issued: false, error: message };
  }
}

/** ניסיון חוזר להפקת קבלה שנכשלה או ממתינה (סעיף 28). */
export async function retryReceipt(db: Db, receiptId: number): Promise<IssueResult> {
  const receipt = getReceiptRow(db, receiptId);
  if (receipt.status === 'awaiting_approval') {
    throw new ConflictError('הקבלה ממתינה לאישור גזבר. יש לאשר אותה תחילה.');
  }
  return issueReceipt(db, receiptId);
}

/** מפיק בבת אחת את כל הקבלות הממתינות (סעיף 28 + מסך הגבייה). */
export async function retryAllPending(
  db: Db,
  filters: { organizationId?: number; limit?: number } = {},
): Promise<{ attempted: number; issued: number; failed: number }> {
  const where = new WhereBuilder().add(`status IN ('pending','failed')`);
  where.addIf(filters.organizationId, 'organization_id = ?', filters.organizationId);
  const rows = db
    .prepare(`SELECT id FROM receipts ${where.sql} ORDER BY id LIMIT ?`)
    .all(...where.values, Math.min(filters.limit ?? 50, 200)) as Array<{ id: number }>;

  let issued = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await issueReceipt(db, row.id);
    if (result.issued) issued += 1;
    else failed += 1;
  }
  return { attempted: rows.length, issued, failed };
}

/** אישור ידני של גזבר/מנהל להפקת קבלה (סעיף 29). */
export async function approveReceipt(db: Db, receiptId: number): Promise<IssueResult> {
  const receipt = getReceiptRow(db, receiptId);
  if (receipt.status !== 'awaiting_approval') {
    throw new ConflictError('הקבלה אינה ממתינה לאישור');
  }
  db.prepare(`UPDATE receipts SET status = 'pending', updated_at = datetime('now') WHERE id = ?`).run(
    receiptId,
  );
  syncIncomeReceiptFields(db, receipt.income_id);
  return issueReceipt(db, receiptId);
}

/** ביטול קבלה מול הספק, אם הספק תומך בכך. */
export async function cancelReceipt(db: Db, receiptId: number, reason?: string): Promise<ReceiptView> {
  const receipt = getReceiptRow(db, receiptId);
  if (receipt.status === 'cancelled') return getReceipt(db, receiptId);

  const org = getOrganizationRow(db, receipt.organization_id);
  const provider = resolveReceiptProvider(org);

  if (receipt.provider_receipt_id) {
    if (!provider.supportsCancel) {
      throw new AppError(
        `ספק הקבלות ${provider.displayName} אינו תומך בביטול קבלה`,
        422,
        'not_supported',
      );
    }
    try {
      await provider.cancelReceipt(receipt.provider_receipt_id, reason);
    } catch (error) {
      if (error instanceof ProviderNotSupportedError) {
        throw new AppError(error.message, 422, 'not_supported');
      }
      throw new AppError(
        `ביטול הקבלה אצל הספק נכשל: ${error instanceof Error ? error.message : String(error)}`,
        502,
        'provider_error',
      );
    }
  }

  db.prepare(
    `UPDATE receipts SET status = 'cancelled', cancelled_at = datetime('now'),
       cancel_reason = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(reason ?? null, receiptId);

  syncIncomeReceiptFields(db, receipt.income_id);
  return getReceipt(db, receiptId);
}

/** מוריד את קובץ ה-PDF מהספק ושומר אותו מקומית. */
export async function downloadReceiptPdf(
  db: Db,
  receiptId: number,
): Promise<{ filename: string; contentType: string; data: Buffer }> {
  const receipt = getReceiptRow(db, receiptId);
  if (!receipt.provider_receipt_id) {
    throw new ConflictError('הקבלה טרם הופקה אצל הספק');
  }

  // אם כבר הורדנו את הקובץ בעבר, אין צורך לפנות שוב לספק.
  if (receipt.pdf_path && fs.existsSync(receipt.pdf_path)) {
    return {
      filename: path.basename(receipt.pdf_path),
      contentType: 'application/pdf',
      data: fs.readFileSync(receipt.pdf_path),
    };
  }

  const org = getOrganizationRow(db, receipt.organization_id);
  const provider = resolveReceiptProvider(org);
  if (!provider.supportsDownload) {
    throw new AppError(
      `ספק הקבלות ${provider.displayName} אינו תומך בהורדת מסמך`,
      422,
      'not_supported',
    );
  }

  const download = await provider.downloadReceipt(receipt.provider_receipt_id);
  const dir = path.join(config.receiptStorageDir, String(receipt.organization_id));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `receipt-${receipt.id}.pdf`);
  fs.writeFileSync(filePath, download.data);
  db.prepare(`UPDATE receipts SET pdf_path = ?, updated_at = datetime('now') WHERE id = ?`).run(
    filePath,
    receiptId,
  );

  return download;
}

/** בדיקת סטטוס מול הספק וסנכרון (למשל אחרי תקלה שבה התשובה אבדה). */
export async function refreshReceiptStatus(db: Db, receiptId: number): Promise<ReceiptView> {
  const receipt = getReceiptRow(db, receiptId);
  if (!receipt.provider_receipt_id) return getReceipt(db, receiptId);

  const org = getOrganizationRow(db, receipt.organization_id);
  const provider = resolveReceiptProvider(org);
  const providerStatus = await provider.checkReceiptStatus(receipt.provider_receipt_id);
  const status: ReceiptStatus =
    providerStatus === 'issued'
      ? 'issued'
      : providerStatus === 'cancelled'
        ? 'cancelled'
        : providerStatus === 'failed'
          ? 'failed'
          : 'pending';

  db.prepare(`UPDATE receipts SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
    status,
    receiptId,
  );
  syncIncomeReceiptFields(db, receipt.income_id);
  return getReceipt(db, receiptId);
}
