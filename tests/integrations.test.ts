/** שכבת ה-Integration: ספקים, Webhooks והוראות קבע (סעיף 26). */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import { ProviderError, ProviderNotSupportedError } from '../src/integrations/types.js';
import { MockReceiptProvider } from '../src/integrations/receipts/mock.js';
import { MockNotificationProvider } from '../src/integrations/notifications/mock.js';
import { receiptProviders, paymentProviders } from '../src/integrations/registry.js';
import { handleWebhook } from '../src/services/webhooks.js';
import {
  cancelStandingOrder,
  chargeStandingOrder,
  createStandingOrder,
  getStandingOrder,
  registerWithProvider,
} from '../src/services/standingOrders.js';
import { listPayments } from '../src/services/payments.js';
import { listIncomes } from '../src/services/incomes.js';
import { listAlerts } from '../src/services/alerts.js';
import { createTestDb, makeMember, makeOrganization, paymentProviderFor } from './helpers.js';

describe('רישום ספקים', () => {
  it('ספק ברירת המחדל משמש כאשר המפתח אינו מוכר', () => {
    const provider = receiptProviders.resolve('no-such-provider', 1, {});
    expect(provider.key).toBe('mock');
  });

  it('ניתן לרשום ספק חדש ללא שינוי בלוגיקת המערכת', async () => {
    class CustomReceiptProvider extends MockReceiptProvider {
      override readonly key = 'custom-test';
    }
    receiptProviders.register('custom-test', () => new CustomReceiptProvider({ key: 'custom-test' }));

    const provider = receiptProviders.resolve('custom-test', 99, {});
    expect(provider.key).toBe('custom-test');
    expect(receiptProviders.keys()).toContain('custom-test');
  });

  it('כל עמותה מקבלת מופע ספק נפרד', () => {
    const first = paymentProviders.resolve('mock', 1, {});
    const second = paymentProviders.resolve('mock', 2, {});
    expect(first).not.toBe(second);
    expect(paymentProviders.resolve('mock', 1, {})).toBe(first);
  });
});

describe('ReceiptProvider', () => {
  it('תומך בכל הפעולות הנדרשות', async () => {
    const provider = new MockReceiptProvider({ numberPrefix: 'T-', startingNumber: 900 });
    const request = {
      idempotencyKey: 'k1',
      documentType: 'receipt' as const,
      amountAgorot: 10_000,
      currency: 'ILS' as const,
      issueDate: '2026-08-30',
      description: 'בדיקה',
      paymentMethod: 'cash',
      customer: { name: 'יעקב כהן' },
      reference: { paymentId: 1, incomeId: 1, organizationId: 1 },
    };

    const created = await provider.createReceipt(request);
    expect(created.receiptNumber).toBe('T-900');
    expect(created.status).toBe('issued');

    expect((await provider.getReceipt(created.providerReceiptId)).receiptNumber).toBe('T-900');
    expect(await provider.checkReceiptStatus(created.providerReceiptId)).toBe('issued');

    const download = await provider.downloadReceipt(created.providerReceiptId);
    expect(download.contentType).toBe('application/pdf');

    const cancelled = await provider.cancelReceipt(created.providerReceiptId, 'טעות');
    expect(cancelled.status).toBe('cancelled');
  });

  it('ספק שאינו תומך בביטול זורק שגיאה מתאימה', async () => {
    const provider = new MockReceiptProvider({ supportsCancel: false });
    const created = await provider.createReceipt({
      idempotencyKey: 'k2',
      documentType: 'receipt',
      amountAgorot: 1000,
      currency: 'ILS',
      issueDate: '2026-08-30',
      description: 'בדיקה',
      paymentMethod: 'cash',
      customer: { name: 'בדיקה' },
      reference: { paymentId: 1, incomeId: 1, organizationId: 1 },
    });

    await expect(provider.cancelReceipt(created.providerReceiptId)).rejects.toBeInstanceOf(
      ProviderNotSupportedError,
    );
  });
});

describe('PaymentProvider ו-Webhooks', () => {
  let db: Db;
  let orgId: number;
  let memberId: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    memberId = makeMember(db).id;
  });

  afterEach(() => db.close());

  it('חיוב מוצלח וחיוב שנכשל', async () => {
    const provider = paymentProviderFor(db, orgId);
    const request = {
      idempotencyKey: 'charge-1',
      amountAgorot: 25_000,
      currency: 'ILS' as const,
      description: 'בדיקה',
      customer: { name: 'יעקב כהן' },
      reference: { organizationId: orgId },
    };

    expect((await provider.charge(request)).status).toBe('succeeded');

    provider.declineNextCharge('insufficient_funds', 'אין כיסוי');
    const declined = await provider.charge({ ...request, idempotencyKey: 'charge-2' });
    expect(declined.status).toBe('failed');
    expect(declined.failureReason).toBe('אין כיסוי');
  });

  it('Webhook עם חתימה לא תקינה נדחה', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', data: {} });
    await expect(
      handleWebhook(db, orgId, { 'x-mock-signature': 'bad' }, body),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('Webhook של תשלום מוצלח רושם תשלום והכנסה', async () => {
    const provider = paymentProviderFor(db, orgId);
    const body = JSON.stringify({
      id: 'evt_success',
      type: 'payment.succeeded',
      occurred_at: '2026-08-30T10:00:00.000Z',
      data: { payment_id: 'mpay_1', amount_agorot: 50_000, member_id: memberId },
    });

    const result = await handleWebhook(
      db,
      orgId,
      { 'x-mock-signature': provider.signWebhook(body) },
      body,
    );

    expect(result.processed).toBe(true);
    expect(listPayments(db)).toHaveLength(1);
    expect(listIncomes(db)).toHaveLength(1);
    expect(listPayments(db)[0]!.amountAgorot).toBe(50_000);
  });

  it('אותו Webhook פעמיים אינו יוצר תשלום כפול', async () => {
    const provider = paymentProviderFor(db, orgId);
    const body = JSON.stringify({
      id: 'evt_dup',
      type: 'payment.succeeded',
      occurred_at: '2026-08-30T10:00:00.000Z',
      data: { payment_id: 'mpay_2', amount_agorot: 30_000, member_id: memberId },
    });
    const headers = { 'x-mock-signature': provider.signWebhook(body) };

    await handleWebhook(db, orgId, headers, body);
    const second = await handleWebhook(db, orgId, headers, body);

    expect(second.duplicate).toBe(true);
    expect(listPayments(db)).toHaveLength(1);
  });

  it('Webhook של תשלום ללא זיהוי חבר יוצר התראה', async () => {
    const provider = paymentProviderFor(db, orgId);
    const body = JSON.stringify({
      id: 'evt_unassigned',
      type: 'payment.succeeded',
      occurred_at: '2026-08-30T10:00:00.000Z',
      data: { payment_id: 'mpay_3', amount_agorot: 20_000 },
    });

    await handleWebhook(db, orgId, { 'x-mock-signature': provider.signWebhook(body) }, body);

    expect(listPayments(db, { unassignedOnly: true })).toHaveLength(1);
    expect(listAlerts(db, { resolved: false, kind: 'payment_unassigned' })).toHaveLength(1);
  });

  it('Webhook של פג תוקף כרטיס מעדכן את הוראת הקבע', async () => {
    const provider = paymentProviderFor(db, orgId);
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(250),
    });
    const registered = await registerWithProvider(db, order.id);

    const body = JSON.stringify({
      id: 'evt_card',
      type: 'subscription.card_expired',
      occurred_at: '2026-08-30T10:00:00.000Z',
      data: { subscription_id: registered.providerSubscriptionId, card_last4: '4242', card_expiry: '01/26' },
    });
    await handleWebhook(db, orgId, { 'x-mock-signature': provider.signWebhook(body) }, body);

    expect(getStandingOrder(db, order.id).status).toBe('card_expired');
    expect(listAlerts(db, { resolved: false, kind: 'card_expiry' })).toHaveLength(1);
  });

  it('Webhook של ביטול מנוי מסמן את הוראת הקבע כמבוטלת', async () => {
    const provider = paymentProviderFor(db, orgId);
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(250),
    });
    const registered = await registerWithProvider(db, order.id);

    const body = JSON.stringify({
      id: 'evt_cancel',
      type: 'subscription.cancelled',
      occurred_at: '2026-08-30T10:00:00.000Z',
      data: { subscription_id: registered.providerSubscriptionId },
    });
    await handleWebhook(db, orgId, { 'x-mock-signature': provider.signWebhook(body) }, body);

    expect(getStandingOrder(db, order.id).status).toBe('cancelled');
  });
});

describe('הוראות קבע', () => {
  let db: Db;
  let orgId: number;
  let memberId: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    memberId = makeMember(db).id;
  });

  afterEach(() => db.close());

  it('חיוב חודשי מייצר תשלום, הכנסה וקבלה', async () => {
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(250),
      method: 'standing_order',
    });

    const result = await chargeStandingOrder(db, order.id, '2026-08');

    expect(result.payment.status).toBe('completed');
    expect(result.payment.amountAgorot).toBe(25_000);
    expect(result.payment.receipt?.number).toBeTruthy();
    expect(listIncomes(db)).toHaveLength(1);
  });

  it('חיוב פעמיים באותו חודש אינו יוצר תשלום כפול', async () => {
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(250),
    });

    await chargeStandingOrder(db, order.id, '2026-08');
    await chargeStandingOrder(db, order.id, '2026-08');

    expect(listPayments(db)).toHaveLength(1);
    expect(listIncomes(db)).toHaveLength(1);
  });

  it('חיוב שנכשל נרשם כתשלום כושל, ללא הכנסה, ומעלה התראה', async () => {
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(250),
    });
    paymentProviderFor(db, orgId).declineNextCharge();

    const result = await chargeStandingOrder(db, order.id, '2026-09');

    expect(result.payment.status).toBe('failed');
    expect(listIncomes(db)).toHaveLength(0);
    expect(getStandingOrder(db, order.id).status).toBe('failed');
    expect(listAlerts(db, { resolved: false, kind: 'standing_order_failed' })).toHaveLength(1);
  });

  it('ביטול הוראת קבע מעדכן גם את הספק', async () => {
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(250),
    });
    await registerWithProvider(db, order.id);
    const cancelled = await cancelStandingOrder(db, order.id, 'בקשת החבר');
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('NotificationProvider', () => {
  it('ערוץ שאינו נתמך מדולג', async () => {
    const provider = new MockNotificationProvider({ supportedChannels: ['email'] });
    const result = await provider.send({
      idempotencyKey: 'n1',
      channel: 'whatsapp',
      recipient: '050-0000000',
      body: 'שלום',
    });
    expect(result.status).toBe('skipped');
  });

  it('ללא Integration פעיל ההודעה נשארת בתור', async () => {
    const provider = new MockNotificationProvider({ queueOnly: true });
    const result = await provider.send({
      idempotencyKey: 'n2',
      channel: 'email',
      recipient: 'a@b.com',
      body: 'שלום',
    });
    expect(result.status).toBe('queued');
    expect(provider.outbox).toHaveLength(1);
  });
});
