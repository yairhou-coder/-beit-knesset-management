/**
 * הוראת קבע שמשלמת התחייבות בתשלומים (מקום/ריהוט).
 * להבדיל מהו"ק שוטפת, שאינה מקושרת להתחייבות ורצה ללא הגבלה.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import { getCommitment } from '../src/services/commitments.js';
import {
  chargeStandingOrder,
  createStandingOrder,
  getStandingOrder,
} from '../src/services/standingOrders.js';
import { listIncomes } from '../src/services/incomes.js';
import { createTestDb, makeCommitment, makeMember, makeOrganization, typeId } from './helpers.js';

describe('הוראת קבע בתשלומים עבור התחייבות', () => {
  let db: Db;
  let orgId: number;
  let memberId: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    memberId = makeMember(db).id;
  });

  afterEach(() => db.close());

  it('כל חיוב מקטין את יתרת ההתחייבות', async () => {
    const commitment = makeCommitment(db, {
      memberId,
      organizationId: orgId,
      amountShekels: 1200,
      typeKey: 'seat',
    });
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(300),
    });

    await chargeStandingOrder(db, order.id, '2026-01');
    expect(getCommitment(db, commitment.id).balanceAgorot).toBe(90_000);

    await chargeStandingOrder(db, order.id, '2026-02');
    expect(getCommitment(db, commitment.id)).toMatchObject({
      paidAgorot: 60_000,
      balanceAgorot: 60_000,
      status: 'partially_paid',
    });
  });

  it('החיוב האחרון אינו חורג מהיתרה, וההוראה מסתיימת', async () => {
    const commitment = makeCommitment(db, {
      memberId,
      organizationId: orgId,
      amountShekels: 700,
      typeKey: 'seat',
    });
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(300),
    });

    await chargeStandingOrder(db, order.id, '2026-01');
    await chargeStandingOrder(db, order.id, '2026-02');
    // נותרו 100 ₪ בלבד, אף שסכום ההוראה הוא 300
    const last = await chargeStandingOrder(db, order.id, '2026-03');

    expect(last.payment.amountAgorot).toBe(10_000);
    expect(getCommitment(db, commitment.id)).toMatchObject({
      paidAgorot: 70_000,
      balanceAgorot: 0,
      status: 'paid',
    });
    expect(getStandingOrder(db, order.id).status).toBe('completed');
  });

  it('לא ניתן לחייב לאחר שההתחייבות סולקה', async () => {
    const commitment = makeCommitment(db, {
      memberId,
      organizationId: orgId,
      amountShekels: 300,
      typeKey: 'seat',
    });
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(300),
    });
    await chargeStandingOrder(db, order.id, '2026-01');

    await expect(chargeStandingOrder(db, order.id, '2026-02')).rejects.toThrow(/שולמה במלואה/);
  });

  it('הו"ק שוטפת אינה מקושרת להתחייבות ורצה ללא הגבלה', async () => {
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      commitmentTypeId: typeId(db, 'membership'),
      amountAgorot: shekelsToAgorot(150),
    });

    for (const period of ['2026-01', '2026-02', '2026-03']) {
      await chargeStandingOrder(db, order.id, period);
    }

    expect(getStandingOrder(db, order.id).status).toBe('active');
    expect(getStandingOrder(db, order.id).commitment).toBeNull();
    expect(listIncomes(db)).toHaveLength(3);
  });

  it('דוחה קישור להתחייבות של חבר אחר', () => {
    const other = makeMember(db, { firstName: 'משה', lastName: 'לוי' }).id;
    const commitment = makeCommitment(db, {
      memberId: other,
      organizationId: orgId,
      amountShekels: 500,
    });

    expect(() =>
      createStandingOrder(db, {
        memberId,
        organizationId: orgId,
        commitmentId: commitment.id,
        amountAgorot: shekelsToAgorot(100),
      }),
    ).toThrow(/שייכת לחבר אחר/);
  });

  it('הוראה מציגה את מצב ההתחייבות שהיא משלמת', async () => {
    const commitment = makeCommitment(db, {
      memberId,
      organizationId: orgId,
      amountShekels: 1000,
      typeKey: 'seat',
    });
    const order = createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(250),
    });
    await chargeStandingOrder(db, order.id, '2026-01');

    expect(getStandingOrder(db, order.id).commitment).toMatchObject({
      amountAgorot: 100_000,
      paidAgorot: 25_000,
      balanceAgorot: 75_000,
    });
  });
});
