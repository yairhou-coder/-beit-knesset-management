/**
 * רישום ספקים ופתרון הספק הנכון לכל עמותה (סעיף 25 + 26).
 *
 * המערכת אינה מכירה אף ספק ספציפי. כל ספק נרשם כאן תחת מפתח,
 * וכל עמותה מציינת בהגדרותיה באיזה מפתח להשתמש ואיזו קונפיגורציה להעביר לו.
 * הוספת ספק חדש אינה מצריכה שינוי בשירותים.
 */

import { config } from '../config.js';
import type { NotificationProvider, PaymentProvider, ReceiptProvider } from './types.js';
import { MockReceiptProvider } from './receipts/mock.js';
import { MockPaymentProvider } from './payments/mock.js';
import { MockNotificationProvider } from './notifications/mock.js';

export interface OrganizationProviderSettings {
  id: number;
  receipt_provider: string;
  receipt_config: string;
  payment_provider: string;
  payment_config: string;
  notification_provider: string;
  notification_config: string;
}

type Factory<T> = (organizationId: number, providerConfig: Record<string, unknown>) => T;

class ProviderRegistry<T> {
  private readonly factories = new Map<string, Factory<T>>();
  /** מופע לכל (מפתח ספק, עמותה) - כדי שספק שומר-מצב לא ישותף בין עמותות. */
  private readonly instances = new Map<string, T>();

  constructor(
    private readonly kind: string,
    private readonly fallbackKey: string,
  ) {}

  register(key: string, factory: Factory<T>): void {
    this.factories.set(key, factory);
  }

  has(key: string): boolean {
    return this.factories.has(key);
  }

  keys(): string[] {
    return [...this.factories.keys()];
  }

  resolve(key: string, organizationId: number, providerConfig: Record<string, unknown>): T {
    const effectiveKey = this.factories.has(key) ? key : this.fallbackKey;
    if (!this.factories.has(effectiveKey)) {
      throw new Error(`לא נמצא ${this.kind} עבור המפתח "${key}" ואין ספק ברירת מחדל`);
    }
    const cacheKey = `${effectiveKey}:${organizationId}`;
    let instance = this.instances.get(cacheKey);
    if (!instance) {
      instance = this.factories.get(effectiveKey)!(organizationId, providerConfig);
      this.instances.set(cacheKey, instance);
    }
    return instance;
  }

  /** מנקה מופעים שנשמרו במטמון (משמש בטסטים ולאחר שינוי הגדרות עמותה). */
  reset(organizationId?: number): void {
    if (organizationId === undefined) {
      this.instances.clear();
      return;
    }
    for (const key of [...this.instances.keys()]) {
      if (key.endsWith(`:${organizationId}`)) this.instances.delete(key);
    }
  }
}

export const receiptProviders = new ProviderRegistry<ReceiptProvider>(
  'ReceiptProvider',
  config.defaultReceiptProvider,
);
export const paymentProviders = new ProviderRegistry<PaymentProvider>(
  'PaymentProvider',
  config.defaultPaymentProvider,
);
export const notificationProviders = new ProviderRegistry<NotificationProvider>(
  'NotificationProvider',
  config.defaultNotificationProvider,
);

// --- ספקי ברירת המחדל (Mock) ------------------------------------------------
// חיבור ספק אמיתי בעתיד: receiptProviders.register('greeninvoice', (orgId, cfg) => new GreenInvoiceProvider(cfg))

receiptProviders.register(
  'mock',
  (organizationId, providerConfig) =>
    new MockReceiptProvider({
      key: 'mock',
      failureRate: numberOr(providerConfig['failureRate'], config.mock.receiptFailureRate),
      startingNumber: numberOr(providerConfig['startingNumber'], 12500 + organizationId * 1000),
      numberPrefix: stringOr(providerConfig['numberPrefix'], ''),
      supportsCancel: providerConfig['supportsCancel'] !== false,
    }),
);

paymentProviders.register(
  'mock',
  (_organizationId, providerConfig) =>
    new MockPaymentProvider({
      key: 'mock',
      failureRate: numberOr(providerConfig['failureRate'], config.mock.paymentFailureRate),
      webhookSecret: stringOr(providerConfig['webhookSecret'], 'mock-webhook-secret'),
    }),
);

notificationProviders.register(
  'mock',
  (_organizationId, providerConfig) =>
    new MockNotificationProvider({
      key: 'mock',
      // ללא Integration אמיתי ההודעות נשמרות בתור ואינן נשלחות בפועל.
      queueOnly: providerConfig['queueOnly'] !== false,
    }),
);

// --- פתרון ספק עבור עמותה ---------------------------------------------------

function parseConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function resolveReceiptProvider(org: OrganizationProviderSettings): ReceiptProvider {
  return receiptProviders.resolve(org.receipt_provider, org.id, parseConfig(org.receipt_config));
}

export function resolvePaymentProvider(org: OrganizationProviderSettings): PaymentProvider {
  return paymentProviders.resolve(org.payment_provider, org.id, parseConfig(org.payment_config));
}

export function resolveNotificationProvider(org: OrganizationProviderSettings): NotificationProvider {
  return notificationProviders.resolve(
    org.notification_provider,
    org.id,
    parseConfig(org.notification_config),
  );
}

/** מנקה את כל מטמוני הספקים. יש לקרוא לאחר עדכון הגדרות Integration של עמותה. */
export function resetProviderCaches(organizationId?: number): void {
  receiptProviders.reset(organizationId);
  paymentProviders.reset(organizationId);
  notificationProviders.reset(organizationId);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
