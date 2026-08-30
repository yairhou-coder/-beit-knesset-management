/**
 * תהליך התשלום המלא (סעיף 27) והתחייבויות (סעיף 23).
 * מממש בדיוק את התרחיש מהאפיון: עלייה ב-1,800 ₪, תשלום 1,000 ואז 800.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import { getCommitment, listCommitments } from '../src/services/commitments.js';
import { listIncomes } from '../src/services/incomes.js';
import { listReceipts } from '../src/services/receipts.js';
import { recordPayment, refundPayment } from '../src/services/payments.js';
import { getCollectionSummary } from '../src/services/collections.js';
import { createTestDb, makeCommitment, makeMember, makeOrganization } from './helpers.js';

describe('תהליך התשלום המלא', () => {
  let db: Db;
  let orgId: number;
  let memberId: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    memberId = makeMember(db).id;
  });

  afterEach(() => db.close());

  it('שלב 1: יצירת התחייבות של 1,800 ₪ אינה יוצרת הכנסה', () => {
    const commitment = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 1800 });

    expect(commitment.amountAgorot).toBe(180_000);
    expect(commitment.paidAgorot).toBe(0);
    expect(commitment.balanceAgorot).toBe(180_000);
    expect(commitment.status).toBe('open');

    // התחייבות איננה הכנסה - סעיף 23.
    expect(listIncomes(db)).toHaveLength(0);
    expect(listReceipts(db)).toHaveLength(0);

    const summary = getCollectionSummary(db);
    expect(summary.committedAgorot).toBe(180_000);
    expect(summary.collectedAgorot).toBe(0);
    expect(summary.outstandingAgorot).toBe(180_000);
  });

  it('שלב 2: תשלום 1,000 ₪ מקטין את היתרה ל-800, רושם הכנסה ומפיק קבלה', async () => {
    const commitment = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 1800 });

    const result = await recordPayment(db, {
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'bank_transfer',
    });

    expect(result.commitment).toMatchObject({
      amountAgorot: 180_000,
      paidAgorot: 100_000,
      balanceAgorot: 80_000,
      status: 'partially_paid',
    });

    // הכנסה נרשמת רק עכשיו, על סכום התשלום בפועל.
    const incomes = listIncomes(db);
    expect(incomes).toHaveLength(1);
    expect(incomes[0]!.amountAgorot).toBe(100_000);

    // קבלה על 1,000 ₪ בלבד - לא על סכום ההתחייבות.
    const receipts = listReceipts(db);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.amountAgorot).toBe(100_000);
    expect(receipts[0]!.status).toBe('issued');
    expect(receipts[0]!.receiptNumber).toBeTruthy();
  });

  it('שלב 3: תשלום היתרה מסמן "שולם במלואו" ומפיק קבלה נוספת', async () => {
    const commitment = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 1800 });

    await recordPayment(db, {
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'bank_transfer',
    });
    const second = await recordPayment(db, {
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(800),
      method: 'cash',
    });

    expect(second.commitment).toMatchObject({
      paidAgorot: 180_000,
      balanceAgorot: 0,
      status: 'paid',
    });

    const incomes = listIncomes(db);
    expect(incomes).toHaveLength(2);
    expect(incomes.reduce((sum, income) => sum + income.amountAgorot, 0)).toBe(180_000);

    // שתי קבלות נפרדות, אחת לכל תשלום.
    const receipts = listReceipts(db);
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.amountAgorot).sort((a, b) => a - b)).toEqual([
      80_000, 100_000,
    ]);
    expect(new Set(receipts.map((receipt) => receipt.receiptNumber)).size).toBe(2);
  });

  it('דוחות מבדילים בין התחייבויות, כספים שנגבו ויתרות שטרם נגבו', async () => {
    const commitment = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 1800 });
    await recordPayment(db, {
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'cash',
    });

    const summary = getCollectionSummary(db);
    expect(summary.committedAgorot).toBe(180_000);
    expect(summary.collectedAgorot).toBe(100_000);
    expect(summary.outstandingAgorot).toBe(80_000);
    expect(summary.collectionRate).toBeCloseTo(55.6, 1);
  });

  it('דוחה תשלום הגבוה מיתרת ההתחייבות', async () => {
    const commitment = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 1800 });
    await recordPayment(db, {
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'cash',
    });

    await expect(
      recordPayment(db, {
        commitmentId: commitment.id,
        amountAgorot: shekelsToAgorot(900),
        method: 'cash',
      }),
    ).rejects.toThrow(/גבוה מיתרת ההתחייבות/);

    // ההתחייבות לא השתנתה.
    expect(getCommitment(db, commitment.id).paidAgorot).toBe(100_000);
  });

  it('תשלום שנכשל אינו יוצר הכנסה ואינו מקטין את היתרה', async () => {
    const commitment = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 1800 });

    const result = await recordPayment(db, {
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'credit_card',
      status: 'failed',
      failureReason: 'הכרטיס נדחה',
    });

    expect(result.incomeId).toBeNull();
    expect(result.commitment?.balanceAgorot).toBe(180_000);
    expect(listIncomes(db)).toHaveLength(0);
  });

  it('זיכוי תשלום מחזיר את היתרה ומבטל את ההכנסה בלי למחוק אותה', async () => {
    const commitment = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 1800 });
    const result = await recordPayment(db, {
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'cash',
    });

    refundPayment(db, result.payment.id, 'טעות ברישום');

    expect(getCommitment(db, commitment.id)).toMatchObject({
      paidAgorot: 0,
      balanceAgorot: 180_000,
      status: 'open',
    });
    // ההכנסה אינה נספרת בדוחות, אך הרשומה נשמרת לביקורת.
    expect(listIncomes(db)).toHaveLength(0);
    expect(listIncomes(db, { includeReversed: true })).toHaveLength(1);
    expect(getCollectionSummary(db).collectedAgorot).toBe(0);
  });

  it('התחייבות ללא תשלומים ניתנת לביטול, ועם תשלום - לא', async () => {
    const { cancelCommitment } = await import('../src/services/commitments.js');
    const first = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 500 });
    expect(cancelCommitment(db, first.id, 'בקשת החבר').status).toBe('cancelled');

    const second = makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 500 });
    await recordPayment(db, {
      commitmentId: second.id,
      amountAgorot: shekelsToAgorot(100),
      method: 'cash',
    });
    expect(() => cancelCommitment(db, second.id)).toThrow(/שולמה בחלקה/);

    // התחייבות שבוטלה אינה נספרת כחוב פתוח.
    const summary = getCollectionSummary(db);
    expect(summary.outstandingAgorot).toBe(40_000);
    expect(listCommitments(db, { outstandingOnly: true })).toHaveLength(1);
  });
});
