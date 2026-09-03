/**
 * הכנסות לפי מקור.
 *
 * שלושה זרמים שונים לגמרי: דמי החבר החודשיים הם הכנסה קבועה ללא סוף,
 * תשלומי המקומות הם הכנסה שנגמרת כשההתחייבות מסולקת, וכל השאר חד-פעמי.
 * ערבוב שלהם מסתיר בדיוק את מה שהגבאי צריך לראות.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import { getIncomeSummary, listIncomes } from '../src/services/incomes.js';
import { recordPayment } from '../src/services/payments.js';
import { createSeatCommitment } from '../src/services/seats.js';
import { chargeStandingOrder, createStandingOrder } from '../src/services/standingOrders.js';
import { createTestDb, makeMember, makeOrganization, typeId } from './helpers.js';

describe('הכנסות לפי מקור', () => {
  let db: Db;
  let orgId: number;
  let memberId: number;

  beforeEach(async () => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    memberId = makeMember(db).id;

    // הו"ק שוטפת - דמי חבר 150 ₪, נגבתה פעמיים
    const dues = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      commitmentTypeId: typeId(db, 'membership'),
      amountAgorot: shekelsToAgorot(150),
      method: 'standing_order',
      startDate: '2026-01-01',
    });
    await chargeStandingOrder(db, dues.id, '2026-01');
    await chargeStandingOrder(db, dues.id, '2026-02');

    // הו"ק מקום/ריהוט 400 ₪, נגבתה פעם אחת
    const seat = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: null,
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(400),
    });
    await chargeStandingOrder(db, seat.standingOrderId!, '2026-01');

    // תרומה חד-פעמית
    await recordPayment(db, {
      organizationId: orgId,
      memberId,
      amountAgorot: shekelsToAgorot(1000),
      paymentDate: '2026-02-15',
      method: 'cash',
      description: 'תרומה',
    });
  });

  afterEach(() => db.close());

  it('כל הכנסה מסווגת למקור הנכון', () => {
    const items = listIncomes(db, {});
    const bySource = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.source] = (acc[item.source] ?? 0) + 1;
      return acc;
    }, {});
    expect(bySource).toEqual({ recurring: 2, seats: 1, other: 1 });
  });

  it('הסיכום מפריד בין הו"ק שוטפת, מקומות וריהוט, ושאר ההכנסות', () => {
    const summary = getIncomeSummary(db, {});
    const amount = (source: string) =>
      summary.bySource.find((row) => row.source === source)!.amountAgorot;

    expect(amount('recurring')).toBe(shekelsToAgorot(300)); // 150 × 2
    expect(amount('seats')).toBe(shekelsToAgorot(400));
    expect(amount('other')).toBe(shekelsToAgorot(1000));
    expect(summary.totalAgorot).toBe(shekelsToAgorot(1700));
    expect(summary.count).toBe(4);
  });

  it('שלושת המקורות מוחזרים תמיד, גם כשאין בהם הכנסות', () => {
    const summary = getIncomeSummary(db, { source: 'seats' });
    expect(summary.bySource).toHaveLength(3);
    expect(summary.bySource.find((row) => row.source === 'recurring')!.amountAgorot).toBe(0);
    expect(summary.bySource.find((row) => row.source === 'seats')!.amountAgorot).toBe(
      shekelsToAgorot(400),
    );
  });

  it('סינון לפי מקור מחזיר רק את ההכנסות שלו', () => {
    expect(listIncomes(db, { source: 'recurring' })).toHaveLength(2);
    expect(listIncomes(db, { source: 'seats' })).toHaveLength(1);
    expect(listIncomes(db, { source: 'other' })).toHaveLength(1);
  });

  it('הפילוח לפי סוג מבדיל בין דמי חבר למקום וריהוט', () => {
    const byType = getIncomeSummary(db, {}).byType;
    const find = (name: string) => byType.find((row) => row.label === name);

    expect(find('דמי חבר')!.amountAgorot).toBe(shekelsToAgorot(300));
    expect(find('מקום וריהוט')!.amountAgorot).toBe(shekelsToAgorot(400));
  });

  it('סינון לפי סוג עובד מצד ההכנסות', () => {
    const seatType = typeId(db, 'seat');
    const filtered = listIncomes(db, { commitmentTypeId: seatType });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.amountAgorot).toBe(shekelsToAgorot(400));
    expect(filtered[0]!.sourceLabel).toBe('הו״ק מקומות וריהוט');
  });

  it('הסיכום מחושב על כל ההכנסות ולא רק על השורות שנטענו', () => {
    const summary = getIncomeSummary(db, { limit: 1 });
    expect(summary.count).toBe(4);
    expect(summary.totalAgorot).toBe(shekelsToAgorot(1700));
    expect(listIncomes(db, { limit: 1 })).toHaveLength(1);
  });
});
