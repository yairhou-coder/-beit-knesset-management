/**
 * Mock NotificationProvider - תשתית לשליחת תזכורות (סעיף 23).
 *
 * בשלב זה אין Integration אמיתי ל-WhatsApp / SMS / Email, ולכן הספק הזה
 * "שולח" את ההודעה ורושם אותה בלבד. כאשר יתווסף ספק אמיתי מספיק לממש את
 * NotificationProvider ולרשום אותו ב-registry - הלוגיקה של המערכת לא משתנה.
 */

import crypto from 'node:crypto';
import type {
  NotificationMessage,
  NotificationProvider,
  NotificationResult,
} from '../types.js';
import { NOTIFICATION_CHANNELS, type NotificationChannel } from '../../domain/types.js';

export interface MockNotificationProviderOptions {
  key?: string;
  displayName?: string;
  supportedChannels?: readonly NotificationChannel[];
  /** כאשר true, ההודעות מסומנות כ-queued במקום sent (התנהגות "ללא Integration"). */
  queueOnly?: boolean;
  /** רישום ההודעות ליומן. כבוי בטסטים. */
  log?: boolean;
}

export class MockNotificationProvider implements NotificationProvider {
  readonly key: string;
  readonly displayName: string;
  readonly supportedChannels: readonly NotificationChannel[];

  /** כל ההודעות ש"נשלחו", לצורכי בדיקה ובחינה ידנית. */
  readonly outbox: Array<NotificationMessage & { providerMessageId: string; sentAt: string }> = [];

  private readonly byIdempotencyKey = new Map<string, NotificationResult>();
  private readonly queueOnly: boolean;
  private readonly shouldLog: boolean;
  private failNextError: Error | null = null;

  constructor(options: MockNotificationProviderOptions = {}) {
    this.key = options.key ?? 'mock';
    this.displayName = options.displayName ?? 'ספק הודעות לדוגמה (Mock)';
    this.supportedChannels = options.supportedChannels ?? NOTIFICATION_CHANNELS;
    this.queueOnly = options.queueOnly ?? false;
    this.shouldLog = options.log ?? false;
  }

  failNextCall(error?: Error): void {
    this.failNextError = error ?? new Error('שירות ההודעות אינו זמין');
  }

  async send(message: NotificationMessage): Promise<NotificationResult> {
    const cached = this.byIdempotencyKey.get(message.idempotencyKey);
    if (cached) return cached;

    if (!this.supportedChannels.includes(message.channel)) {
      return {
        providerMessageId: null,
        status: 'skipped',
        sentAt: null,
        errorMessage: `הערוץ ${message.channel} אינו נתמך על ידי ${this.displayName}`,
      };
    }

    if (this.failNextError) {
      const error = this.failNextError;
      this.failNextError = null;
      const failure: NotificationResult = {
        providerMessageId: null,
        status: 'failed',
        sentAt: null,
        errorMessage: error.message,
      };
      this.byIdempotencyKey.set(message.idempotencyKey, failure);
      return failure;
    }

    const providerMessageId = `mmsg_${crypto.randomBytes(6).toString('hex')}`;
    const sentAt = new Date().toISOString();
    this.outbox.push({ ...message, providerMessageId, sentAt });
    if (this.shouldLog) {
      // eslint-disable-next-line no-console
      console.log(`[notification:${message.channel}] -> ${message.recipient}: ${message.body}`);
    }

    const result: NotificationResult = this.queueOnly
      ? { providerMessageId, status: 'queued', sentAt: null }
      : { providerMessageId, status: 'sent', sentAt };
    this.byIdempotencyKey.set(message.idempotencyKey, result);
    return result;
  }
}
