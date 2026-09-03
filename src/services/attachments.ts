/**
 * חשבוניות וקבצים מצורפים להוצאה.
 *
 * הקבצים נשמרים בתיקיית הנתונים המקומית, ומפתח הרשומה בבסיס הנתונים מצביע
 * אליהם. הקובץ עצמו אינו נשמר בבסיס הנתונים, כדי שלא יתנפח.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import type { Db } from '../db/index.js';
import type { ExtractedInvoice, UploadedFile } from '../integrations/types.js';
import { HeuristicInvoiceProvider } from '../integrations/invoices/heuristic.js';
import { AppError, NotFoundError, ValidationError } from './errors.js';
import { getExpense } from './expenses.js';

const ATTACHMENTS_DIR = path.resolve(PROJECT_ROOT, 'data', 'attachments');

/** סוגי קבצים מותרים לצירוף. */
const ALLOWED_TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/webp': '.webp',
};

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB

const invoiceProvider = new HeuristicInvoiceProvider();

export interface AttachmentView {
  id: number;
  expenseId: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

interface AttachmentRow {
  id: number;
  expense_id: number;
  filename: string;
  stored_path: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
}

function toView(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    expenseId: row.expense_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedAt: row.uploaded_at,
  };
}

/** מפענח קובץ שהגיע כ-base64 ומאמת אותו. */
export function decodeUpload(input: {
  filename?: unknown;
  mimeType?: unknown;
  dataBase64?: unknown;
}): UploadedFile {
  const filename = typeof input.filename === 'string' ? input.filename.trim() : '';
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim() : '';
  const base64 = typeof input.dataBase64 === 'string' ? input.dataBase64 : '';

  if (!filename) throw new ValidationError('חסר שם הקובץ');
  if (!ALLOWED_TYPES[mimeType]) {
    throw new ValidationError(
      `סוג קובץ שאינו נתמך: ${mimeType || 'לא ידוע'}. ניתן לצרף PDF או תמונה.`,
    );
  }
  if (!base64) throw new ValidationError('הקובץ ריק');

  // מקבל גם data URL מלא מהדפדפן
  const payload = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const data = Buffer.from(payload, 'base64');
  if (data.length === 0) throw new ValidationError('לא ניתן לקרוא את הקובץ');
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new ValidationError(
      `הקובץ גדול מדי (${Math.round(data.length / 1024 / 1024)}MB). המגבלה היא 15MB.`,
    );
  }

  return { filename, mimeType, data };
}

/** מצרף קובץ להוצאה קיימת. */
export function attachToExpense(db: Db, expenseId: number, file: UploadedFile): AttachmentView {
  const expense = getExpense(db, expenseId); // מאמת קיום

  const dir = path.join(ATTACHMENTS_DIR, String(expense.organization.id), String(expenseId));
  fs.mkdirSync(dir, { recursive: true });

  const extension = ALLOWED_TYPES[file.mimeType] ?? '.bin';
  const storedPath = path.join(dir, `${crypto.randomBytes(8).toString('hex')}${extension}`);
  fs.writeFileSync(storedPath, file.data);

  const result = db
    .prepare(
      `INSERT INTO expense_attachments (expense_id, filename, stored_path, mime_type, size_bytes)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(expenseId, file.filename, storedPath, file.mimeType, file.data.length);

  return getAttachment(db, Number(result.lastInsertRowid));
}

export function getAttachment(db: Db, id: number): AttachmentView {
  const row = db.prepare('SELECT * FROM expense_attachments WHERE id = ?').get(id) as
    | AttachmentRow
    | undefined;
  if (!row) throw new NotFoundError(`קובץ מצורף ${id}`);
  return toView(row);
}

/** מחזיר את תוכן הקובץ להורדה או לצפייה. */
export function readAttachment(
  db: Db,
  id: number,
): { filename: string; mimeType: string; data: Buffer } {
  const row = db.prepare('SELECT * FROM expense_attachments WHERE id = ?').get(id) as
    | AttachmentRow
    | undefined;
  if (!row) throw new NotFoundError(`קובץ מצורף ${id}`);
  if (!fs.existsSync(row.stored_path)) {
    throw new AppError('הקובץ המצורף אינו נמצא בדיסק', 410, 'file_missing');
  }
  return {
    filename: row.filename,
    mimeType: row.mime_type,
    data: fs.readFileSync(row.stored_path),
  };
}

export function deleteAttachment(db: Db, id: number): void {
  const row = db.prepare('SELECT * FROM expense_attachments WHERE id = ?').get(id) as
    | AttachmentRow
    | undefined;
  if (!row) throw new NotFoundError(`קובץ מצורף ${id}`);
  fs.rmSync(row.stored_path, { force: true });
  db.prepare('DELETE FROM expense_attachments WHERE id = ?').run(id);
}

/**
 * קורא חשבונית ומחזיר הצעה לשדות ההוצאה.
 * ההצעה ממלאת את הטופס מראש - היא אינה יוצרת הוצאה בעצמה.
 */
export async function suggestFromInvoice(file: UploadedFile): Promise<ExtractedInvoice> {
  return invoiceProvider.extract(file);
}

export function invoiceProviderInfo(): { key: string; displayName: string; supportsScannedImages: boolean } {
  return {
    key: invoiceProvider.key,
    displayName: invoiceProvider.displayName,
    supportsScannedImages: invoiceProvider.supportsScannedImages,
  };
}

export { ATTACHMENTS_DIR, ALLOWED_TYPES };
