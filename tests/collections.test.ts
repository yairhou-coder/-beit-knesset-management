/** מסך הגבייה, גיל החוב והדשבורד (סעיפים 23, 30). */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import { recordPayment } from '../src/services/payments.js';
import { listCommitments } from '../src/services/commitments.js';
import {
  collectedThisMonthOnPriorDebt,
  debtByEvent,
  debtByType,
  getAgingBuckets,
  listDebtors,
  outstandingOlderThan,
} from '../src/services/collections.js';
import { getDashboard } from '../src/services/dashboard.js';
import { createEvent } from '../src/services/catalog.js';
import { createCommitment } from '../src/services/commitments.js';
import {
  createTestDb,
  daysAgo,
  makeCommitment,
  makeMember,
  makeOrganization,
  typeId,
} from './helpers.js';

describe('גבייה וחובות', () => {
  let db: Db;
  let orgId: number;
  let alice: number;
  let bob: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    alice = makeMember(db, { firstName: 'יעקב', lastName: 'כהן' }).id;
    bob = makeMember(db, { firstName: 'משה', lastName: 'לוי' }).id;
  });

  afterEach(() => db.close());

  it('רשימת החייבים מציגה מי חייב, כמה, וכמה זמן החוב פתוח', () => {
    makeCommitment(db, {
      memberId: alice,
      organizationId: orgId,
      amountShekels: 2500,
      commitmentDate: daysAgo(95),
    });
    makeCommitment(db, {
      memberId: bob,
      organizationId: orgId,
      amountShekels: 500,
      commitmentDate: daysAgo(10),
    });

    const debtors = listDebtors(db, { organizationId: orgId });
    expect(debtors).toHaveLength(2);

    // ממוין לפי גובה החוב, מהגבוה לנמוך.
    expect(debtors[0]!.member.id).toBe(alice);
    expect(debtors[0]!.outstandingAgorot).toBe(250_000);
    expect(debtors[0]!.oldestDebtDays).toBeGreaterThanOrEqual(94);
    expect(debtors[1]!.outstandingAgorot).toBe(50_000);
  });

  it('דלי גיל החוב מסווגים נכון לפי ימים', () => {
    makeCommitment(db, { memberId: alice, organizationId: orgId, amountShekels: 100, commitmentDate: daysAgo(5) });
    makeCommitment(db, { memberId: alice, organizationId: orgId, amountShekels: 200, commitmentDate: daysAgo(45) });
    makeCommitment(db, { memberId: bob, organizationId: orgId, amountShekels: 300, commitmentDate: daysAgo(75) });
    makeCommitment(db, { memberId: bob, organizationId: orgId, amountShekels: 400, commitmentDate: daysAgo(120) });

    const buckets = getAgingBuckets(db, { organizationId: orgId });
    const byLabel = Object.fromEntries(buckets.map((row) => [row.label, row.outstandingAgorot]));

    expect(byLabel['עד 30 יום']).toBe(10_000);
    expect(byLabel['31-60 יום']).toBe(20_000);
    expect(byLabel['61-90 יום']).toBe(30_000);
    expect(byLabel['מעל 90 יום']).toBe(40_000);
  });

  it('חובות מעל 30 ו-60 יום מחושבים נכון (סעיף 30)', () => {
    makeCommitment(db, { memberId: alice, organizationId: orgId, amountShekels: 100, commitmentDate: daysAgo(10) });
    makeCommitment(db, { memberId: alice, organizationId: orgId, amountShekels: 200, commitmentDate: daysAgo(40) });
    makeCommitment(db, { memberId: bob, organizationId: orgId, amountShekels: 300, commitmentDate: daysAgo(80) });

    expect(outstandingOlderThan(db, 30).amountAgorot).toBe(50_000);
    expect(outstandingOlderThan(db, 60).amountAgorot).toBe(30_000);
    expect(outstandingOlderThan(db, 60).commitmentCount).toBe(1);
  });

  it('תשלום חלקי מוציא את ההתחייבות מ"פתוח" ומשאיר יתרה', async () => {
    const commitment = makeCommitment(db, {
      memberId: alice,
      organizationId: orgId,
      amountShekels: 1000,
      commitmentDate: daysAgo(40),
    });
    await recordPayment(db, {
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(400),
      method: 'cash',
    });

    expect(listCommitments(db, { status: 'open' })).toHaveLength(0);
    expect(listCommitments(db, { status: 'partially_paid' })).toHaveLength(1);
    expect(listCommitments(db, { outstandingOnly: true })).toHaveLength(1);
    expect(listDebtors(db)[0]!.outstandingAgorot).toBe(60_000);
  });

  it('גבייה החודש בגין חובות קודמים סופרת רק התחייבויות מחודש קודם', async () => {
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;

    // התחייבות ישנה ששולמה החודש - נספרת.
    const old = makeCommitment(db, {
      memberId: alice,
      organizationId: orgId,
      amountShekels: 1000,
      commitmentDate: daysAgo(60),
    });
    await recordPayment(db, {
      commitmentId: old.id,
      amountAgorot: shekelsToAgorot(400),
      method: 'cash',
      paymentDate: monthStart,
    });

    // התחייבות מהחודש ששולמה החודש - אינה "חוב קודם".
    const fresh = createCommitment(db, {
      memberId: bob,
      organizationId: orgId,
      commitmentTypeId: typeId(db, 'donation'),
      amountAgorot: shekelsToAgorot(500),
      commitmentDate: monthStart,
    });
    await recordPayment(db, {
      commitmentId: fresh.id,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
      paymentDate: monthStart,
    });

    const result = collectedThisMonthOnPriorDebt(db, { organizationId: orgId });
    expect(result.amountAgorot).toBe(40_000);
    expect(result.paymentCount).toBe(1);
  });

  it('סינון לפי סכום, סטטוס, תאריך, אירוע וסוג', async () => {
    const event = createEvent(db, { name: 'יום כיפור', kind: 'holiday', organizationId: orgId });
    createCommitment(db, {
      memberId: alice,
      organizationId: orgId,
      commitmentTypeId: typeId(db, 'aliyah'),
      eventId: event.id,
      amountAgorot: shekelsToAgorot(1800),
      commitmentDate: daysAgo(30),
    });
    createCommitment(db, {
      memberId: bob,
      organizationId: orgId,
      commitmentTypeId: typeId(db, 'donation'),
      amountAgorot: shekelsToAgorot(300),
      commitmentDate: daysAgo(5),
    });

    expect(listCommitments(db, { minAmountAgorot: 100_000 })).toHaveLength(1);
    expect(listCommitments(db, { maxAmountAgorot: 50_000 })).toHaveLength(1);
    expect(listCommitments(db, { eventId: event.id })).toHaveLength(1);
    expect(listCommitments(db, { commitmentTypeId: typeId(db, 'donation') })).toHaveLength(1);
    expect(listCommitments(db, { memberSearch: 'משה' })).toHaveLength(1);
    expect(listCommitments(db, { fromDate: daysAgo(10) })).toHaveLength(1);
    expect(listCommitments(db, { minAgeDays: 20 })).toHaveLength(1);

    // פילוחים
    expect(debtByEvent(db).find((row) => row.label === 'יום כיפור')?.outstandingAgorot).toBe(180_000);
    expect(debtByType(db).find((row) => row.label === 'תרומה')?.outstandingAgorot).toBe(30_000);
  });

  it('התחייבות באיחור מסומנת כפיגור', () => {
    const commitment = makeCommitment(db, {
      memberId: alice,
      organizationId: orgId,
      amountShekels: 500,
      commitmentDate: daysAgo(60),
      dueDate: daysAgo(20),
    });

    const loaded = listCommitments(db, { overdueOnly: true });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe(commitment.id);
    expect(loaded[0]!.isOverdue).toBe(true);
    expect(loaded[0]!.overdueDays).toBeGreaterThanOrEqual(19);
  });
});

describe('כרטיסי הדשבורד (סעיף 30)', () => {
  let db: Db;
  let orgId: number;

  beforeEach(async () => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    const memberId = makeMember(db).id;

    makeCommitment(db, {
      memberId,
      organizationId: orgId,
      amountShekels: 2500,
      commitmentDate: daysAgo(95),
    });
    const partial = makeCommitment(db, {
      memberId,
      organizationId: orgId,
      amountShekels: 1800,
      commitmentDate: daysAgo(40),
    });
    await recordPayment(db, {
      commitmentId: partial.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'cash',
    });
    // תשלום שאינו משויך לחבר.
    await recordPayment(db, {
      organizationId: orgId,
      memberId: null,
      amountAgorot: shekelsToAgorot(360),
      method: 'bank_transfer',
      receiptRequired: false,
    });
  });

  afterEach(() => db.close());

  it('כל כרטיס מחזיר ערך וקישור לרשימה המתאימה', () => {
    const dashboard = getDashboard(db, { organizationId: orgId });

    const byKey = Object.fromEntries(
      [...dashboard.headline, ...dashboard.collection].map((card) => [card.key, card]),
    );

    // סעיף 30 - כל הכרטיסים הנדרשים קיימים.
    for (const key of [
      'open_commitments',
      'total_to_collect',
      'collected_this_month',
      'new_commitments',
      'over_30',
      'over_60',
      'receipts_awaiting',
      'receipts_failed',
      'unassigned_payments',
    ]) {
      expect(byKey[key], `כרטיס ${key} חסר`).toBeDefined();
      expect(byKey[key]!.link).toMatch(/^#\//);
    }

    expect(byKey['total_to_collect']!.amountAgorot).toBe(330_000);
    expect(byKey['over_60']!.amountAgorot).toBe(250_000);
    expect(byKey['over_30']!.amountAgorot).toBe(330_000);
    expect(byKey['unassigned_payments']!.count).toBe(1);
    expect(byKey['unassigned_payments']!.amountAgorot).toBe(36_000);
    expect(byKey['debtors']!.count).toBe(1);
  });

  it('הדשבורד מסונן לפי עמותה', () => {
    const otherOrg = makeOrganization(db, { name: 'אחוות תורה' }).id;
    const dashboard = getDashboard(db, { organizationId: otherOrg });
    expect(dashboard.summary.outstandingAgorot).toBe(0);
    expect(dashboard.scope.organizationName).toBe('אחוות תורה');
  });
});
