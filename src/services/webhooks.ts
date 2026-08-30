/**
 * טיפול ב-Webhooks מספקי סליקה (סעיף 26).
 *
 * כל אירוע נשמר תחילה בטבלה. אירוע שכבר עובד לא מעובד שוב,
 * כך שספק ששולח את אותה הודעה פעמיים לא יגרום לרישום תשלום כפול.
 */

import type { Db } from '../db/index.js';
import { resolvePaymentProvider } from '../integrations/registry.js';
import type { ProviderWebhookEvent } from '../integrations/types.js';
import { raiseAlert } from './alerts.js';
import { NotFoundError } from './errors.js';
import { getOrganizationRow } from './organizations.js';
import { recordPayment } from './payments.js';
import { setStandingOrderStatus } from './standingOrders.js';
import { today } from './util.js';

export interface WebhookHandlingResult {
  eventId: string;
  type: string;
  processed: boolean;
  duplicate: boolean;
  message: string;
}

/**
 * מקבל בקשת Webhook גולמית, מאמת את חתימתה מול הספק של העמותה,
 * ומעבד אותה. הגוף הגולמי נדרש לצורך אימות החתימה.
 */
export async function handleWebhook(
  db: Db,
  organizationId: number,
  headers: Record<string, string | undefined>,
  rawBody: string,
): Promise<WebhookHandlingResult> {
  const org = getOrganizationRow(db, organizationId);
  const provider = resolvePaymentProvider(org);

  // אימות החתימה נעשה בתוך parseWebhook של הספק, וזורק שגיאה אם אינה תקינה.
  const event = provider.parseWebhook(headers, rawBody);

  const existing = db
    .prepare('SELECT id, processed FROM provider_webhook_events WHERE provider = ? AND provider_event_id = ?')
    .get(provider.key, event.id) as { id: number; processed: number } | undefined;

  if (existing?.processed === 1) {
    return {
      eventId: event.id,
      type: event.type,
      processed: true,
      duplicate: true,
      message: 'האירוע כבר עובד בעבר',
    };
  }

  const rowId =
    existing?.id ??
    Number(
      db
        .prepare(
          `INSERT INTO provider_webhook_events (provider, provider_event_id, event_type, payload)
           VALUES (?, ?, ?, ?)`,
        )
        .run(provider.key, event.id, event.type, rawBody).lastInsertRowid,
    );

  try {
    const message = await processEvent(db, organizationId, event);
    db.prepare(
      `UPDATE provider_webhook_events SET processed = 1, processed_at = datetime('now'),
         processing_error = NULL WHERE id = ?`,
    ).run(rowId);
    return { eventId: event.id, type: event.type, processed: true, duplicate: false, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare('UPDATE provider_webhook_events SET processing_error = ? WHERE id = ?').run(
      message,
      rowId,
    );
    raiseAlert(db, {
      severity: 'error',
      kind: 'webhook_failed',
      title: `עיבוד Webhook נכשל (${event.type})`,
      message,
      organizationId,
      relatedType: 'webhook_event',
      relatedId: rowId,
    });
    throw error;
  }
}

async function processEvent(
  db: Db,
  organizationId: number,
  event: ProviderWebhookEvent,
): Promise<string> {
  const standingOrderId = resolveStandingOrderId(db, event);

  switch (event.type) {
    case 'payment.succeeded':
    case 'subscription.payment_succeeded': {
      const amount = event.amountAgorot;
      if (!amount || amount <= 0) return 'האירוע אינו כולל סכום - לא נרשם תשלום';
      const memberId = event.reference?.memberId ?? resolveMemberId(db, standingOrderId);
      await recordPayment(db, {
        organizationId,
        memberId: memberId ?? null,
        commitmentId: event.reference?.commitmentId ?? null,
        standingOrderId,
        amountAgorot: amount,
        paymentDate: event.occurredAt.slice(0, 10) || today(),
        method: standingOrderId ? 'standing_order' : 'credit_card',
        status: 'completed',
        // מזהה האירוע כמפתח idempotency - שליחה חוזרת לא תיצור תשלום שני.
        idempotencyKey: `webhook-${event.id}`,
        providerReference: event.providerPaymentId ?? null,
        providerPayload: event.raw,
        description: 'תשלום שהתקבל דרך ספק הסליקה',
      });
      if (standingOrderId) {
        setStandingOrderStatus(db, standingOrderId, 'active');
      }
      // תשלום ללא שיוך לחבר מחייב טיפול ידני (סעיף 30).
      if (!memberId) {
        raiseAlert(db, {
          severity: 'warning',
          kind: 'payment_unassigned',
          title: 'התקבל תשלום שאינו משויך לחבר',
          message: `סכום ${amount / 100} ₪ התקבל דרך ספק הסליקה ללא זיהוי חבר. יש לשייך אותו ידנית.`,
          organizationId,
          relatedType: 'webhook_event',
          relatedId: null,
        });
      }
      return 'נרשם תשלום';
    }

    case 'payment.failed':
    case 'subscription.payment_failed': {
      if (standingOrderId) {
        setStandingOrderStatus(db, standingOrderId, 'failed', event.failureReason ?? 'החיוב נכשל');
      }
      raiseAlert(db, {
        severity: 'warning',
        kind: 'payment_failed',
        title: 'חיוב נכשל אצל ספק הסליקה',
        message: event.failureReason ?? event.failureCode ?? 'סיבה לא ידועה',
        organizationId,
        relatedType: standingOrderId ? 'standing_order' : null,
        relatedId: standingOrderId,
      });
      return 'נרשמה התראה על כשל חיוב';
    }

    case 'payment.refunded': {
      if (!event.providerPaymentId) return 'האירוע אינו כולל מזהה עסקה';
      const payment = db
        .prepare('SELECT id FROM payments WHERE provider_reference = ?')
        .get(event.providerPaymentId) as { id: number } | undefined;
      if (!payment) return 'לא נמצא תשלום תואם';
      const { refundPayment } = await import('./payments.js');
      refundPayment(db, payment.id, 'זיכוי שהתקבל מספק הסליקה');
      return 'התשלום זוכה';
    }

    case 'subscription.cancelled': {
      if (!standingOrderId) return 'לא נמצאה הוראת קבע תואמת';
      setStandingOrderStatus(db, standingOrderId, 'cancelled', 'בוטלה אצל ספק הסליקה');
      return 'הוראת הקבע סומנה כמבוטלת';
    }

    case 'subscription.card_expiring':
    case 'subscription.card_expired': {
      if (!standingOrderId) return 'לא נמצאה הוראת קבע תואמת';
      const expired = event.type === 'subscription.card_expired';
      if (expired) {
        setStandingOrderStatus(db, standingOrderId, 'card_expired', 'תוקף הכרטיס פג');
      }
      if (event.cardExpiry) {
        db.prepare(`UPDATE standing_orders SET card_expiry = ? WHERE id = ?`).run(
          event.cardExpiry,
          standingOrderId,
        );
      }
      raiseAlert(db, {
        severity: expired ? 'error' : 'warning',
        kind: 'card_expiry',
        title: expired ? 'תוקף כרטיס האשראי פג' : 'תוקף כרטיס האשראי עומד לפוג',
        message: `הוראת קבע ${standingOrderId}${event.cardLast4 ? `, כרטיס ****${event.cardLast4}` : ''}`,
        organizationId,
        relatedType: 'standing_order',
        relatedId: standingOrderId,
      });
      return 'נרשמה התראה על תוקף כרטיס';
    }

    default: {
      const exhaustive: never = event.type;
      throw new NotFoundError(`מטפל באירוע מסוג ${String(exhaustive)}`);
    }
  }
}

function resolveStandingOrderId(db: Db, event: ProviderWebhookEvent): number | null {
  if (event.reference?.standingOrderId) return event.reference.standingOrderId;
  if (!event.providerSubscriptionId) return null;
  const row = db
    .prepare('SELECT id FROM standing_orders WHERE provider_subscription_id = ?')
    .get(event.providerSubscriptionId) as { id: number } | undefined;
  return row?.id ?? null;
}

function resolveMemberId(db: Db, standingOrderId: number | null): number | null {
  if (!standingOrderId) return null;
  const row = db
    .prepare('SELECT member_id FROM standing_orders WHERE id = ?')
    .get(standingOrderId) as { member_id: number } | undefined;
  return row?.member_id ?? null;
}
