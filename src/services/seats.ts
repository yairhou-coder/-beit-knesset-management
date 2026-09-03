/**
 * מקומות וריהוט - התחייבות נפרדת לחלוטין מהוראת הקבע השוטפת.
 *
 * ההבדל המהותי: הוראת קבע שוטפת (דמי חבר) היא חיוב חודשי קבוע ללא סוף
 * ובלי סכום כולל. מקום/ריהוט הוא **סכום שהחבר התחייב לו** - למשל
 * 20,000 ₪ - שנפרס לתשלומים, או שולם מראש במזומן. לכן הוא נשמר
 * כהתחייבות (commitment) עם יתרה, ולא כהוראת קבע ללא סוף.
 *
 * דרכי התשלום שהמסך תומך בהן:
 *   - הוראת קבע חודשית שמקטינה את היתרה בכל חיוב
 *   - תשלום מלא מראש (מזומן, העברה, צ'ק)
 *   - תשלומים ידניים, ללא הוראת קבע
 *
 * המודול קורא את אותן טבלאות של שאר המערכת ואינו מכפיל נתונים.
 */

import type { Db } from '../db/index.js';
import { assertPositiveAgorot } from '../domain/money.js';
import type { CommitmentStatus, PaymentMethod } from '../domain/types.js';
import { createCommitment } from './commitments.js';
import { ValidationError } from './errors.js';
import { recordPayment } from './payments.js';
import { createStandingOrder } from './standingOrders.js';
import { WhereBuilder, today } from './util.js';

/** מפתח סוג ההתחייבות שמייצג מקום/ריהוט. */
export const SEAT_TYPE_KEY = 'seat';

/** איך ההתחייבות משולמת בפועל. */
export type SeatPaymentMode = 'standing_order' | 'paid_upfront' | 'manual';

export const SEAT_PAYMENT_MODE_LABELS: Record<SeatPaymentMode, string> = {
  standing_order: 'הוראת קבע',
  paid_upfront: 'שולם מראש',
  manual: 'תשלומים ידניים',
};

export interface SeatCommitmentView {
  commitmentId: number;
  member: { id: number; name: string; phone: string | null };
  organization: { id: number; name: string };

  /**
   * הסכום שהחבר התחייב לו, ו-null כשהוא אינו ידוע.
   *
   * אצל חלק מהחברים גובים סכום חודשי אבל הסכום הכולל אינו רשום בשום
   * מקום. במקרה כזה גם היתרה, מספר התשלומים והמועד הצפוי אינם ידועים,
   * וכולם מוחזרים כ-null - ולא כמספר משוער שנראה אמיתי.
   */
  amountAgorot: number | null;
  amountConfirmed: boolean;
  paidAgorot: number;
  balanceAgorot: number | null;

  /** מתי נגבה (או ייגבה) התשלום הראשון. */
  firstPaymentDate: string | null;
  /** מתי נגבה התשלום האחרון בפועל. */
  lastPaymentDate: string | null;
  /** יום החיוב בחודש, מתוך הוראת הקבע. */
  dayOfMonth: number | null;
  /** מועד החיוב הבא, כל עוד ההוראה פעילה ונותרה יתרה. */
  nextChargeDate: string | null;

  /** סכום התשלום החודשי. */
  instalmentAgorot: number | null;
  /** מספר התשלומים שסוכם. */
  instalmentsCount: number | null;
  /** כמה תשלומים כבר נגבו בפועל. */
  instalmentsPaid: number;
  /** כמה תשלומים נותרו, לפי היתרה וגובה התשלום. */
  instalmentsRemaining: number | null;

  paymentMode: SeatPaymentMode;
  paymentModeLabel: string;
  status: CommitmentStatus;
  commitmentDate: string;
  notes: string | null;

  standingOrder: {
    id: number;
    status: string;
    amountAgorot: number;
    dayOfMonth: number;
    startDate: string;
    cardLast4: string | null;
    lastChargeAt: string | null;
  } | null;
}

interface SeatJoinedRow {
  commitment_id: number;
  member_id: number;
  member_first_name: string;
  member_last_name: string;
  member_phone: string | null;
  organization_id: number;
  organization_name: string;
  amount_agorot: number;
  paid_agorot: number;
  balance_agorot: number;
  amount_confirmed: number;
  status: CommitmentStatus;
  commitment_date: string;
  instalments_count: number | null;
  first_payment_date: string | null;
  notes: string | null;

  order_id: number | null;
  order_status: string | null;
  order_amount: number | null;
  order_day: number | null;
  order_start: string | null;
  order_card_last4: string | null;
  order_last_charge: string | null;

  payments_count: number;
  first_payment_at: string | null;
  last_payment_at: string | null;
}

/**
 * ההצטרפות להוראת הקבע היא LEFT JOIN: התחייבות ששולמה מראש אינה
 * מקושרת לאף הוראה, והיא חייבת להופיע במסך בדיוק כמו כל אחת אחרת.
 *
 * ספירת התשלומים מחושבת בתת-שאילתה ולא ב-JOIN, כדי שלא תכפיל שורות.
 */
const JOINED_SELECT = `
  SELECT c.id                AS commitment_id,
         c.member_id         AS member_id,
         m.first_name        AS member_first_name,
         m.last_name         AS member_last_name,
         m.phone             AS member_phone,
         c.organization_id   AS organization_id,
         o.name              AS organization_name,
         c.amount_agorot     AS amount_agorot,
         c.paid_agorot       AS paid_agorot,
         c.balance_agorot    AS balance_agorot,
         c.amount_confirmed  AS amount_confirmed,
         c.status            AS status,
         c.commitment_date   AS commitment_date,
         c.instalments_count AS instalments_count,
         c.first_payment_date AS first_payment_date,
         c.notes             AS notes,
         s.id                AS order_id,
         s.status            AS order_status,
         s.amount_agorot     AS order_amount,
         s.day_of_month      AS order_day,
         s.start_date        AS order_start,
         s.card_last4        AS order_card_last4,
         s.last_charge_at    AS order_last_charge,
         (SELECT COUNT(*)         FROM payments p
           WHERE p.commitment_id = c.id AND p.status = 'completed')  AS payments_count,
         (SELECT MIN(payment_date) FROM payments p
           WHERE p.commitment_id = c.id AND p.status = 'completed')  AS first_payment_at,
         (SELECT MAX(payment_date) FROM payments p
           WHERE p.commitment_id = c.id AND p.status = 'completed')  AS last_payment_at
    FROM commitments c
    JOIN members m            ON m.id = c.member_id
    JOIN organizations o      ON o.id = c.organization_id
    JOIN commitment_types t   ON t.id = c.commitment_type_id
    LEFT JOIN standing_orders s ON s.commitment_id = c.id
`;

/** התאריך הבא שבו ייגבה יום החיוב, החל מהיום. */
function nextOccurrence(dayOfMonth: number, reference: string = today()): string {
  const day = String(Math.min(28, Math.max(1, dayOfMonth))).padStart(2, '0');
  const thisMonth = `${reference.slice(0, 7)}-${day}`;
  if (thisMonth >= reference) return thisMonth;
  const next = new Date(`${reference.slice(0, 7)}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return `${next.toISOString().slice(0, 7)}-${day}`;
}

function toView(row: SeatJoinedRow): SeatCommitmentView {
  const confirmed = row.amount_confirmed === 1;
  const amountAgorot = confirmed ? row.amount_agorot : null;
  const balanceAgorot = confirmed ? row.balance_agorot : null;

  // התשלום החודשי ידוע גם בלי הסכום הכולל - הוא מגיע מהוראת הקבע.
  const instalmentAgorot =
    row.order_amount ??
    (confirmed && row.instalments_count
      ? Math.round(row.amount_agorot / row.instalments_count)
      : null);

  // מספר התשלומים והמועד הצפוי נגזרים מהסכום הכולל, ולכן בלעדיו
  // הם אינם ידועים. עדיף לומר "לא ידוע" מאשר לנחש.
  const instalmentsCount = !confirmed
    ? null
    : (row.instalments_count ??
      (instalmentAgorot && instalmentAgorot > 0
        ? Math.ceil(row.amount_agorot / instalmentAgorot)
        : null));

  const instalmentsRemaining = !confirmed
    ? null
    : balanceAgorot !== null && balanceAgorot <= 0
      ? 0
      : instalmentAgorot && instalmentAgorot > 0 && balanceAgorot !== null
        ? Math.ceil(balanceAgorot / instalmentAgorot)
        : null;

  const paymentMode: SeatPaymentMode = row.order_id
    ? 'standing_order'
    : confirmed && row.balance_agorot <= 0
      ? 'paid_upfront'
      : 'manual';

  const nextChargeDate =
    row.order_id &&
    row.order_status === 'active' &&
    (!confirmed || row.balance_agorot > 0) &&
    row.order_day
      ? nextOccurrence(row.order_day)
      : null;

  return {
    commitmentId: row.commitment_id,
    member: {
      id: row.member_id,
      name: `${row.member_first_name} ${row.member_last_name}`.trim(),
      phone: row.member_phone,
    },
    organization: { id: row.organization_id, name: row.organization_name },
    amountAgorot,
    amountConfirmed: confirmed,
    paidAgorot: row.paid_agorot,
    balanceAgorot,
    firstPaymentDate: row.first_payment_date ?? row.first_payment_at ?? row.order_start,
    lastPaymentDate: row.last_payment_at,
    dayOfMonth: row.order_day,
    nextChargeDate,
    instalmentAgorot,
    instalmentsCount,
    instalmentsPaid: row.payments_count,
    instalmentsRemaining,
    paymentMode,
    paymentModeLabel: SEAT_PAYMENT_MODE_LABELS[paymentMode],
    status: row.status,
    commitmentDate: row.commitment_date,
    notes: row.notes,
    standingOrder: row.order_id
      ? {
          id: row.order_id,
          status: row.order_status!,
          amountAgorot: row.order_amount!,
          dayOfMonth: row.order_day!,
          startDate: row.order_start!,
          cardLast4: row.order_card_last4,
          lastChargeAt: row.order_last_charge,
        }
      : null,
  };
}

export interface SeatFilters {
  memberId?: number;
  memberSearch?: string;
  organizationId?: number;
  /**
   * outstanding = נותרה יתרה · paid = סיים לשלם ·
   * unknown = הסכום הכולל טרם הוזן, ולכן לא ידוע אם נשארה יתרה.
   */
  state?: 'outstanding' | 'paid' | 'unknown' | 'all';
  paymentMode?: SeatPaymentMode;
}

export function listSeatCommitments(db: Db, filters: SeatFilters = {}): SeatCommitmentView[] {
  const where = new WhereBuilder();
  where.add('t.key = ?', SEAT_TYPE_KEY);
  where.addIf(filters.memberId, 'c.member_id = ?', filters.memberId);
  where.addIf(filters.organizationId, 'c.organization_id = ?', filters.organizationId);
  if (filters.memberSearch) {
    const term = `%${filters.memberSearch.trim()}%`;
    where.add("(m.first_name || ' ' || m.last_name LIKE ? OR m.phone LIKE ?)", term, term);
  }
  if (filters.state === 'outstanding') {
    where.add("c.amount_confirmed = 1 AND c.balance_agorot > 0 AND c.status != 'cancelled'");
  } else if (filters.state === 'paid') {
    where.add('c.amount_confirmed = 1 AND c.balance_agorot <= 0');
  } else if (filters.state === 'unknown') {
    where.add('c.amount_confirmed = 0');
  }

  const rows = db
    .prepare(`${JOINED_SELECT} ${where.sql} ORDER BY m.last_name, m.first_name`)
    .all(...where.values) as SeatJoinedRow[];

  const views = rows.map(toView);
  return filters.paymentMode
    ? views.filter((view) => view.paymentMode === filters.paymentMode)
    : views;
}

export interface SeatSummary {
  count: number;
  /**
   * הסכומים נספרים רק על התחייבויות שסכומן ידוע. מי שסכומו טרם הוזן
   * נספר ב-unknownAmountCount בלבד, כדי שסך ההתחייבויות לא יתנפח
   * ממספרים משוערים.
   */
  committedAgorot: number;
  paidAgorot: number;
  balanceAgorot: number;
  /** כמה התחייבויות עדיין ללא סכום כולל ידוע. */
  unknownAmountCount: number;
  /** כמה שולם עד היום על אותן התחייבויות - זה כן ידוע. */
  unknownAmountPaidAgorot: number;
  /** כמה סיימו לשלם, כמה באמצע, וכמה טרם התחילו. */
  settledCount: number;
  inProgressCount: number;
  notStartedCount: number;
  /** כמה אמור להיגבות כל חודש מהוראות הקבע הפעילות של המקומות. */
  monthlyExpectedAgorot: number;
  byMode: Array<{
    mode: SeatPaymentMode;
    label: string;
    count: number;
    /** היתרה של מי שסכומו ידוע בלבד. */
    balanceAgorot: number;
    /** כמה מתוך הקבוצה עדיין ללא סכום כולל. */
    unknownAmountCount: number;
  }>;
}

export function getSeatSummary(db: Db, filters: SeatFilters = {}): SeatSummary {
  const items = listSeatCommitments(db, { ...filters, state: 'all' });
  const known = items.filter((item) => item.amountConfirmed);
  const unknown = items.filter((item) => !item.amountConfirmed);

  const byMode = (['standing_order', 'paid_upfront', 'manual'] as const).map((mode) => {
    const group = items.filter((item) => item.paymentMode === mode);
    return {
      mode,
      label: SEAT_PAYMENT_MODE_LABELS[mode],
      count: group.length,
      balanceAgorot: group.reduce((sum, item) => sum + (item.balanceAgorot ?? 0), 0),
      unknownAmountCount: group.filter((item) => !item.amountConfirmed).length,
    };
  });

  return {
    count: items.length,
    committedAgorot: known.reduce((sum, item) => sum + (item.amountAgorot ?? 0), 0),
    paidAgorot: items.reduce((sum, item) => sum + item.paidAgorot, 0),
    balanceAgorot: known.reduce((sum, item) => sum + (item.balanceAgorot ?? 0), 0),
    unknownAmountCount: unknown.length,
    unknownAmountPaidAgorot: unknown.reduce((sum, item) => sum + item.paidAgorot, 0),
    settledCount: known.filter((item) => (item.balanceAgorot ?? 0) <= 0).length,
    inProgressCount: items.filter(
      (item) => item.paidAgorot > 0 && (!item.amountConfirmed || (item.balanceAgorot ?? 0) > 0),
    ).length,
    notStartedCount: items.filter((item) => item.paidAgorot === 0).length,
    monthlyExpectedAgorot: items
      .filter(
        (item) =>
          item.standingOrder?.status === 'active' &&
          (!item.amountConfirmed || (item.balanceAgorot ?? 0) > 0),
      )
      .reduce((sum, item) => sum + (item.standingOrder?.amountAgorot ?? 0), 0),
    byMode,
  };
}

// ---------------------------------------------------------------------------
// יצירת התחייבות מקום/ריהוט
// ---------------------------------------------------------------------------

export interface SeatCommitmentInput {
  memberId: number;
  organizationId: number;
  /**
   * הסכום הכולל שהחבר התחייב לו. null כאשר הוא אינו ידוע - אז נרשמים
   * רק התשלום החודשי והמועדים, והסכום יוזן מאוחר יותר.
   */
  amountAgorot: number | null;
  commitmentDate?: string;
  notes?: string | null;

  /**
   * אופן התשלום:
   *   standing_order - נפרס לתשלומים חודשיים בהוראת קבע
   *   paid_upfront   - שולם במלואו מראש, ונרשם תשלום יחיד
   *   manual         - ההתחייבות נרשמת, והתשלומים ייכנסו ידנית
   */
  paymentMode: SeatPaymentMode;

  /** לפריסה לתשלומים: מספר התשלומים, או סכום התשלום החודשי. */
  instalmentsCount?: number | null;
  instalmentAgorot?: number | null;
  dayOfMonth?: number;
  firstPaymentDate?: string | null;

  /** לתשלום מראש: אמצעי התשלום ותאריכו. */
  paidMethod?: PaymentMethod;
  paidDate?: string;
}

export interface SeatCommitmentResult {
  commitment: SeatCommitmentView;
  standingOrderId: number | null;
  paymentId: number | null;
}

export async function createSeatCommitment(
  db: Db,
  input: SeatCommitmentInput,
): Promise<SeatCommitmentResult> {
  const amountKnown = input.amountAgorot !== null && input.amountAgorot !== undefined;
  if (amountKnown) {
    assertPositiveAgorot(input.amountAgorot, 'סכום ההתחייבות');
  } else if (input.paymentMode === 'paid_upfront') {
    throw new ValidationError('לתשלום מראש נדרש הסכום ששולם');
  } else if (input.paymentMode === 'standing_order' && !input.instalmentAgorot) {
    throw new ValidationError('כשהסכום הכולל אינו ידוע, יש לציין את סכום התשלום החודשי');
  }

  const typeRow = db
    .prepare('SELECT id FROM commitment_types WHERE key = ?')
    .get(SEAT_TYPE_KEY) as { id: number } | undefined;
  if (!typeRow) throw new ValidationError('סוג ההתחייבות "מקום וריהוט" אינו מוגדר במערכת');

  const commitmentDate = input.commitmentDate ?? today();

  // פריסה לתשלומים: אפשר לציין מספר תשלומים, סכום חודשי, או שניהם.
  let instalmentsCount = input.instalmentsCount ?? null;
  let instalmentAgorot = input.instalmentAgorot ?? null;

  if (input.paymentMode === 'standing_order') {
    if (!instalmentsCount && !instalmentAgorot) {
      throw new ValidationError('לפריסה לתשלומים נדרש מספר התשלומים או הסכום החודשי');
    }
    if (!instalmentAgorot) {
      instalmentAgorot = Math.round(input.amountAgorot! / instalmentsCount!);
    }
    if (instalmentAgorot <= 0) {
      throw new ValidationError('הסכום החודשי חייב להיות גדול מאפס');
    }
    if (!instalmentsCount && amountKnown) {
      instalmentsCount = Math.ceil(input.amountAgorot! / instalmentAgorot);
    }
  }
  // בלי סכום כולל אין מספר תשלומים - הוא ייגזר כשהסכום יוזן.
  if (!amountKnown) instalmentsCount = null;

  const firstPaymentDate =
    input.firstPaymentDate ??
    (input.paymentMode === 'paid_upfront' ? (input.paidDate ?? commitmentDate) : commitmentDate);

  const commitment = createCommitment(db, {
    memberId: input.memberId,
    organizationId: input.organizationId,
    commitmentTypeId: typeRow.id,
    // בלי סכום ידוע נרשם ערך זמני של אגורה אחת; הוא מסומן כלא-מאושר,
    // מוצג כ"לא ידוע", ומתעדכן לסך ששולם עם כל תשלום.
    amountAgorot: amountKnown ? input.amountAgorot! : 1,
    commitmentDate,
    plannedPaymentMethod:
      input.paymentMode === 'standing_order' ? 'standing_order' : (input.paidMethod ?? null),
    notes: input.notes ?? null,
  });

  db.prepare(
    `UPDATE commitments SET instalments_count = ?, first_payment_date = ?,
       amount_confirmed = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(instalmentsCount, firstPaymentDate, amountKnown ? 1 : 0, commitment.id);

  let standingOrderId: number | null = null;
  let paymentId: number | null = null;

  if (input.paymentMode === 'standing_order') {
    const order = createStandingOrder(db, {
      memberId: input.memberId,
      organizationId: input.organizationId,
      commitmentTypeId: typeRow.id,
      commitmentId: commitment.id,
      amountAgorot: instalmentAgorot!,
      dayOfMonth: input.dayOfMonth ?? (Number(firstPaymentDate.slice(8, 10)) || 1),
      method: 'standing_order',
      startDate: firstPaymentDate,
      notes: `מקום/ריהוט · ${instalmentsCount} תשלומים`,
    });
    standingOrderId = order.id;
  } else if (input.paymentMode === 'paid_upfront') {
    const result = await recordPayment(db, {
      commitmentId: commitment.id,
      amountAgorot: input.amountAgorot!,
      paymentDate: input.paidDate ?? commitmentDate,
      method: input.paidMethod ?? 'cash',
      description: 'מקום/ריהוט - שולם מראש',
    });
    paymentId = result.payment.id;
  }

  const [view] = listSeatCommitments(db, { memberId: input.memberId, state: 'all' }).filter(
    (item) => item.commitmentId === commitment.id,
  );
  if (!view) throw new ValidationError('ההתחייבות נוצרה אך לא נמצאה במסך המקומות');
  return { commitment: view, standingOrderId, paymentId };
}

/**
 * הזנת הסכום הכולל שסוכם עם החבר, כשהוא נודע.
 *
 * מרגע זה יש להתחייבות יתרה אמיתית: ההוראה תפסיק לחייב כשההתחייבות
 * תסולק, וכל המסכים יציגו כמה נותר. הסכום חייב להיות לפחות כמה שכבר
 * שולם - אחרת היינו רושמים חוב שלילי.
 */
export function confirmSeatAmount(
  db: Db,
  commitmentId: number,
  amountAgorot: number,
  options: { instalmentsCount?: number | null } = {},
): SeatCommitmentView {
  assertPositiveAgorot(amountAgorot, 'סכום ההתחייבות');

  const row = db
    .prepare('SELECT paid_agorot, member_id FROM commitments WHERE id = ?')
    .get(commitmentId) as { paid_agorot: number; member_id: number } | undefined;
  if (!row) throw new ValidationError(`התחייבות ${commitmentId} לא נמצאה`);

  if (amountAgorot < row.paid_agorot) {
    throw new ValidationError(
      `הסכום שהוזן (${amountAgorot / 100} ₪) נמוך מהסכום שכבר שולם (${row.paid_agorot / 100} ₪)`,
    );
  }

  const status = amountAgorot === row.paid_agorot ? 'paid' : row.paid_agorot > 0 ? 'partially_paid' : 'open';
  db.prepare(
    `UPDATE commitments SET amount_agorot = ?, amount_confirmed = 1, instalments_count = ?,
       status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(amountAgorot, options.instalmentsCount ?? null, status, commitmentId);

  // הוראה שההתחייבות שלה סולקה בדיוק עכשיו מסתיימת
  if (amountAgorot === row.paid_agorot) {
    db.prepare(
      `UPDATE standing_orders SET status = 'completed', updated_at = datetime('now')
        WHERE commitment_id = ? AND status = 'active'`,
    ).run(commitmentId);
  }

  const [view] = listSeatCommitments(db, { memberId: row.member_id, state: 'all' }).filter(
    (item) => item.commitmentId === commitmentId,
  );
  if (!view) throw new ValidationError('ההתחייבות לא נמצאה לאחר העדכון');
  return view;
}

/** עדכון פרטי הפריסה של התחייבות קיימת. */
export function updateSeatPlan(
  db: Db,
  commitmentId: number,
  patch: { instalmentsCount?: number | null; firstPaymentDate?: string | null },
): void {
  if (patch.instalmentsCount !== undefined) {
    if (patch.instalmentsCount !== null && patch.instalmentsCount <= 0) {
      throw new ValidationError('מספר התשלומים חייב להיות גדול מאפס');
    }
    db.prepare(
      `UPDATE commitments SET instalments_count = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(patch.instalmentsCount, commitmentId);
  }
  if (patch.firstPaymentDate !== undefined) {
    db.prepare(
      `UPDATE commitments SET first_payment_date = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(patch.firstPaymentDate, commitmentId);
  }
}
