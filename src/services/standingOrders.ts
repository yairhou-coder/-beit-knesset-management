/**
 * הוראות קבע (סעיף 25 - משויכות לעמותה, סעיף 26 - דרך PaymentProvider).
 *
 * חיוב הוראת קבע מייצר תשלום רגיל דרך recordPayment, ולכן הוא מקבל
 * את אותו טיפול: רישום הכנסה, הפקת קבלה ועמידות בפני כשלים.
 */

import type { Db } from '../db/index.js';
import { assertPositiveAgorot } from '../domain/money.js';
import type { PaymentMethod, StandingOrderStatus } from '../domain/types.js';
import { resolvePaymentProvider } from '../integrations/registry.js';
import { raiseAlert } from './alerts.js';
import { NotFoundError, ValidationError } from './errors.js';
import { getOrganizationRow } from './organizations.js';
import { recordPayment, type RecordPaymentResult } from './payments.js';
import { WhereBuilder, today } from './util.js';

export interface StandingOrderRow {
  id: number;
  member_id: number;
  organization_id: number;
  commitment_type_id: number | null;
  amount_agorot: number;
  day_of_month: number;
  method: PaymentMethod;
  status: StandingOrderStatus;
  start_date: string;
  end_date: string | null;
  provider: string | null;
  provider_subscription_id: string | null;
  card_last4: string | null;
  card_expiry: string | null;
  last_charge_at: string | null;
  last_failure_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface StandingOrderView {
  id: number;
  member: { id: number; name: string };
  organization: { id: number; name: string };
  amountAgorot: number;
  dayOfMonth: number;
  method: PaymentMethod;
  status: StandingOrderStatus;
  startDate: string;
  endDate: string | null;
  provider: string | null;
  providerSubscriptionId: string | null;
  cardLast4: string | null;
  cardExpiry: string | null;
  lastChargeAt: string | null;
  lastFailureReason: string | null;
  notes: string | null;
}

interface StandingOrderJoinedRow extends StandingOrderRow {
  member_first_name: string;
  member_last_name: string;
  organization_name: string;
}

const JOINED_SELECT = `
  SELECT s.*, m.first_name AS member_first_name, m.last_name AS member_last_name,
         o.name AS organization_name
  FROM standing_orders s
  JOIN members m ON m.id = s.member_id
  JOIN organizations o ON o.id = s.organization_id
`;

function toView(row: StandingOrderJoinedRow): StandingOrderView {
  return {
    id: row.id,
    member: {
      id: row.member_id,
      name: `${row.member_first_name} ${row.member_last_name}`.trim(),
    },
    organization: { id: row.organization_id, name: row.organization_name },
    amountAgorot: row.amount_agorot,
    dayOfMonth: row.day_of_month,
    method: row.method,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    provider: row.provider,
    providerSubscriptionId: row.provider_subscription_id,
    cardLast4: row.card_last4,
    cardExpiry: row.card_expiry,
    lastChargeAt: row.last_charge_at,
    lastFailureReason: row.last_failure_reason,
    notes: row.notes,
  };
}

export function listStandingOrders(
  db: Db,
  filters: { memberId?: number; organizationId?: number; status?: StandingOrderStatus } = {},
): StandingOrderView[] {
  const where = new WhereBuilder();
  where.addIf(filters.memberId, 's.member_id = ?', filters.memberId);
  where.addIf(filters.organizationId, 's.organization_id = ?', filters.organizationId);
  where.addIf(filters.status, 's.status = ?', filters.status);
  const rows = db
    .prepare(`${JOINED_SELECT} ${where.sql} ORDER BY s.status, m.last_name`)
    .all(...where.values) as StandingOrderJoinedRow[];
  return rows.map(toView);
}

export function getStandingOrder(db: Db, id: number): StandingOrderView {
  const row = db.prepare(`${JOINED_SELECT} WHERE s.id = ?`).get(id) as
    | StandingOrderJoinedRow
    | undefined;
  if (!row) throw new NotFoundError(`הוראת קבע ${id}`);
  return toView(row);
}

export function getStandingOrderRow(db: Db, id: number): StandingOrderRow {
  const row = db.prepare('SELECT * FROM standing_orders WHERE id = ?').get(id) as
    | StandingOrderRow
    | undefined;
  if (!row) throw new NotFoundError(`הוראת קבע ${id}`);
  return row;
}

export interface StandingOrderInput {
  memberId: number;
  organizationId: number;
  commitmentTypeId?: number | null;
  amountAgorot: number;
  dayOfMonth?: number;
  method?: PaymentMethod;
  startDate?: string;
  endDate?: string | null;
  notes?: string | null;
}

export function createStandingOrder(db: Db, input: StandingOrderInput): StandingOrderView {
  assertPositiveAgorot(input.amountAgorot, 'סכום הוראת הקבע');
  const dayOfMonth = input.dayOfMonth ?? 1;
  if (dayOfMonth < 1 || dayOfMonth > 28) {
    throw new ValidationError('יום החיוב חייב להיות בין 1 ל-28');
  }
  const result = db
    .prepare(
      `INSERT INTO standing_orders
         (member_id, organization_id, commitment_type_id, amount_agorot, day_of_month,
          method, start_date, end_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.memberId,
      input.organizationId,
      input.commitmentTypeId ?? null,
      input.amountAgorot,
      dayOfMonth,
      input.method ?? 'credit_card',
      input.startDate ?? today(),
      input.endDate ?? null,
      input.notes ?? null,
    );
  return getStandingOrder(db, Number(result.lastInsertRowid));
}

/** רושם את הוראת הקבע אצל ספק הסליקה. */
export async function registerWithProvider(db: Db, id: number): Promise<StandingOrderView> {
  const order = getStandingOrderRow(db, id);
  const org = getOrganizationRow(db, order.organization_id);
  const provider = resolvePaymentProvider(org);
  if (!provider.supportsSubscriptions) {
    throw new ValidationError(`ספק הסליקה ${provider.displayName} אינו תומך בהוראות קבע`);
  }

  const member = db
    .prepare('SELECT first_name, last_name, email, phone FROM members WHERE id = ?')
    .get(order.member_id) as
    | { first_name: string; last_name: string; email: string | null; phone: string | null }
    | undefined;
  if (!member) throw new NotFoundError(`חבר ${order.member_id}`);

  const result = await provider.createSubscription({
    idempotencyKey: `standing-order-${id}`,
    amountAgorot: order.amount_agorot,
    currency: 'ILS',
    dayOfMonth: order.day_of_month,
    description: `הוראת קבע - ${org.name}`,
    customer: {
      memberId: order.member_id,
      name: `${member.first_name} ${member.last_name}`.trim(),
      email: member.email,
      phone: member.phone,
    },
    reference: { organizationId: order.organization_id, memberId: order.member_id },
  });

  db.prepare(
    `UPDATE standing_orders SET provider = ?, provider_subscription_id = ?, status = ?,
       card_last4 = ?, card_expiry = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    provider.key,
    result.providerSubscriptionId,
    result.status,
    result.cardLast4 ?? null,
    result.cardExpiry ?? null,
    id,
  );
  return getStandingOrder(db, id);
}

/**
 * מבצע חיוב חודשי של הוראת קבע.
 * `period` (YYYY-MM) הוא חלק ממפתח ה-idempotency, כדי שהרצה כפולה של
 * תהליך החיוב באותו חודש לא תיצור שני תשלומים.
 */
export async function chargeStandingOrder(
  db: Db,
  id: number,
  period: string = today().slice(0, 7),
): Promise<RecordPaymentResult> {
  const order = getStandingOrderRow(db, id);
  if (order.status !== 'active') {
    throw new ValidationError(`לא ניתן לחייב הוראת קבע בסטטוס "${order.status}"`);
  }

  const org = getOrganizationRow(db, order.organization_id);
  const provider = resolvePaymentProvider(org);
  const member = db
    .prepare('SELECT first_name, last_name, email, phone FROM members WHERE id = ?')
    .get(order.member_id) as
    | { first_name: string; last_name: string; email: string | null; phone: string | null }
    | undefined;
  if (!member) throw new NotFoundError(`חבר ${order.member_id}`);

  const idempotencyKey = `standing-order-${id}-${period}`;
  let providerPaymentId: string | null = null;
  let failureReason: string | null = null;
  let succeeded = false;

  try {
    const charge = await provider.charge({
      idempotencyKey,
      amountAgorot: order.amount_agorot,
      currency: 'ILS',
      description: `הוראת קבע ${period} - ${org.name}`,
      customer: {
        memberId: order.member_id,
        name: `${member.first_name} ${member.last_name}`.trim(),
        email: member.email,
        phone: member.phone,
      },
      reference: { organizationId: order.organization_id, memberId: order.member_id },
    });
    providerPaymentId = charge.providerPaymentId;
    succeeded = charge.status === 'succeeded';
    failureReason = charge.failureReason ?? null;
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  }

  const result = await recordPayment(db, {
    organizationId: order.organization_id,
    memberId: order.member_id,
    standingOrderId: id,
    amountAgorot: order.amount_agorot,
    paymentDate: today(),
    method: order.method,
    status: succeeded ? 'completed' : 'failed',
    idempotencyKey,
    provider: provider.key,
    providerReference: providerPaymentId,
    failureReason,
    description: `הוראת קבע ${period}`,
  });

  if (succeeded) {
    db.prepare(
      `UPDATE standing_orders SET last_charge_at = datetime('now'), last_failure_reason = NULL,
         status = 'active', updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
  } else {
    db.prepare(
      `UPDATE standing_orders SET last_failure_reason = ?, status = 'failed',
         updated_at = datetime('now') WHERE id = ?`,
    ).run(failureReason, id);
    raiseAlert(db, {
      severity: 'warning',
      kind: 'standing_order_failed',
      title: `חיוב הוראת קבע נכשל - ${member.first_name} ${member.last_name}`,
      message: failureReason ?? 'החיוב נכשל',
      organizationId: order.organization_id,
      relatedType: 'standing_order',
      relatedId: id,
    });
  }

  return result;
}

export async function cancelStandingOrder(
  db: Db,
  id: number,
  reason?: string,
): Promise<StandingOrderView> {
  const order = getStandingOrderRow(db, id);
  if (order.provider_subscription_id) {
    const provider = resolvePaymentProvider(getOrganizationRow(db, order.organization_id));
    try {
      await provider.cancelSubscription(order.provider_subscription_id, reason);
    } catch (error) {
      raiseAlert(db, {
        severity: 'error',
        kind: 'standing_order_cancel_failed',
        title: `ביטול הוראת קבע אצל הספק נכשל (הוראה ${id})`,
        message: error instanceof Error ? error.message : String(error),
        organizationId: order.organization_id,
        relatedType: 'standing_order',
        relatedId: id,
      });
    }
  }
  db.prepare(
    `UPDATE standing_orders SET status = 'cancelled', last_failure_reason = ?,
       updated_at = datetime('now') WHERE id = ?`,
  ).run(reason ?? null, id);
  return getStandingOrder(db, id);
}

export function setStandingOrderStatus(
  db: Db,
  id: number,
  status: StandingOrderStatus,
  reason?: string,
): StandingOrderView {
  getStandingOrderRow(db, id);
  db.prepare(
    `UPDATE standing_orders SET status = ?, last_failure_reason = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(status, reason ?? null, id);
  return getStandingOrder(db, id);
}
