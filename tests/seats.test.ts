/**
 * מקומות וריהוט - התחייבות נפרדת מהוראת הקבע השוטפת.
 *
 * הטסטים מכסים את שלוש דרכי התשלום שהקהילה משתמשת בהן בפועל, ואת
 * ההפרדה עצמה: מה שמופיע במסך המקומות אינו מופיע במסך ההו"ק, ולהפך.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import {
  confirmSeatAmount,
  createSeatCommitment,
  getSeatSummary,
  listSeatCommitments,
  updateSeat,
  updateSeatPlan,
} from '../src/services/seats.js';
import {
  chargeStandingOrder,
  createStandingOrder,
  listStandingOrders,
} from '../src/services/standingOrders.js';
import { createTestDb, makeMember, makeOrganization, typeId } from './helpers.js';

describe('מקומות וריהוט', () => {
  let db: Db;
  let orgId: number;
  let memberId: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    memberId = makeMember(db).id;
  });

  afterEach(() => db.close());

  it('פריסה לתשלומים: 20,000 ₪ ב-40 תשלומים של 500 ₪', async () => {
    const { commitment, standingOrderId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(20000),
      paymentMode: 'standing_order',
      instalmentsCount: 40,
      firstPaymentDate: '2026-01-05',
    });

    expect(standingOrderId).not.toBeNull();
    expect(commitment.amountAgorot).toBe(shekelsToAgorot(20000));
    expect(commitment.instalmentAgorot).toBe(shekelsToAgorot(500));
    expect(commitment.instalmentsCount).toBe(40);
    expect(commitment.balanceAgorot).toBe(shekelsToAgorot(20000));
    expect(commitment.firstPaymentDate).toBe('2026-01-05');
    expect(commitment.dayOfMonth).toBe(5);
    expect(commitment.paymentMode).toBe('standing_order');
  });

  it('אפשר לציין את הסכום החודשי, ומספר התשלומים נגזר ממנו', async () => {
    const { commitment } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(20000),
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });

    expect(commitment.instalmentsCount).toBe(40);
  });

  it('פריסה ללא מספר תשלומים וללא סכום חודשי נדחית', async () => {
    await expect(
      createSeatCommitment(db, {
        memberId,
        organizationId: orgId,
        amountAgorot: shekelsToAgorot(20000),
        paymentMode: 'standing_order',
      }),
    ).rejects.toThrow(/מספר התשלומים או הסכום החודשי/);
  });

  it('תשלום מלא מראש: היתרה מתאפסת מיד וההתחייבות מסומנת כשולמה מראש', async () => {
    const { commitment, paymentId, standingOrderId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(8000),
      paymentMode: 'paid_upfront',
      paidMethod: 'cash',
      paidDate: '2026-02-10',
    });

    expect(paymentId).not.toBeNull();
    expect(standingOrderId).toBeNull();
    expect(commitment.paidAgorot).toBe(shekelsToAgorot(8000));
    expect(commitment.balanceAgorot).toBe(0);
    expect(commitment.paymentMode).toBe('paid_upfront');
    expect(commitment.firstPaymentDate).toBe('2026-02-10');
  });

  it('תשלומים ידניים: ההתחייבות נרשמת עם יתרה מלאה וללא הוראת קבע', async () => {
    const { commitment, standingOrderId, paymentId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(5000),
      paymentMode: 'manual',
    });

    expect(standingOrderId).toBeNull();
    expect(paymentId).toBeNull();
    expect(commitment.balanceAgorot).toBe(shekelsToAgorot(5000));
    expect(commitment.paymentMode).toBe('manual');
  });

  it('חיוב מקטין את היתרה ומעדכן את מספר התשלומים שנותרו', async () => {
    const { commitment, standingOrderId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(2000),
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });
    expect(commitment.instalmentsRemaining).toBe(4);

    await chargeStandingOrder(db, standingOrderId!, '2026-03');
    await chargeStandingOrder(db, standingOrderId!, '2026-04');

    const [after] = listSeatCommitments(db, { memberId });
    expect(after!.paidAgorot).toBe(shekelsToAgorot(1000));
    expect(after!.balanceAgorot).toBe(shekelsToAgorot(1000));
    expect(after!.instalmentsPaid).toBe(2);
    expect(after!.instalmentsRemaining).toBe(2);
  });

  it('הו"ק שוטפת אינה מופיעה במסך המקומות, והתחייבות המקום אינה מופיעה במסך ההו"ק השוטפות', async () => {
    // הו"ק שוטפת: ללא התחייבות מקושרת
    createStandingOrder(db, {
      memberId,
      organizationId: orgId,
      commitmentTypeId: typeId(db, 'membership'),
      amountAgorot: shekelsToAgorot(150),
      startDate: '2026-01-01',
    });

    await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(20000),
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });

    const recurring = listStandingOrders(db, { kind: 'recurring' });
    expect(recurring).toHaveLength(1);
    expect(recurring[0]!.amountAgorot).toBe(shekelsToAgorot(150));
    expect(recurring[0]!.commitment).toBeNull();

    const seats = listSeatCommitments(db, {});
    expect(seats).toHaveLength(1);
    expect(seats[0]!.amountAgorot).toBe(shekelsToAgorot(20000));

    // ללא סינון עדיין רואים את שתיהן, כדי שדוחות כוללים לא יאבדו מידע
    expect(listStandingOrders(db, {})).toHaveLength(2);
    expect(listStandingOrders(db, { kind: 'commitment' })).toHaveLength(1);
  });

  it('הסיכום מפריד בין מי שסיים, מי שבאמצע ומי שטרם התחיל', async () => {
    const second = makeMember(db, { firstName: 'משה', lastName: 'לוי', email: 'moshe@example.com' }).id;
    const third = makeMember(db, { firstName: 'דוד', lastName: 'מזרחי', email: 'david@example.com' }).id;

    // שילם מראש
    await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(10000),
      paymentMode: 'paid_upfront',
    });
    // באמצע תשלומים
    const inProgress = await createSeatCommitment(db, {
      memberId: second,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(10000),
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });
    await chargeStandingOrder(db, inProgress.standingOrderId!, '2026-03');
    // טרם התחיל
    await createSeatCommitment(db, {
      memberId: third,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(6000),
      paymentMode: 'manual',
    });

    const summary = getSeatSummary(db, {});
    expect(summary.count).toBe(3);
    expect(summary.committedAgorot).toBe(shekelsToAgorot(26000));
    expect(summary.paidAgorot).toBe(shekelsToAgorot(10500));
    expect(summary.balanceAgorot).toBe(shekelsToAgorot(15500));
    expect(summary.settledCount).toBe(1);
    expect(summary.inProgressCount).toBe(1);
    expect(summary.notStartedCount).toBe(1);
    // רק ההוראה הפעילה שנותרה לה יתרה נספרת בצפי החודשי
    expect(summary.monthlyExpectedAgorot).toBe(shekelsToAgorot(500));
  });

  it('סינון לפי מצב ולפי אופן תשלום', async () => {
    const second = makeMember(db, { firstName: 'משה', lastName: 'לוי', email: 'moshe@example.com' }).id;
    await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(4000),
      paymentMode: 'paid_upfront',
    });
    await createSeatCommitment(db, {
      memberId: second,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(4000),
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(400),
    });

    expect(listSeatCommitments(db, { state: 'paid' })).toHaveLength(1);
    expect(listSeatCommitments(db, { state: 'outstanding' })).toHaveLength(1);
    expect(listSeatCommitments(db, { paymentMode: 'paid_upfront' })).toHaveLength(1);
    expect(listSeatCommitments(db, { memberSearch: 'לוי' })).toHaveLength(1);
  });

  it('התחייבות שסולקה במלואה מסמנת את ההוראה כהושלמה ומאפסת את התשלומים שנותרו', async () => {
    const { standingOrderId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(1000),
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });

    await chargeStandingOrder(db, standingOrderId!, '2026-03');
    await chargeStandingOrder(db, standingOrderId!, '2026-04');

    const [seat] = listSeatCommitments(db, { memberId });
    expect(seat!.balanceAgorot).toBe(0);
    expect(seat!.instalmentsRemaining).toBe(0);
    expect(seat!.standingOrder?.status).toBe('completed');
    expect(seat!.nextChargeDate).toBeNull();
  });

  it('עדכון פריסה ידני משנה את מספר התשלומים ואת תאריך התשלום הראשון', async () => {
    const { commitment } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(20000),
      paymentMode: 'manual',
    });

    updateSeatPlan(db, commitment.commitmentId, {
      instalmentsCount: 25,
      firstPaymentDate: '2025-09-01',
    });

    const [updated] = listSeatCommitments(db, { memberId });
    expect(updated!.instalmentsCount).toBe(25);
    expect(updated!.instalmentAgorot).toBe(shekelsToAgorot(800));
    expect(updated!.firstPaymentDate).toBe('2025-09-01');
  });

  // -------------------------------------------------------------------------
  // סכום כולל שאינו ידוע
  //
  // אצל חלק מהחברים גובים סכום חודשי, אבל כמה סוכם בסך הכל לא רשום
  // בשום מקום. המערכת חייבת לומר "לא ידוע" ולא לנחש מספר.
  // -------------------------------------------------------------------------

  it('התחייבות ללא סכום כולל: הסכום והיתרה מוחזרים כלא ידועים', async () => {
    const { commitment } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: null,
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
      firstPaymentDate: '2026-01-10',
    });

    expect(commitment.amountConfirmed).toBe(false);
    expect(commitment.amountAgorot).toBeNull();
    expect(commitment.balanceAgorot).toBeNull();
    expect(commitment.instalmentsCount).toBeNull();
    expect(commitment.instalmentsRemaining).toBeNull();
    // ומה שכן ידוע - מוצג
    expect(commitment.instalmentAgorot).toBe(shekelsToAgorot(500));
    expect(commitment.firstPaymentDate).toBe('2026-01-10');
    expect(commitment.dayOfMonth).toBe(10);
  });

  it('בלי סכום כולל ההוראה ממשיכה לחייב ואינה "מסתיימת"', async () => {
    const { standingOrderId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: null,
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });

    for (const period of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
      await chargeStandingOrder(db, standingOrderId!, period);
    }

    const [seat] = listSeatCommitments(db, { memberId });
    expect(seat!.paidAgorot).toBe(shekelsToAgorot(2500));
    expect(seat!.instalmentsPaid).toBe(5);
    expect(seat!.balanceAgorot).toBeNull();
    // ההוראה עדיין פעילה - אין סכום שמולו אפשר לקבוע שהיא הסתיימה
    expect(seat!.standingOrder?.status).toBe('active');
    expect(seat!.nextChargeDate).not.toBeNull();
    // וכל חיוב נרשם במלואו, בלי תקרה מומצאת
    expect(seat!.standingOrder?.amountAgorot).toBe(shekelsToAgorot(500));
  });

  it('הזנת הסכום בדיעבד מחשבת יתרה נכונה מהתשלומים שכבר בוצעו', async () => {
    const { commitment, standingOrderId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: null,
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });
    await chargeStandingOrder(db, standingOrderId!, '2026-01');
    await chargeStandingOrder(db, standingOrderId!, '2026-02');

    const updated = confirmSeatAmount(db, commitment.commitmentId, shekelsToAgorot(20000), {
      instalmentsCount: 40,
    });

    expect(updated.amountConfirmed).toBe(true);
    expect(updated.amountAgorot).toBe(shekelsToAgorot(20000));
    expect(updated.paidAgorot).toBe(shekelsToAgorot(1000));
    expect(updated.balanceAgorot).toBe(shekelsToAgorot(19000));
    expect(updated.instalmentsCount).toBe(40);
    expect(updated.instalmentsRemaining).toBe(38);
    expect(updated.status).toBe('partially_paid');
  });

  it('סכום נמוך ממה שכבר שולם נדחה', async () => {
    const { commitment, standingOrderId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: null,
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });
    await chargeStandingOrder(db, standingOrderId!, '2026-01');
    await chargeStandingOrder(db, standingOrderId!, '2026-02');

    expect(() => confirmSeatAmount(db, commitment.commitmentId, shekelsToAgorot(600))).toThrow(
      /נמוך מהסכום שכבר שולם/,
    );
  });

  it('הזנת סכום שכבר שולם במלואו מסיימת את ההוראה', async () => {
    const { commitment, standingOrderId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: null,
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });
    await chargeStandingOrder(db, standingOrderId!, '2026-01');
    await chargeStandingOrder(db, standingOrderId!, '2026-02');

    const updated = confirmSeatAmount(db, commitment.commitmentId, shekelsToAgorot(1000));
    expect(updated.balanceAgorot).toBe(0);
    expect(updated.status).toBe('paid');
    expect(updated.standingOrder?.status).toBe('completed');
  });

  it('הסיכום אינו מנפח את סך ההתחייבויות בסכומים שאינם ידועים', async () => {
    const second = makeMember(db, { firstName: 'משה', lastName: 'לוי', email: 'moshe@example.com' }).id;

    await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(10000),
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });
    const unknown = await createSeatCommitment(db, {
      memberId: second,
      organizationId: orgId,
      amountAgorot: null,
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(400),
    });
    await chargeStandingOrder(db, unknown.standingOrderId!, '2026-01');

    const summary = getSeatSummary(db, {});
    expect(summary.count).toBe(2);
    // רק ההתחייבות הידועה נספרת בסכומים
    expect(summary.committedAgorot).toBe(shekelsToAgorot(10000));
    expect(summary.balanceAgorot).toBe(shekelsToAgorot(10000));
    // ומה ששולם - נספר תמיד, כי הוא ידוע
    expect(summary.paidAgorot).toBe(shekelsToAgorot(400));
    expect(summary.unknownAmountCount).toBe(1);
    expect(summary.unknownAmountPaidAgorot).toBe(shekelsToAgorot(400));
    // שתי ההוראות פעילות, ולכן שתיהן בצפי החודשי
    expect(summary.monthlyExpectedAgorot).toBe(shekelsToAgorot(900));
    expect(listSeatCommitments(db, { state: 'unknown' })).toHaveLength(1);
  });

  it('תשלום מראש ופריסה בלי סכום כלל נדחים בהודעה ברורה', async () => {
    await expect(
      createSeatCommitment(db, {
        memberId,
        organizationId: orgId,
        amountAgorot: null,
        paymentMode: 'paid_upfront',
      }),
    ).rejects.toThrow(/נדרש הסכום ששולם/);

    await expect(
      createSeatCommitment(db, {
        memberId,
        organizationId: orgId,
        amountAgorot: null,
        paymentMode: 'standing_order',
        instalmentsCount: 40,
      }),
    ).rejects.toThrow(/סכום התשלום החודשי/);
  });

  // -------------------------------------------------------------------------
  // עריכה ממסך אחד: ההתחייבות והוראת הקבע נערכות יחד
  // -------------------------------------------------------------------------

  it('עריכה משנה את הסכום החודשי ואת יום החיוב על ההוראה', async () => {
    const { commitment } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: null,
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(400),
      firstPaymentDate: '2026-01-10',
    });

    const updated = updateSeat(db, commitment.commitmentId, {
      instalmentAgorot: shekelsToAgorot(650),
      dayOfMonth: 3,
    });

    expect(updated.instalmentAgorot).toBe(shekelsToAgorot(650));
    expect(updated.dayOfMonth).toBe(3);
    expect(updated.standingOrder?.amountAgorot).toBe(shekelsToAgorot(650));
  });

  it('עריכה מזינה סכום כולל ומחשבת יתרה, ובאותה פעולה מעדכנת את החיוב', async () => {
    const { commitment, standingOrderId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: null,
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });
    await chargeStandingOrder(db, standingOrderId!, '2026-01');

    const updated = updateSeat(db, commitment.commitmentId, {
      amountAgorot: shekelsToAgorot(9000),
      instalmentsCount: 18,
      instalmentAgorot: shekelsToAgorot(500),
      dayOfMonth: 15,
    });

    expect(updated.amountAgorot).toBe(shekelsToAgorot(9000));
    expect(updated.paidAgorot).toBe(shekelsToAgorot(500));
    expect(updated.balanceAgorot).toBe(shekelsToAgorot(8500));
    expect(updated.instalmentsCount).toBe(18);
    expect(updated.dayOfMonth).toBe(15);
  });

  it('מחיקת הסכום הכולל מחזירה למצב "לא ידוע" בלי לגעת בתשלומים', async () => {
    const { commitment, standingOrderId } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(5000),
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });
    await chargeStandingOrder(db, standingOrderId!, '2026-01');

    const cleared = updateSeat(db, commitment.commitmentId, { amountAgorot: null });

    expect(cleared.amountConfirmed).toBe(false);
    expect(cleared.amountAgorot).toBeNull();
    expect(cleared.balanceAgorot).toBeNull();
    expect(cleared.instalmentsCount).toBeNull();
    // התשלום שבוצע נשאר
    expect(cleared.paidAgorot).toBe(shekelsToAgorot(500));
    expect(cleared.instalmentsPaid).toBe(1);
  });

  it('השהיית ההוראה עוצרת את החיוב הבא', async () => {
    const { commitment } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: null,
      paymentMode: 'standing_order',
      instalmentAgorot: shekelsToAgorot(500),
    });

    const paused = updateSeat(db, commitment.commitmentId, { orderStatus: 'paused' });
    expect(paused.standingOrder?.status).toBe('paused');
    expect(paused.nextChargeDate).toBeNull();

    const resumed = updateSeat(db, commitment.commitmentId, { orderStatus: 'active' });
    expect(resumed.standingOrder?.status).toBe('active');
    expect(resumed.nextChargeDate).not.toBeNull();
  });

  it('עריכת סכום חודשי להתחייבות ללא הוראת קבע נדחית בהסבר', async () => {
    const { commitment } = await createSeatCommitment(db, {
      memberId,
      organizationId: orgId,
      amountAgorot: shekelsToAgorot(5000),
      paymentMode: 'manual',
    });

    expect(() =>
      updateSeat(db, commitment.commitmentId, { instalmentAgorot: shekelsToAgorot(300) }),
    ).toThrow(/אין הוראת קבע/);
  });
});
