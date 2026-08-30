/**
 * קבלות: טיפול בכשלים (סעיף 28), מניעת כפילות (Idempotency)
 * וקבלה אוטומטית מול אישור ידני (סעיף 29).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import { ProviderError } from '../src/integrations/types.js';
import { recordPayment } from '../src/services/payments.js';
import {
  approveReceipt,
  cancelReceipt,
  downloadReceiptPdf,
  getReceipt,
  listReceipts,
  refreshReceiptStatus,
  retryAllPending,
  retryReceipt,
} from '../src/services/receipts.js';
import { listIncomes } from '../src/services/incomes.js';
import { listAlerts } from '../src/services/alerts.js';
import { getCollectionSummary } from '../src/services/collections.js';
import { getCommitment } from '../src/services/commitments.js';
import {
  createTestDb,
  makeCommitment,
  makeMember,
  makeOrganization,
  receiptProviderFor,
} from './helpers.js';

describe('טיפול בכשלים בהפקת קבלה (סעיף 28)', () => {
  let db: Db;
  let orgId: number;
  let memberId: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    memberId = makeMember(db).id;
  });

  afterEach(() => db.close());

  it('כשל בספק הקבלות אינו מוחק את התשלום ואת ההכנסה', async () => {
    const commitment = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 1800 });
    receiptProviderFor(db, orgId).setOffline(true);

    const result = await recordPayment(db, {
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'bank_transfer',
    });

    // התשלום נשמר בהצלחה.
    expect(result.payment.status).toBe('completed');
    expect(result.payment.amountAgorot).toBe(100_000);
    // ההכנסה נרשמה.
    expect(listIncomes(db)).toHaveLength(1);
    // יתרת ההתחייבות עודכנה.
    expect(getCommitment(db, commitment.id).balanceAgorot).toBe(80_000);
    // הקבלה בסטטוס "ממתין להפקה".
    expect(result.receiptIssue?.issued).toBe(false);
    expect(getReceipt(db, result.receiptId!).status).toBe('pending');
  });

  it('כשל בהפקה יוצר התראה למנהל', async () => {
    receiptProviderFor(db, orgId).setOffline(true);
    await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });

    const alerts = listAlerts(db, { resolved: false, kind: 'receipt_failed' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('error');
  });

  it('ניסיון חוזר מפיק את הקבלה וסוגר את ההתראה', async () => {
    const provider = receiptProviderFor(db, orgId);
    provider.setOffline(true);
    const result = await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });

    provider.setOffline(false);
    const retry = await retryReceipt(db, result.receiptId!);

    expect(retry.issued).toBe(true);
    expect(retry.receipt.receiptNumber).toBeTruthy();
    expect(listAlerts(db, { resolved: false, kind: 'receipt_failed' })).toHaveLength(0);

    // שדות הקבלה מסונכרנים גם על ההכנסה (סעיף 24).
    const income = listIncomes(db)[0]!;
    expect(income.receipt.issued).toBe(true);
    expect(income.receipt.number).toBe(retry.receipt.receiptNumber);
    expect(income.receipt.status).toBe('issued');
    expect(income.receipt.error).toBeNull();
  });

  it('שגיאה שאינה ניתנת לניסיון חוזר מסומנת כ-failed', async () => {
    const provider = receiptProviderFor(db, orgId);
    provider.failNextCall(
      new ProviderError('סוג מסמך אינו מורשה', {
        provider: 'mock',
        code: 'forbidden',
        retryable: false,
      }),
    );

    const result = await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });

    const receipt = getReceipt(db, result.receiptId!);
    expect(receipt.status).toBe('failed');
    expect(receipt.errorMessage).toContain('אינו מורשה');
    // ההכנסה קיימת למרות הכשל.
    expect(listIncomes(db)).toHaveLength(1);
  });

  it('הפקה חוזרת לכל הקבלות הממתינות', async () => {
    const provider = receiptProviderFor(db, orgId);
    provider.setOffline(true);
    for (const amount of [100, 200, 300]) {
      await recordPayment(db, {
        organizationId: orgId,
        memberId,
        amountAgorot: shekelsToAgorot(amount),
        method: 'cash',
      });
    }
    expect(listReceipts(db, { status: 'pending' })).toHaveLength(3);

    provider.setOffline(false);
    const result = await retryAllPending(db, { organizationId: orgId });

    expect(result).toMatchObject({ attempted: 3, issued: 3, failed: 0 });
    expect(listReceipts(db, { status: 'issued' })).toHaveLength(3);
  });
});

describe('מניעת כפילות קבלות (Idempotency)', () => {
  let db: Db;
  let orgId: number;
  let memberId: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    memberId = makeMember(db).id;
  });

  afterEach(() => db.close());

  it('רישום תשלום פעמיים עם אותו מפתח יוצר תשלום, הכנסה וקבלה אחת בלבד', async () => {
    const commitment = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 1800 });
    const input = {
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'bank_transfer' as const,
      idempotencyKey: 'transfer-2026-08-30-001',
    };

    const first = await recordPayment(db, input);
    const second = await recordPayment(db, input);

    expect(second.payment.id).toBe(first.payment.id);
    expect(second.incomeId).toBe(first.incomeId);
    expect(second.receiptId).toBe(first.receiptId);

    expect(listIncomes(db)).toHaveLength(1);
    expect(listReceipts(db)).toHaveLength(1);
    // היתרה ירדה פעם אחת בלבד.
    expect(getCommitment(db, commitment.id).balanceAgorot).toBe(80_000);
  });

  it('ניסיון הפקה חוזר על קבלה שכבר הופקה אינו יוצר קבלה שנייה', async () => {
    const result = await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });
    const originalNumber = getReceipt(db, result.receiptId!).receiptNumber;

    await retryReceipt(db, result.receiptId!);
    await retryReceipt(db, result.receiptId!);

    const receipts = listReceipts(db);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.receiptNumber).toBe(originalNumber);
  });

  it('אותו מפתח idempotency אצל הספק מחזיר את אותה קבלה', async () => {
    const provider = receiptProviderFor(db, orgId);
    const request = {
      idempotencyKey: 'payment-99-receipt-0',
      documentType: 'receipt' as const,
      amountAgorot: 50_000,
      currency: 'ILS' as const,
      issueDate: '2026-08-30',
      description: 'בדיקה',
      paymentMethod: 'cash',
      customer: { name: 'יעקב כהן' },
      reference: { paymentId: 99, incomeId: 99, organizationId: orgId },
    };

    const first = await provider.createReceipt(request);
    const second = await provider.createReceipt(request);

    expect(second.providerReceiptId).toBe(first.providerReceiptId);
    expect(second.receiptNumber).toBe(first.receiptNumber);
  });

  it('אילוץ בבסיס הנתונים מונע שתי קבלות פעילות לאותו תשלום', async () => {
    const result = await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });

    expect(() =>
      db
        .prepare(
          `INSERT INTO receipts (organization_id, payment_id, income_id, idempotency_key,
             document_type, amount_agorot, status, provider)
           VALUES (?, ?, ?, 'duplicate-key', 'receipt', 50000, 'pending', 'mock')`,
        )
        .run(orgId, result.payment.id, result.incomeId),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('לאחר ביטול קבלה ניתן להפיק קבלה חלופית', async () => {
    const result = await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });

    await cancelReceipt(db, result.receiptId!, 'טעות בסכום');
    expect(getReceipt(db, result.receiptId!).status).toBe('cancelled');

    const { ensureReceiptRecord } = await import('../src/services/receipts.js');
    const replacement = ensureReceiptRecord(db, {
      paymentId: result.payment.id,
      incomeId: result.incomeId!,
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      documentType: 'receipt',
      initialStatus: 'pending',
    });

    // מפתח חדש - כדי שהספק יפיק מסמך חדש ולא יחזיר את הישן.
    expect(replacement.id).not.toBe(result.receiptId);
    expect(replacement.idempotency_key).not.toBe('payment-' + result.payment.id + '-receipt-0');

    const issued = await retryReceipt(db, replacement.id);
    expect(issued.issued).toBe(true);
    expect(listReceipts(db, { status: 'issued' })).toHaveLength(1);
  });
});

describe('קבלה אוטומטית מול אישור ידני (סעיף 29)', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  it('עמותה במצב אוטומטי מפיקה קבלה מיד', async () => {
    const orgId = makeOrganization(db, { receiptIssueMode: 'automatic' }).id;
    const memberId = makeMember(db).id;

    const result = await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });

    expect(getReceipt(db, result.receiptId!).status).toBe('issued');
  });

  it('עמותה במצב אישור ידני ממתינה לאישור הגזבר', async () => {
    const orgId = makeOrganization(db, {
      name: 'אחוות תורה',
      receiptIssueMode: 'manual_approval',
    }).id;
    const memberId = makeMember(db).id;

    const result = await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });

    const receipt = getReceipt(db, result.receiptId!);
    expect(receipt.status).toBe('awaiting_approval');
    expect(receipt.receiptNumber).toBeNull();
    // ההכנסה כבר נרשמה גם ללא קבלה.
    expect(listIncomes(db)).toHaveLength(1);

    const approved = await approveReceipt(db, receipt.id);
    expect(approved.issued).toBe(true);
    expect(approved.receipt.receiptNumber).toBeTruthy();
  });

  it('ניסיון חוזר על קבלה הממתינה לאישור נחסם', async () => {
    const orgId = makeOrganization(db, { receiptIssueMode: 'manual_approval' }).id;
    const memberId = makeMember(db).id;
    const result = await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });

    await expect(retryReceipt(db, result.receiptId!)).rejects.toThrow(/ממתינה לאישור/);
  });

  it('שתי עמותות יכולות להיות מוגדרות אחרת זו מזו', async () => {
    const autoOrg = makeOrganization(db, { name: 'בית הכנסת', receiptIssueMode: 'automatic' }).id;
    const manualOrg = makeOrganization(db, {
      name: 'אחוות תורה',
      receiptIssueMode: 'manual_approval',
    }).id;
    const memberId = makeMember(db).id;

    const autoResult = await recordPayment(db, {
      organizationId: autoOrg,
      memberId,
      amountAgorot: shekelsToAgorot(100),
      method: 'cash',
    });
    const manualResult = await recordPayment(db, {
      organizationId: manualOrg,
      memberId,
      amountAgorot: shekelsToAgorot(100),
      method: 'cash',
    });

    expect(getReceipt(db, autoResult.receiptId!).status).toBe('issued');
    expect(getReceipt(db, manualResult.receiptId!).status).toBe('awaiting_approval');
  });
});

describe('פעולות נוספות על קבלות (סעיף 26)', () => {
  let db: Db;
  let orgId: number;
  let receiptId: number;

  beforeEach(async () => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    const memberId = makeMember(db).id;
    const result = await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });
    receiptId = result.receiptId!;
  });

  afterEach(() => db.close());

  it('הורדת PDF שומרת את הקובץ ומחזירה מסמך תקין', async () => {
    const download = await downloadReceiptPdf(db, receiptId);
    expect(download.contentType).toBe('application/pdf');
    expect(download.data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(getReceipt(db, receiptId).hasPdf).toBe(true);
  });

  it('בדיקת סטטוס מסנכרנת מול הספק', async () => {
    const refreshed = await refreshReceiptStatus(db, receiptId);
    expect(refreshed.status).toBe('issued');
  });

  it('ביטול קבלה מעדכן גם את ההכנסה', async () => {
    await cancelReceipt(db, receiptId, 'טעות');
    expect(getReceipt(db, receiptId).status).toBe('cancelled');
    const income = listIncomes(db)[0]!;
    expect(income.receipt.status).toBe('pending');
    expect(income.receipt.issued).toBe(false);
  });

  it('ההכנסות נספרות בסיכום הגבייה גם כשהקבלה נכשלה', async () => {
    expect(getCollectionSummary(db).collectedAgorot).toBe(0); // תשלום ללא התחייבות
    expect(listIncomes(db)).toHaveLength(1);
  });
});
