/** הפרדה בין עמותות (סעיף 25) ודוחות מאוחדים. */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import { recordPayment } from '../src/services/payments.js';
import { listCommitments } from '../src/services/commitments.js';
import { listIncomes } from '../src/services/incomes.js';
import { listReceipts } from '../src/services/receipts.js';
import {
  debtByOrganization,
  getCollectionSummary,
  getFinancialReport,
} from '../src/services/collections.js';
import { updateOrganization } from '../src/services/organizations.js';
import { createEvent } from '../src/services/catalog.js';
import { createCommitment } from '../src/services/commitments.js';
import {
  createTestDb,
  makeCommitment,
  makeMember,
  makeOrganization,
  typeId,
} from './helpers.js';

describe('הפרדה בין עמותות', () => {
  let db: Db;
  let synagogue: number;
  let achvatTorah: number;
  let memberId: number;

  beforeEach(async () => {
    db = createTestDb();
    synagogue = makeOrganization(db, { name: 'בית הכנסת' }).id;
    achvatTorah = makeOrganization(db, { name: 'אחוות תורה' }).id;
    memberId = makeMember(db).id;

    const first = makeCommitment(db, {
      memberId,
      organizationId: synagogue,
      amountShekels: 1800,
    });
    await recordPayment(db, {
      commitmentId: first.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'cash',
    });

    const second = makeCommitment(db, {
      memberId,
      organizationId: achvatTorah,
      amountShekels: 3600,
      typeKey: 'donation',
    });
    await recordPayment(db, {
      commitmentId: second.id,
      amountAgorot: shekelsToAgorot(600),
      method: 'bank_transfer',
    });
  });

  afterEach(() => db.close());

  it('סיכום גבייה מסונן לפי עמותה אינו כולל נתונים של עמותה אחרת', () => {
    const synagogueSummary = getCollectionSummary(db, { organizationId: synagogue });
    expect(synagogueSummary.committedAgorot).toBe(180_000);
    expect(synagogueSummary.collectedAgorot).toBe(100_000);
    expect(synagogueSummary.outstandingAgorot).toBe(80_000);

    const achvatSummary = getCollectionSummary(db, { organizationId: achvatTorah });
    expect(achvatSummary.committedAgorot).toBe(360_000);
    expect(achvatSummary.collectedAgorot).toBe(60_000);
    expect(achvatSummary.outstandingAgorot).toBe(300_000);
  });

  it('התחייבויות, הכנסות וקבלות מסוננות לפי עמותה', () => {
    expect(listCommitments(db, { organizationId: synagogue })).toHaveLength(1);
    expect(listIncomes(db, { organizationId: achvatTorah })).toHaveLength(1);
    expect(listReceipts(db, { organizationId: synagogue })).toHaveLength(1);

    const receipts = listReceipts(db, { organizationId: achvatTorah });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.organization.id).toBe(achvatTorah);
  });

  it('מספרי הקבלות של העמותות אינם מתנגשים', () => {
    const numbers = listReceipts(db).map((receipt) => receipt.receiptNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('הדוח מציג כל עמותה בנפרד וגם תמונה מאוחדת', () => {
    db.prepare(
      `INSERT INTO expenses (organization_id, category, amount_agorot, expense_date)
       VALUES (?, 'חשמל', ?, date('now'))`,
    ).run(synagogue, shekelsToAgorot(450));

    const report = getFinancialReport(db);
    expect(report.perOrganization).toHaveLength(2);

    const synagogueReport = report.perOrganization.find(
      (row) => row.organization?.id === synagogue,
    )!;
    expect(synagogueReport.incomeAgorot).toBe(100_000);
    expect(synagogueReport.expenseAgorot).toBe(45_000);
    expect(synagogueReport.netAgorot).toBe(55_000);

    // התמונה המאוחדת היא סכימה של העמותות, לא ערבוב שלהן.
    expect(report.combined.incomeAgorot).toBe(160_000);
    expect(report.combined.committedAgorot).toBe(540_000);
    expect(report.combined.outstandingAgorot).toBe(380_000);
  });

  it('פילוח חובות לפי עמותה מפריד את הסכומים', () => {
    const rows = debtByOrganization(db);
    expect(rows).toHaveLength(2);
    const byName = Object.fromEntries(rows.map((row) => [row.label, row.outstandingAgorot]));
    expect(byName['בית הכנסת']).toBe(80_000);
    expect(byName['אחוות תורה']).toBe(300_000);
  });

  it('תשלום אינו יכול לסתור את העמותה של ההתחייבות', async () => {
    const commitment = makeCommitment(db, {
      memberId,
      organizationId: synagogue,
      amountShekels: 100,
    });
    await expect(
      recordPayment(db, {
        commitmentId: commitment.id,
        organizationId: achvatTorah,
        amountAgorot: shekelsToAgorot(100),
        method: 'cash',
      }),
    ).rejects.toThrow(/אינה תואמת את העמותה בהתחייבות/);
  });

  it('אירוע של עמותה אחת אינו ניתן לשיוך להתחייבות של עמותה אחרת', () => {
    const event = createEvent(db, {
      name: 'דינר שנתי',
      kind: 'event',
      organizationId: achvatTorah,
    });

    expect(() =>
      createCommitment(db, {
        memberId,
        organizationId: synagogue,
        commitmentTypeId: typeId(db, 'event'),
        eventId: event.id,
        amountAgorot: shekelsToAgorot(500),
      }),
    ).toThrow(/משויך לעמותה אחרת/);
  });

  it('סוג מסמך שאינו מורשה לעמותה מוחלף בברירת המחדל שלה', async () => {
    updateOrganization(db, achvatTorah, {
      allowedDocumentTypes: ['donation_receipt'],
      defaultDocumentType: 'donation_receipt',
    });

    const result = await recordPayment(db, {
      organizationId: achvatTorah,
      memberId,
      amountAgorot: shekelsToAgorot(200),
      method: 'cash',
      documentType: 'invoice', // אינו מורשה לעמותה זו
    });

    const receipt = listReceipts(db).find((row) => row.id === result.receiptId)!;
    expect(receipt.documentType).toBe('donation_receipt');
  });

  it('לא ניתן להגדיר ברירת מחדל שאינה נכללת בסוגי המסמכים המותרים', () => {
    expect(() =>
      updateOrganization(db, synagogue, {
        allowedDocumentTypes: ['receipt'],
        defaultDocumentType: 'invoice',
      }),
    ).toThrow(/אינו נכלל/);
  });
});
