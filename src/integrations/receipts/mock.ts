/**
 * Mock ReceiptProvider - מימוש מלא לצורכי פיתוח ובדיקות מקצה לקצה (סעיף 26).
 *
 * מדמה מערכת הפקת קבלות אמיתית, כולל:
 *  - מספור רץ של קבלות.
 *  - Idempotency: אותו idempotencyKey מחזיר תמיד את אותה קבלה ולא יוצר קבלה שנייה.
 *  - יצירת "PDF" להורדה.
 *  - ביטול קבלה ובדיקת סטטוס.
 *  - הדמיית כשלים (failureRate / failNext) לבדיקת מסלול הכשל של סעיף 28.
 */

import crypto from 'node:crypto';
import type {
  CreateReceiptRequest,
  ProviderReceiptStatus,
  ReceiptDownload,
  ReceiptProvider,
  ReceiptResult,
} from '../types.js';
import { ProviderError } from '../types.js';
import { formatAgorot } from '../../domain/money.js';
import type { DocumentType } from '../../domain/types.js';

interface StoredReceipt {
  providerReceiptId: string;
  idempotencyKey: string;
  receiptNumber: string;
  status: ProviderReceiptStatus;
  issuedAt: string | null;
  amountAgorot: number;
  documentType: DocumentType;
  url: string;
  request: CreateReceiptRequest;
  cancelReason?: string;
}

export interface MockReceiptProviderOptions {
  key?: string;
  displayName?: string;
  /** מספר הקבלה הראשון שיופק. */
  startingNumber?: number;
  /** הסתברות לכשל אקראי (0..1), לבדיקות עמידות. */
  failureRate?: number;
  supportsCancel?: boolean;
  /** תחילית למספרי קבלות, למשל "BK" לבית הכנסת. */
  numberPrefix?: string;
  baseUrl?: string;
}

export class MockReceiptProvider implements ReceiptProvider {
  readonly key: string;
  readonly displayName: string;
  readonly supportsCancel: boolean;
  readonly supportsDownload = true;

  private readonly byId = new Map<string, StoredReceipt>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private nextNumber: number;
  private readonly failureRate: number;
  private readonly numberPrefix: string;
  private readonly baseUrl: string;

  /**
   * כאשר מוגדר, הקריאה הבאה ל-createReceipt תיכשל עם שגיאה זו.
   * נועד לבדיקות דטרמיניסטיות של מסלול הכשל.
   */
  private failNextError: ProviderError | null = null;
  /** מדמה חוסר זמינות מוחלט של ה-API. */
  private offline = false;

  constructor(options: MockReceiptProviderOptions = {}) {
    this.key = options.key ?? 'mock';
    this.displayName = options.displayName ?? 'ספק קבלות לדוגמה (Mock)';
    this.supportsCancel = options.supportsCancel ?? true;
    this.nextNumber = options.startingNumber ?? 12501;
    this.failureRate = options.failureRate ?? 0;
    this.numberPrefix = options.numberPrefix ?? '';
    this.baseUrl = options.baseUrl ?? 'https://receipts.mock.local';
  }

  // --- שליטה בהדמיה (לשימוש בטסטים ובסביבת פיתוח בלבד) --------------------

  failNextCall(error?: ProviderError): void {
    this.failNextError =
      error ??
      new ProviderError('מערכת הקבלות אינה זמינה כרגע', {
        provider: this.key,
        code: 'service_unavailable',
        retryable: true,
      });
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
  }

  private guardAvailability(): void {
    if (this.offline) {
      throw new ProviderError('אין תקשורת עם מערכת הקבלות', {
        provider: this.key,
        code: 'network_error',
        retryable: true,
      });
    }
    if (this.failNextError) {
      const error = this.failNextError;
      this.failNextError = null;
      throw error;
    }
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      throw new ProviderError('שגיאה זמנית במערכת הקבלות', {
        provider: this.key,
        code: 'temporary_failure',
        retryable: true,
      });
    }
  }

  // --- הממשק ---------------------------------------------------------------

  async createReceipt(request: CreateReceiptRequest): Promise<ReceiptResult> {
    // Idempotency נבדק לפני הדמיית הכשל: ניסיון חוזר עם אותו מפתח לעולם
    // לא ייצור קבלה שנייה, גם אם הקריאה הקודמת הצליחה והתשובה אבדה בדרך.
    const existingId = this.byIdempotencyKey.get(request.idempotencyKey);
    if (existingId) {
      const existing = this.byId.get(existingId)!;
      return toResult(existing);
    }

    this.guardAvailability();

    if (request.amountAgorot <= 0) {
      throw new ProviderError('לא ניתן להפיק קבלה על סכום שאינו חיובי', {
        provider: this.key,
        code: 'invalid_amount',
        retryable: false,
      });
    }

    const providerReceiptId = `mrc_${crypto.randomBytes(8).toString('hex')}`;
    const receiptNumber = `${this.numberPrefix}${this.nextNumber++}`;
    const stored: StoredReceipt = {
      providerReceiptId,
      idempotencyKey: request.idempotencyKey,
      receiptNumber,
      status: 'issued',
      issuedAt: new Date().toISOString(),
      amountAgorot: request.amountAgorot,
      documentType: request.documentType,
      url: `${this.baseUrl}/receipts/${providerReceiptId}.pdf`,
      request,
    };
    this.byId.set(providerReceiptId, stored);
    this.byIdempotencyKey.set(request.idempotencyKey, providerReceiptId);
    return toResult(stored);
  }

  async getReceipt(providerReceiptId: string): Promise<ReceiptResult> {
    this.guardAvailability();
    return toResult(this.require(providerReceiptId));
  }

  async cancelReceipt(providerReceiptId: string, reason?: string): Promise<ReceiptResult> {
    if (!this.supportsCancel) {
      const { ProviderNotSupportedError } = await import('../types.js');
      throw new ProviderNotSupportedError(this.key, 'cancelReceipt');
    }
    this.guardAvailability();
    const stored = this.require(providerReceiptId);
    stored.status = 'cancelled';
    stored.cancelReason = reason;
    return toResult(stored);
  }

  async downloadReceipt(providerReceiptId: string): Promise<ReceiptDownload> {
    this.guardAvailability();
    const stored = this.require(providerReceiptId);
    return {
      filename: `receipt-${stored.receiptNumber}.pdf`,
      contentType: 'application/pdf',
      data: buildPlaceholderPdf(stored),
    };
  }

  async checkReceiptStatus(providerReceiptId: string): Promise<ProviderReceiptStatus> {
    this.guardAvailability();
    return this.require(providerReceiptId).status;
  }

  private require(providerReceiptId: string): StoredReceipt {
    const stored = this.byId.get(providerReceiptId);
    if (!stored) {
      throw new ProviderError(`קבלה ${providerReceiptId} לא נמצאה אצל הספק`, {
        provider: this.key,
        code: 'not_found',
        retryable: false,
      });
    }
    return stored;
  }
}

function toResult(stored: StoredReceipt): ReceiptResult {
  return {
    providerReceiptId: stored.providerReceiptId,
    receiptNumber: stored.receiptNumber,
    status: stored.status,
    issuedAt: stored.issuedAt,
    amountAgorot: stored.amountAgorot,
    documentType: stored.documentType,
    url: stored.url,
    raw: { mock: true, idempotencyKey: stored.idempotencyKey },
  };
}

/** מייצר קובץ PDF תקין ומינימלי, כדי שההורדה תהיה בת-בדיקה מקצה לקצה. */
function buildPlaceholderPdf(stored: StoredReceipt): Buffer {
  const lines = [
    `Receipt ${stored.receiptNumber}`,
    `Amount: ${formatAgorot(stored.amountAgorot)}`,
    `Customer: ${stored.request.customer.name}`,
    `Date: ${stored.request.issueDate}`,
  ];
  const content = lines
    .map((line, index) => `BT /F1 14 Tf 40 ${760 - index * 22} Td (${escapePdf(line)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function escapePdf(value: string): string {
  return value.replace(/([()\\])/g, '\\$1');
}
