/**
 * Integration Layer (סעיף 26)
 *
 * הלוגיקה המרכזית של המערכת מדברת אך ורק מול הממשקים שבקובץ זה,
 * ולעולם לא מול ספק ספציפי. חיבור ספק חדש = מימוש הממשק + רישום ב-registry.ts,
 * ללא שינוי בשירותים (services/).
 */

import type { Agorot } from '../domain/money.js';
import type { DocumentType, NotificationChannel } from '../domain/types.js';

// ---------------------------------------------------------------------------
// שגיאות משותפות
// ---------------------------------------------------------------------------

/** שגיאה שמקורה בספק חיצוני. `retryable` קובע אם כדאי לנסות שוב. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly options: {
      provider: string;
      code?: string;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get provider(): string {
    return this.options.provider;
  }
  get code(): string | undefined {
    return this.options.code;
  }
  /** ברירת המחדל היא כן - תקלת רשת/זמינות ניתנת לניסיון חוזר. */
  get retryable(): boolean {
    return this.options.retryable ?? true;
  }
}

/** הספק אינו תומך בפעולה (למשל ביטול קבלה). */
export class ProviderNotSupportedError extends ProviderError {
  constructor(provider: string, operation: string) {
    super(`הספק ${provider} אינו תומך בפעולה: ${operation}`, {
      provider,
      code: 'not_supported',
      retryable: false,
    });
    this.name = 'ProviderNotSupportedError';
  }
}

// ---------------------------------------------------------------------------
// ReceiptProvider - מערכת הפקת קבלות
// ---------------------------------------------------------------------------

export interface ReceiptCustomer {
  /** מזהה החבר במערכת שלנו, לצורך שיוך אצל הספק. */
  memberId?: number | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  taxId?: string | null;
}

export interface ReceiptLineItem {
  description: string;
  amountAgorot: Agorot;
  quantity?: number;
}

export interface CreateReceiptRequest {
  /**
   * מפתח ייחודי לעסקה. הספק מחויב להחזיר את אותה קבלה עבור אותו מפתח
   * ולא ליצור קבלה שנייה (סעיף 28).
   */
  idempotencyKey: string;
  documentType: DocumentType;
  amountAgorot: Agorot;
  currency: 'ILS';
  issueDate: string; // YYYY-MM-DD
  description: string;
  paymentMethod: string;
  customer: ReceiptCustomer;
  lineItems?: ReceiptLineItem[];
  /** מזהי מקור אצלנו, נשלחים לספק כמטא-דאטה לצורכי התאמה. */
  reference: {
    paymentId: number;
    incomeId: number;
    commitmentId?: number | null;
    organizationId: number;
  };
}

export type ProviderReceiptStatus = 'issued' | 'pending' | 'failed' | 'cancelled';

export interface ReceiptResult {
  providerReceiptId: string;
  receiptNumber: string | null;
  status: ProviderReceiptStatus;
  issuedAt: string | null;
  amountAgorot: Agorot;
  documentType: DocumentType;
  url: string | null;
  /** תשובה גולמית מהספק, נשמרת לצורכי ביקורת. */
  raw?: unknown;
}

export interface ReceiptDownload {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface ReceiptProvider {
  readonly key: string;
  readonly displayName: string;
  /** האם הספק מאפשר ביטול קבלה. */
  readonly supportsCancel: boolean;
  /** האם הספק מאפשר הורדת PDF. */
  readonly supportsDownload: boolean;

  createReceipt(request: CreateReceiptRequest): Promise<ReceiptResult>;
  getReceipt(providerReceiptId: string): Promise<ReceiptResult>;
  /** זורק ProviderNotSupportedError אם supportsCancel הוא false. */
  cancelReceipt(providerReceiptId: string, reason?: string): Promise<ReceiptResult>;
  downloadReceipt(providerReceiptId: string): Promise<ReceiptDownload>;
  checkReceiptStatus(providerReceiptId: string): Promise<ProviderReceiptStatus>;
}

// ---------------------------------------------------------------------------
// PaymentProvider - מערכת סליקה
// ---------------------------------------------------------------------------

export interface ChargeRequest {
  idempotencyKey: string;
  amountAgorot: Agorot;
  currency: 'ILS';
  description: string;
  customer: ReceiptCustomer;
  /** אמצעי תשלום/טוקן אצל הספק. */
  paymentToken?: string;
  reference: {
    organizationId: number;
    memberId?: number | null;
    commitmentId?: number | null;
  };
}

export type ProviderPaymentStatus = 'succeeded' | 'failed' | 'pending' | 'refunded';

export interface PaymentResult {
  providerPaymentId: string;
  status: ProviderPaymentStatus;
  amountAgorot: Agorot;
  processedAt: string | null;
  /** מלא כאשר status הוא failed. */
  failureCode?: string | null;
  failureReason?: string | null;
  cardLast4?: string | null;
  cardExpiry?: string | null;
  raw?: unknown;
}

export interface CreateSubscriptionRequest {
  idempotencyKey: string;
  amountAgorot: Agorot;
  currency: 'ILS';
  dayOfMonth: number;
  description: string;
  customer: ReceiptCustomer;
  paymentToken?: string;
  reference: { organizationId: number; memberId: number };
}

export type ProviderSubscriptionStatus =
  | 'active'
  | 'paused'
  | 'cancelled'
  | 'card_expired'
  | 'failed';

export interface SubscriptionResult {
  providerSubscriptionId: string;
  status: ProviderSubscriptionStatus;
  amountAgorot: Agorot;
  dayOfMonth: number;
  nextChargeDate: string | null;
  cardLast4?: string | null;
  cardExpiry?: string | null;
  cancelledAt?: string | null;
  raw?: unknown;
}

/** סוגי אירועי Webhook שהמערכת יודעת לטפל בהם (סעיף 26). */
export const WEBHOOK_EVENT_TYPES = [
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  'subscription.payment_succeeded',
  'subscription.payment_failed',
  'subscription.cancelled',
  'subscription.card_expiring',
  'subscription.card_expired',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface ProviderWebhookEvent {
  /** מזהה האירוע אצל הספק. משמש למניעת עיבוד כפול. */
  id: string;
  type: WebhookEventType;
  occurredAt: string;
  providerPaymentId?: string | null;
  providerSubscriptionId?: string | null;
  amountAgorot?: Agorot | null;
  failureCode?: string | null;
  failureReason?: string | null;
  cardLast4?: string | null;
  cardExpiry?: string | null;
  /** מזהי המערכת שלנו, אם הספק מחזיר אותם כמטא-דאטה. */
  reference?: {
    organizationId?: number | null;
    memberId?: number | null;
    commitmentId?: number | null;
    standingOrderId?: number | null;
  };
  raw: unknown;
}

export interface PaymentProvider {
  readonly key: string;
  readonly displayName: string;
  readonly supportsSubscriptions: boolean;

  charge(request: ChargeRequest): Promise<PaymentResult>;
  getPaymentStatus(providerPaymentId: string): Promise<PaymentResult>;
  refund(providerPaymentId: string, amountAgorot?: Agorot): Promise<PaymentResult>;

  createSubscription(request: CreateSubscriptionRequest): Promise<SubscriptionResult>;
  getSubscriptionStatus(providerSubscriptionId: string): Promise<SubscriptionResult>;
  cancelSubscription(providerSubscriptionId: string, reason?: string): Promise<SubscriptionResult>;

  /**
   * מאמת חתימה ומפרש גוף בקשת Webhook לאירוע אחיד.
   * זורק ProviderError אם החתימה אינה תקינה.
   */
  parseWebhook(headers: Record<string, string | undefined>, rawBody: string): ProviderWebhookEvent;
}

// ---------------------------------------------------------------------------
// NotificationProvider - שליחת תזכורות
// ---------------------------------------------------------------------------

export interface NotificationMessage {
  idempotencyKey: string;
  channel: NotificationChannel;
  /** מספר טלפון (E.164) עבור SMS/WhatsApp, או כתובת אימייל. */
  recipient: string;
  subject?: string | null;
  body: string;
  reference?: { memberId?: number | null; relatedType?: string | null; relatedId?: number | null };
}

export interface NotificationResult {
  providerMessageId: string | null;
  status: 'sent' | 'queued' | 'failed' | 'skipped';
  sentAt: string | null;
  errorMessage?: string | null;
  raw?: unknown;
}

export interface NotificationProvider {
  readonly key: string;
  readonly displayName: string;
  readonly supportedChannels: readonly NotificationChannel[];

  send(message: NotificationMessage): Promise<NotificationResult>;
}
