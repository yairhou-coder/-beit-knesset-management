/**
 * Mock PaymentProvider - מימוש מלא של ספק סליקה לצורכי בדיקות מקצה לקצה (סעיף 26).
 *
 * תומך ב: חיוב מוצלח, חיוב שנכשל, הוראות קבע (סטטוס/ביטול), פג תוקף כרטיס,
 * וקבלה ואימות של Webhooks.
 */

import crypto from 'node:crypto';
import type {
  ChargeRequest,
  CreateSubscriptionRequest,
  PaymentProvider,
  PaymentResult,
  ProviderSubscriptionStatus,
  ProviderWebhookEvent,
  SubscriptionResult,
  WebhookEventType,
} from '../types.js';
import { ProviderError, WEBHOOK_EVENT_TYPES } from '../types.js';

interface StoredPayment {
  id: string;
  idempotencyKey: string;
  status: PaymentResult['status'];
  amountAgorot: number;
  processedAt: string | null;
  failureCode?: string | null;
  failureReason?: string | null;
  refundedAgorot: number;
}

interface StoredSubscription {
  id: string;
  idempotencyKey: string;
  status: ProviderSubscriptionStatus;
  amountAgorot: number;
  dayOfMonth: number;
  cardLast4: string;
  cardExpiry: string;
  cancelledAt: string | null;
}

export interface MockPaymentProviderOptions {
  key?: string;
  displayName?: string;
  failureRate?: number;
  /** סוד לאימות חתימת Webhook. */
  webhookSecret?: string;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly key: string;
  readonly displayName: string;
  readonly supportsSubscriptions = true;

  private readonly payments = new Map<string, StoredPayment>();
  private readonly paymentsByKey = new Map<string, string>();
  private readonly subscriptions = new Map<string, StoredSubscription>();
  private readonly subscriptionsByKey = new Map<string, string>();
  private readonly failureRate: number;
  private readonly webhookSecret: string;
  private failNextError: ProviderError | null = null;
  private declineNext: { code: string; reason: string } | null = null;

  constructor(options: MockPaymentProviderOptions = {}) {
    this.key = options.key ?? 'mock';
    this.displayName = options.displayName ?? 'ספק סליקה לדוגמה (Mock)';
    this.failureRate = options.failureRate ?? 0;
    this.webhookSecret = options.webhookSecret ?? 'mock-webhook-secret';
  }

  // --- שליטה בהדמיה --------------------------------------------------------

  /** הקריאה הבאה תיפול בשגיאת תקשורת (הספק לא זמין). */
  failNextCall(error?: ProviderError): void {
    this.failNextError =
      error ??
      new ProviderError('אין תקשורת עם מערכת הסליקה', {
        provider: this.key,
        code: 'network_error',
        retryable: true,
      });
  }

  /** החיוב הבא יידחה על ידי חברת האשראי (עסקה נכשלה, לא תקלת תקשורת). */
  declineNextCharge(code = 'card_declined', reason = 'הכרטיס נדחה על ידי חברת האשראי'): void {
    this.declineNext = { code, reason };
  }

  private guardAvailability(): void {
    if (this.failNextError) {
      const error = this.failNextError;
      this.failNextError = null;
      throw error;
    }
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      throw new ProviderError('שגיאה זמנית במערכת הסליקה', {
        provider: this.key,
        code: 'temporary_failure',
        retryable: true,
      });
    }
  }

  // --- חיובים --------------------------------------------------------------

  async charge(request: ChargeRequest): Promise<PaymentResult> {
    const existingId = this.paymentsByKey.get(request.idempotencyKey);
    if (existingId) return toPaymentResult(this.payments.get(existingId)!);

    this.guardAvailability();

    const id = `mpay_${crypto.randomBytes(8).toString('hex')}`;
    const declined = this.declineNext;
    this.declineNext = null;

    const stored: StoredPayment = declined
      ? {
          id,
          idempotencyKey: request.idempotencyKey,
          status: 'failed',
          amountAgorot: request.amountAgorot,
          processedAt: new Date().toISOString(),
          failureCode: declined.code,
          failureReason: declined.reason,
          refundedAgorot: 0,
        }
      : {
          id,
          idempotencyKey: request.idempotencyKey,
          status: 'succeeded',
          amountAgorot: request.amountAgorot,
          processedAt: new Date().toISOString(),
          refundedAgorot: 0,
        };

    this.payments.set(id, stored);
    this.paymentsByKey.set(request.idempotencyKey, id);
    return toPaymentResult(stored);
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentResult> {
    this.guardAvailability();
    return toPaymentResult(this.requirePayment(providerPaymentId));
  }

  async refund(providerPaymentId: string, amountAgorot?: number): Promise<PaymentResult> {
    this.guardAvailability();
    const stored = this.requirePayment(providerPaymentId);
    if (stored.status !== 'succeeded' && stored.status !== 'refunded') {
      throw new ProviderError('לא ניתן לזכות עסקה שלא בוצעה בהצלחה', {
        provider: this.key,
        code: 'invalid_state',
        retryable: false,
      });
    }
    const amount = amountAgorot ?? stored.amountAgorot;
    if (amount > stored.amountAgorot - stored.refundedAgorot) {
      throw new ProviderError('סכום הזיכוי גבוה מיתרת העסקה', {
        provider: this.key,
        code: 'invalid_amount',
        retryable: false,
      });
    }
    stored.refundedAgorot += amount;
    stored.status = 'refunded';
    return toPaymentResult(stored);
  }

  // --- הוראות קבע ----------------------------------------------------------

  async createSubscription(request: CreateSubscriptionRequest): Promise<SubscriptionResult> {
    const existingId = this.subscriptionsByKey.get(request.idempotencyKey);
    if (existingId) return toSubscriptionResult(this.subscriptions.get(existingId)!);

    this.guardAvailability();
    const id = `msub_${crypto.randomBytes(8).toString('hex')}`;
    const stored: StoredSubscription = {
      id,
      idempotencyKey: request.idempotencyKey,
      status: 'active',
      amountAgorot: request.amountAgorot,
      dayOfMonth: request.dayOfMonth,
      cardLast4: String(1000 + Math.floor(Math.random() * 9000)).slice(-4),
      cardExpiry: '12/29',
      cancelledAt: null,
    };
    this.subscriptions.set(id, stored);
    this.subscriptionsByKey.set(request.idempotencyKey, id);
    return toSubscriptionResult(stored);
  }

  async getSubscriptionStatus(providerSubscriptionId: string): Promise<SubscriptionResult> {
    this.guardAvailability();
    return toSubscriptionResult(this.requireSubscription(providerSubscriptionId));
  }

  async cancelSubscription(
    providerSubscriptionId: string,
    _reason?: string,
  ): Promise<SubscriptionResult> {
    this.guardAvailability();
    const stored = this.requireSubscription(providerSubscriptionId);
    stored.status = 'cancelled';
    stored.cancelledAt = new Date().toISOString();
    return toSubscriptionResult(stored);
  }

  /** מדמה הודעת פג-תוקף כרטיס מהספק. */
  expireCard(providerSubscriptionId: string): SubscriptionResult {
    const stored = this.requireSubscription(providerSubscriptionId);
    stored.status = 'card_expired';
    return toSubscriptionResult(stored);
  }

  // --- Webhooks ------------------------------------------------------------

  /** חותם גוף הודעה כפי שספק אמיתי היה עושה - לשימוש בטסטים ובסביבת פיתוח. */
  signWebhook(rawBody: string): string {
    return crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }

  parseWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): ProviderWebhookEvent {
    const signature = headers['x-mock-signature'] ?? headers['X-Mock-Signature'];
    const expected = this.signWebhook(rawBody);
    const provided = signature ?? '';
    const valid =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!valid) {
      throw new ProviderError('חתימת ה-Webhook אינה תקינה', {
        provider: this.key,
        code: 'invalid_signature',
        retryable: false,
      });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch (cause) {
      throw new ProviderError('גוף ה-Webhook אינו JSON תקין', {
        provider: this.key,
        code: 'invalid_payload',
        retryable: false,
        cause,
      });
    }

    const type = payload['type'];
    if (typeof type !== 'string' || !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(type)) {
      throw new ProviderError(`סוג אירוע לא נתמך: ${String(type)}`, {
        provider: this.key,
        code: 'unsupported_event',
        retryable: false,
      });
    }

    const data = (payload['data'] ?? {}) as Record<string, unknown>;
    return {
      id: String(payload['id'] ?? crypto.randomUUID()),
      type: type as WebhookEventType,
      occurredAt: String(payload['occurred_at'] ?? new Date().toISOString()),
      providerPaymentId: asStringOrNull(data['payment_id']),
      providerSubscriptionId: asStringOrNull(data['subscription_id']),
      amountAgorot: typeof data['amount_agorot'] === 'number' ? data['amount_agorot'] : null,
      failureCode: asStringOrNull(data['failure_code']),
      failureReason: asStringOrNull(data['failure_reason']),
      cardLast4: asStringOrNull(data['card_last4']),
      cardExpiry: asStringOrNull(data['card_expiry']),
      reference: {
        organizationId: asNumberOrNull(data['organization_id']),
        memberId: asNumberOrNull(data['member_id']),
        commitmentId: asNumberOrNull(data['commitment_id']),
        standingOrderId: asNumberOrNull(data['standing_order_id']),
      },
      raw: payload,
    };
  }

  private requirePayment(id: string): StoredPayment {
    const stored = this.payments.get(id);
    if (!stored) {
      throw new ProviderError(`עסקה ${id} לא נמצאה אצל הספק`, {
        provider: this.key,
        code: 'not_found',
        retryable: false,
      });
    }
    return stored;
  }

  private requireSubscription(id: string): StoredSubscription {
    const stored = this.subscriptions.get(id);
    if (!stored) {
      throw new ProviderError(`הוראת קבע ${id} לא נמצאה אצל הספק`, {
        provider: this.key,
        code: 'not_found',
        retryable: false,
      });
    }
    return stored;
  }
}

function toPaymentResult(stored: StoredPayment): PaymentResult {
  return {
    providerPaymentId: stored.id,
    status: stored.status,
    amountAgorot: stored.amountAgorot,
    processedAt: stored.processedAt,
    failureCode: stored.failureCode ?? null,
    failureReason: stored.failureReason ?? null,
    raw: { mock: true, refundedAgorot: stored.refundedAgorot },
  };
}

function toSubscriptionResult(stored: StoredSubscription): SubscriptionResult {
  return {
    providerSubscriptionId: stored.id,
    status: stored.status,
    amountAgorot: stored.amountAgorot,
    dayOfMonth: stored.dayOfMonth,
    nextChargeDate: null,
    cardLast4: stored.cardLast4,
    cardExpiry: stored.cardExpiry,
    cancelledAt: stored.cancelledAt,
    raw: { mock: true },
  };
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
