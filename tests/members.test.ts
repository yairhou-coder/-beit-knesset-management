/** כרטיס חבר, תזכורות ושיוך תשלומים (סעיפים 23, 24, 30). */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import { getMemberCard } from '../src/services/memberCard.js';
import { assignPaymentToMember, listPayments, recordPayment } from '../src/services/payments.js';
import { listIncomes } from '../src/services/incomes.js';
import { getCommitment } from '../src/services/commitments.js';
import {
  renderDebtReminder,
  sendDebtReminder,
  sendDebtRemindersBulk,
} from '../src/services/notifications.js';
import { createTestDb, daysAgo, makeCommitment, makeMember, makeOrganization } from './helpers.js';

describe('כרטיס חבר', () => {
  let db: Db;
  let orgId: number;
  let otherOrgId: number;
  let memberId: number;

  beforeEach(async () => {
    db = createTestDb();
    orgId = makeOrganization(db, { name: 'בית הכנסת' }).id;
    otherOrgId = makeOrganization(db, { name: 'אחוות תורה' }).id;
    memberId = makeMember(db).id;

    const aliyah = makeCommitment(db, {
      memberId,
      organizationId: orgId,
      amountShekels: 1800,
      commitmentDate: daysAgo(45),
    });
    await recordPayment(db, {
      commitmentId: aliyah.id,
      amountAgorot: shekelsToAgorot(1000),
      method: 'bank_transfer',
    });

    const donation = makeCommitment(db, {
      memberId,
      organizationId: otherOrgId,
      amountShekels: 500,
      typeKey: 'donation',
    });
    await recordPayment(db, {
      commitmentId: donation.id,
      amountAgorot: shekelsToAgorot(500),
      method: 'cash',
    });
  });

  afterEach(() => db.close());

  it('מציג את כל הקבלות שהופקו עבור החבר', () => {
    const card = getMemberCard(db, memberId);

    expect(card.receipts).toHaveLength(2);
    expect(card.totals.receiptsIssued).toBe(2);
    for (const receipt of card.receipts) {
      expect(receipt.receiptNumber).toBeTruthy();
      expect(receipt.member?.id).toBe(memberId);
    }
  });

  it('מסכם יתרות בהפרדה לפי עמותה', () => {
    const card = getMemberCard(db, memberId);

    expect(card.balancesByOrganization).toHaveLength(2);
    const synagogue = card.balancesByOrganization.find((row) => row.organization.id === orgId)!;
    expect(synagogue.committedAgorot).toBe(180_000);
    expect(synagogue.paidAgorot).toBe(100_000);
    expect(synagogue.outstandingAgorot).toBe(80_000);
    expect(synagogue.oldestDebtDays).toBeGreaterThanOrEqual(44);

    const other = card.balancesByOrganization.find((row) => row.organization.id === otherOrgId)!;
    expect(other.outstandingAgorot).toBe(0);

    expect(card.totals.outstandingAgorot).toBe(80_000);
    expect(card.totals.committedAgorot).toBe(230_000);
  });

  it('ניתן לסנן את הכרטיס לעמותה אחת', () => {
    const card = getMemberCard(db, memberId, { organizationId: orgId });
    expect(card.commitments).toHaveLength(1);
    expect(card.receipts).toHaveLength(1);
    expect(card.balancesByOrganization).toHaveLength(1);
  });

  it('כולל התחייבויות, תשלומים והכנסות', () => {
    const card = getMemberCard(db, memberId);
    expect(card.commitments).toHaveLength(2);
    expect(card.payments).toHaveLength(2);
    expect(card.incomes).toHaveLength(2);
  });
});

describe('תשלומים שלא שויכו לחבר (סעיף 30)', () => {
  let db: Db;
  let orgId: number;
  let memberId: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    memberId = makeMember(db).id;
  });

  afterEach(() => db.close());

  it('תשלום ללא חבר נרשם ומופיע ברשימת הלא-משויכים', async () => {
    await recordPayment(db, {
      organizationId: orgId,
      memberId: null,
      amountAgorot: shekelsToAgorot(360),
      method: 'bank_transfer',
      receiptRequired: false,
    });

    const unassigned = listPayments(db, { unassignedOnly: true });
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]!.unassigned).toBe(true);
    // ההכנסה נרשמת גם ללא שיוך לחבר.
    expect(listIncomes(db)).toHaveLength(1);
  });

  it('שיוך התשלום לחבר ולהתחייבות מעדכן את היתרה', async () => {
    const commitment = makeCommitment(db, {
      memberId,
      organizationId: orgId,
      amountShekels: 1000,
    });
    const payment = await recordPayment(db, {
      organizationId: orgId,
      memberId: null,
      amountAgorot: shekelsToAgorot(400),
      method: 'bank_transfer',
    });

    assignPaymentToMember(db, payment.payment.id, memberId, commitment.id);

    expect(getCommitment(db, commitment.id).balanceAgorot).toBe(60_000);
    expect(listPayments(db, { unassignedOnly: true })).toHaveLength(0);
    // ההכנסה והקבלה עודכנו גם הן.
    expect(listIncomes(db)[0]!.member?.id).toBe(memberId);
    expect(getMemberCard(db, memberId).receipts).toHaveLength(1);
  });

  it('שיוך להתחייבות של חבר אחר נדחה', async () => {
    const otherMember = makeMember(db, { firstName: 'משה', lastName: 'לוי' }).id;
    const commitment = makeCommitment(db, {
      memberId: otherMember,
      organizationId: orgId,
      amountShekels: 1000,
    });
    const payment = await recordPayment(db, {
      organizationId: orgId,
      memberId: null,
      amountAgorot: shekelsToAgorot(400),
      method: 'cash',
    });

    expect(() => assignPaymentToMember(db, payment.payment.id, memberId, commitment.id)).toThrow(
      /שייכת לחבר אחר/,
    );
  });
});

describe('תזכורות על יתרה פתוחה (סעיף 23)', () => {
  let db: Db;
  let orgId: number;
  let memberId: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
    memberId = makeMember(db).id;
  });

  afterEach(() => db.close());

  it('תבנית ההודעה כוללת את הסכום ואת שם העמותה', () => {
    const rendered = renderDebtReminder({
      memberName: 'יעקב כהן',
      organizationName: 'בית הכנסת',
      balanceAgorot: 80_000,
      commitmentCount: 1,
      oldestDebtDays: 45,
    });
    expect(rendered.subject).toContain('בית הכנסת');
    expect(rendered.body).toContain('יעקב כהן');
    expect(rendered.body).toContain('800');
    expect(rendered.body).toContain('45 ימים');
  });

  it('תזכורת נשמרת בתור עם כל הפרטים הדרושים לשליחה עתידית', async () => {
    makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 800 });

    const notification = await sendDebtReminder(db, { memberId, organizationId: orgId });

    // ללא Integration פעיל ההודעה ממתינה בתור ואינה נשלחת בפועל.
    expect(notification.status).toBe('queued');
    expect(notification.channel).toBe('email');
    expect(notification.recipient).toBe('yaakov@example.com');
    expect(notification.body).toContain('800');
    expect(notification.templateKey).toBe('debt_reminder');
  });

  it('ניתן לבחור ערוץ - WhatsApp / SMS / Email', async () => {
    makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 800 });

    const whatsapp = await sendDebtReminder(db, { memberId, organizationId: orgId, channel: 'whatsapp' });
    expect(whatsapp.channel).toBe('whatsapp');
    expect(whatsapp.recipient).toBe('050-1112233');

    const sms = await sendDebtReminder(db, { memberId, organizationId: orgId, channel: 'sms' });
    expect(sms.recipient).toBe('050-1112233');
  });

  it('חבר ללא פרטי קשר בערוץ הנבחר - ההודעה מדולגת', async () => {
    const noContact = makeMember(db, { firstName: 'דוד', lastName: 'מזרחי', email: '', phone: '' }).id;
    makeCommitment(db, { memberId: noContact, organizationId: orgId, amountShekels: 500 });

    const notification = await sendDebtReminder(db, {
      memberId: noContact,
      organizationId: orgId,
      channel: 'sms',
    });
    expect(notification.status).toBe('skipped');
    expect(notification.errorMessage).toContain('מספר טלפון');
  });

  it('חבר ללא יתרה פתוחה אינו מקבל תזכורת', async () => {
    await expect(sendDebtReminder(db, { memberId, organizationId: orgId })).rejects.toThrow(
      /אין יתרה פתוחה/,
    );
  });

  it('שליחה מרוכזת לכל החייבים בעמותה', async () => {
    const second = makeMember(db, { firstName: 'משה', lastName: 'לוי' }).id;
    makeCommitment(db, { memberId, organizationId: orgId, amountShekels: 800, commitmentDate: daysAgo(50) });
    makeCommitment(db, { memberId: second, organizationId: orgId, amountShekels: 300, commitmentDate: daysAgo(5) });

    const all = await sendDebtRemindersBulk(db, { organizationId: orgId });
    expect(all.queued).toBe(2);

    // סינון לפי גיל החוב.
    const old = await sendDebtRemindersBulk(db, { organizationId: orgId, minAgeDays: 30 });
    expect(old.queued).toBe(1);
  });
});
