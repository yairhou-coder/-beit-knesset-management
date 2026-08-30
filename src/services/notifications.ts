/**
 * תזכורות לחברים על יתרות פתוחות (סעיף 23).
 *
 * בשלב זה אין Integration אמיתי ל-WhatsApp / SMS / Email, ולכן ההודעות
 * נרשמות בתור עם כל הנתונים הדרושים. חיבור ספק אמיתי בעתיד = מימוש
 * NotificationProvider ורישומו ב-registry, ללא שינוי בקוד שלהלן.
 */

import crypto from 'node:crypto';
import type { Db } from '../db/index.js';
import { formatAgorot } from '../domain/money.js';
import {
  NOTIFICATION_CHANNELS,
  isOneOf,
  type NotificationChannel,
  type NotificationStatus,
} from '../domain/types.js';
import { resolveNotificationProvider } from '../integrations/registry.js';
import { NotFoundError, ValidationError } from './errors.js';
import { getOrganizationRow } from './organizations.js';
import { WhereBuilder } from './util.js';

export interface NotificationRow {
  id: number;
  member_id: number;
  organization_id: number | null;
  channel: NotificationChannel;
  template_key: string;
  recipient: string | null;
  subject: string | null;
  body: string;
  related_type: string | null;
  related_id: number | null;
  status: NotificationStatus;
  provider: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  attempts: number;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationView {
  id: number;
  member: { id: number; name: string };
  organizationId: number | null;
  channel: NotificationChannel;
  templateKey: string;
  recipient: string | null;
  subject: string | null;
  body: string;
  relatedType: string | null;
  relatedId: number | null;
  status: NotificationStatus;
  provider: string | null;
  errorMessage: string | null;
  attempts: number;
  sentAt: string | null;
  createdAt: string;
}

interface NotificationJoinedRow extends NotificationRow {
  member_first_name: string;
  member_last_name: string;
}

function toView(row: NotificationJoinedRow): NotificationView {
  return {
    id: row.id,
    member: {
      id: row.member_id,
      name: `${row.member_first_name} ${row.member_last_name}`.trim(),
    },
    organizationId: row.organization_id,
    channel: row.channel,
    templateKey: row.template_key,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    relatedType: row.related_type,
    relatedId: row.related_id,
    status: row.status,
    provider: row.provider,
    errorMessage: row.error_message,
    attempts: row.attempts,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

const JOINED_SELECT = `
  SELECT n.*, m.first_name AS member_first_name, m.last_name AS member_last_name
  FROM notifications n
  JOIN members m ON m.id = n.member_id
`;

export function getNotification(db: Db, id: number): NotificationView {
  const row = db.prepare(`${JOINED_SELECT} WHERE n.id = ?`).get(id) as
    | NotificationJoinedRow
    | undefined;
  if (!row) throw new NotFoundError(`תזכורת ${id}`);
  return toView(row);
}

export function listNotifications(
  db: Db,
  filters: { memberId?: number; status?: NotificationStatus; channel?: NotificationChannel; limit?: number } = {},
): NotificationView[] {
  const where = new WhereBuilder();
  where.addIf(filters.memberId, 'n.member_id = ?', filters.memberId);
  where.addIf(filters.status, 'n.status = ?', filters.status);
  where.addIf(filters.channel, 'n.channel = ?', filters.channel);
  const rows = db
    .prepare(`${JOINED_SELECT} ${where.sql} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`)
    .all(...where.values, Math.min(filters.limit ?? 200, 500)) as NotificationJoinedRow[];
  return rows.map(toView);
}

// ---------------------------------------------------------------------------
// תבניות הודעה
// ---------------------------------------------------------------------------

export interface DebtReminderContext {
  memberName: string;
  organizationName: string;
  balanceAgorot: number;
  commitmentCount: number;
  oldestDebtDays: number;
  dueDate?: string | null;
}

/** תבנית תזכורת על יתרה פתוחה. */
export function renderDebtReminder(context: DebtReminderContext): {
  subject: string;
  body: string;
} {
  const amount = formatAgorot(context.balanceAgorot);
  const subject = `תזכורת ליתרה פתוחה - ${context.organizationName}`;
  const lines = [
    `שלום ${context.memberName},`,
    '',
    `ברישומי ${context.organizationName} קיימת עבורך יתרה פתוחה בסך ${amount}` +
      (context.commitmentCount > 1 ? ` (${context.commitmentCount} התחייבויות).` : '.'),
  ];
  if (context.dueDate) {
    lines.push(`המועד האחרון לתשלום: ${context.dueDate}.`);
  } else if (context.oldestDebtDays > 0) {
    lines.push(`ההתחייבות הוותיקה ביותר פתוחה ${context.oldestDebtDays} ימים.`);
  }
  lines.push('', 'נשמח להסדרת התשלום. תודה רבה,', context.organizationName);
  return { subject, body: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// יצירה ושליחה
// ---------------------------------------------------------------------------

export interface QueueNotificationInput {
  memberId: number;
  organizationId?: number | null;
  channel?: NotificationChannel;
  templateKey: string;
  subject?: string | null;
  body: string;
  relatedType?: string | null;
  relatedId?: number | null;
  scheduledAt?: string | null;
}

interface MemberContactRow {
  id: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  preferred_channel: NotificationChannel | null;
}

function getMemberContact(db: Db, memberId: number): MemberContactRow {
  const row = db
    .prepare('SELECT id, first_name, last_name, phone, email, preferred_channel FROM members WHERE id = ?')
    .get(memberId) as MemberContactRow | undefined;
  if (!row) throw new NotFoundError(`חבר ${memberId}`);
  return row;
}

function recipientFor(member: MemberContactRow, channel: NotificationChannel): string | null {
  return channel === 'email' ? member.email : member.phone;
}

/** מוסיף הודעה לתור. ההודעה אינה נשלחת כאן. */
export function queueNotification(db: Db, input: QueueNotificationInput): NotificationView {
  const member = getMemberContact(db, input.memberId);
  const channel = input.channel ?? member.preferred_channel ?? 'email';
  if (!isOneOf(NOTIFICATION_CHANNELS, channel)) {
    throw new ValidationError(`ערוץ תקשורת לא מוכר: ${String(channel)}`);
  }

  const result = db
    .prepare(
      `INSERT INTO notifications
         (member_id, organization_id, channel, template_key, recipient, subject, body,
          related_type, related_id, status, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .run(
      input.memberId,
      input.organizationId ?? null,
      channel,
      input.templateKey,
      recipientFor(member, channel),
      input.subject ?? null,
      input.body,
      input.relatedType ?? null,
      input.relatedId ?? null,
      input.scheduledAt ?? null,
    );
  return getNotification(db, Number(result.lastInsertRowid));
}

/**
 * מנסה לשלוח הודעה שבתור דרך ה-NotificationProvider של העמותה.
 * ללא Integration אמיתי, ספק ה-Mock משאיר את ההודעה בסטטוס "בתור לשליחה".
 */
export async function sendNotification(db: Db, notificationId: number): Promise<NotificationView> {
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId) as
    | NotificationRow
    | undefined;
  if (!row) throw new NotFoundError(`תזכורת ${notificationId}`);
  if (row.status === 'sent') return getNotification(db, notificationId);

  if (!row.recipient) {
    db.prepare(
      `UPDATE notifications SET status = 'skipped', error_message = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(`לחבר אין ${row.channel === 'email' ? 'כתובת אימייל' : 'מספר טלפון'} במערכת`, notificationId);
    return getNotification(db, notificationId);
  }

  // ללא שיוך לעמותה משתמשים בעמותה הראשונה כברירת מחדל לצורך פתרון הספק.
  const orgId =
    row.organization_id ??
    (db.prepare('SELECT id FROM organizations WHERE active = 1 ORDER BY id LIMIT 1').get() as
      | { id: number }
      | undefined)?.id;
  if (orgId === undefined) throw new NotFoundError('עמותה פעילה לשליחת הודעות');

  const provider = resolveNotificationProvider(getOrganizationRow(db, orgId));

  db.prepare(
    `UPDATE notifications SET attempts = attempts + 1, provider = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(provider.key, notificationId);

  try {
    const result = await provider.send({
      idempotencyKey: `notification-${notificationId}`,
      channel: row.channel,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      reference: {
        memberId: row.member_id,
        relatedType: row.related_type,
        relatedId: row.related_id,
      },
    });

    const status: NotificationStatus =
      result.status === 'sent'
        ? 'sent'
        : result.status === 'failed'
          ? 'failed'
          : result.status === 'skipped'
            ? 'skipped'
            : 'queued';

    db.prepare(
      `UPDATE notifications SET status = ?, provider_message_id = ?, sent_at = ?,
         error_message = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      status,
      result.providerMessageId,
      result.sentAt,
      result.errorMessage ?? null,
      notificationId,
    );
  } catch (error) {
    db.prepare(
      `UPDATE notifications SET status = 'failed', error_message = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(error instanceof Error ? error.message : String(error), notificationId);
  }

  return getNotification(db, notificationId);
}

/**
 * יוצר תזכורת על יתרה פתוחה עבור חבר בעמותה מסוימת, ומנסה לשלוח אותה.
 * מסכם את כל ההתחייבויות הפתוחות של החבר באותה עמותה להודעה אחת.
 */
export async function sendDebtReminder(
  db: Db,
  input: { memberId: number; organizationId: number; channel?: NotificationChannel },
): Promise<NotificationView> {
  const member = getMemberContact(db, input.memberId);
  const org = getOrganizationRow(db, input.organizationId);

  const summary = db
    .prepare(
      `SELECT COALESCE(SUM(balance_agorot), 0) AS balance, COUNT(*) AS count,
              MIN(commitment_date) AS oldest, MIN(due_date) AS due
       FROM commitments
       WHERE member_id = ? AND organization_id = ? AND status IN ('open','partially_paid')`,
    )
    .get(input.memberId, input.organizationId) as {
    balance: number;
    count: number;
    oldest: string | null;
    due: string | null;
  };

  if (summary.balance <= 0) {
    throw new ValidationError('לחבר אין יתרה פתוחה בעמותה זו');
  }

  const { daysSince } = await import('./util.js');
  const { subject, body } = renderDebtReminder({
    memberName: `${member.first_name} ${member.last_name}`.trim(),
    organizationName: org.name,
    balanceAgorot: summary.balance,
    commitmentCount: summary.count,
    oldestDebtDays: summary.oldest ? daysSince(summary.oldest) : 0,
    dueDate: summary.due,
  });

  const notification = queueNotification(db, {
    memberId: input.memberId,
    organizationId: input.organizationId,
    channel: input.channel,
    templateKey: 'debt_reminder',
    subject,
    body,
    relatedType: 'member_balance',
    relatedId: input.memberId,
  });

  return sendNotification(db, notification.id);
}

/** תזכורות לכל החייבים בעמותה, בבת אחת. */
export async function sendDebtRemindersBulk(
  db: Db,
  input: { organizationId: number; minBalanceAgorot?: number; minAgeDays?: number; channel?: NotificationChannel },
): Promise<{ queued: number; sent: number; skipped: number; failed: number }> {
  const where = new WhereBuilder()
    .add('organization_id = ?', input.organizationId)
    .add("status IN ('open','partially_paid')");
  if (input.minAgeDays !== undefined) {
    where.add("commitment_date <= date('now', ?)", `-${Math.max(0, input.minAgeDays)} days`);
  }

  const debtors = db
    .prepare(
      `SELECT member_id, SUM(balance_agorot) AS balance
       FROM commitments ${where.sql}
       GROUP BY member_id
       HAVING balance >= ?`,
    )
    .all(...where.values, input.minBalanceAgorot ?? 1) as Array<{ member_id: number; balance: number }>;

  const totals = { queued: 0, sent: 0, skipped: 0, failed: 0 };
  for (const debtor of debtors) {
    const result = await sendDebtReminder(db, {
      memberId: debtor.member_id,
      organizationId: input.organizationId,
      ...(input.channel ? { channel: input.channel } : {}),
    });
    totals.queued += 1;
    if (result.status === 'sent') totals.sent += 1;
    else if (result.status === 'skipped') totals.skipped += 1;
    else if (result.status === 'failed') totals.failed += 1;
  }
  return totals;
}

/** מזהה ייחודי לשימוש חיצוני, למניעת שליחה כפולה של אותה תזכורת. */
export function buildNotificationKey(memberId: number, templateKey: string, period: string): string {
  return crypto
    .createHash('sha256')
    .update(`${memberId}:${templateKey}:${period}`)
    .digest('hex')
    .slice(0, 32);
}
