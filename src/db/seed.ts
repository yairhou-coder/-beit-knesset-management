/**
 * נתוני דוגמה להרצה מקומית.
 * מייצר את שתי העמותות, חברים, אירועים, התחייבויות ותשלומים,
 * כולל התרחיש מסעיף 27 (עלייה ב-1,800 ₪ עם תשלום חלקי).
 */

import { openDatabase, type Db } from './index.js';
import { shekelsToAgorot } from '../domain/money.js';
import { createOrganization, listOrganizations } from '../services/organizations.js';
import { createMember } from '../services/members.js';
import { createEvent, listCommitmentTypes } from '../services/catalog.js';
import { createCommitment } from '../services/commitments.js';
import { recordPayment } from '../services/payments.js';
import { createStandingOrder, chargeStandingOrder } from '../services/standingOrders.js';

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export async function seed(db: Db): Promise<void> {
  if (listOrganizations(db).length > 0) {
    // eslint-disable-next-line no-console
    console.log('נתוני דוגמה כבר קיימים - מדלג.');
    return;
  }

  // --- עמותות (סעיף 25) -----------------------------------------------------
  const synagogue = createOrganization(db, {
    name: 'בית המדרש אנשי מעשה',
    shortName: 'אנשי מעשה',
    legalNumber: '580123456',
    address: 'רחוב הרב קוק 12',
    phone: '02-5551234',
    email: 'gabai@anshei-maase.example',
    bankName: 'בנק הפועלים',
    bankBranch: '123',
    bankAccount: '456789',
    accountHolder: 'עמותת בית המדרש אנשי מעשה',
    allowedDocumentTypes: ['receipt', 'donation_receipt'],
    defaultDocumentType: 'receipt',
    receiptIssueMode: 'automatic',
    receiptConfig: { numberPrefix: 'BK-', startingNumber: 12501 },
  });

  const achvatTorah = createOrganization(db, {
    name: 'אחוות תורה',
    shortName: 'אחוות תורה',
    legalNumber: '580987654',
    address: 'רחוב הרב קוק 12',
    email: 'office@achvat-torah.example',
    bankName: 'בנק לאומי',
    bankBranch: '900',
    bankAccount: '112233',
    accountHolder: 'עמותת אחוות תורה',
    allowedDocumentTypes: ['receipt', 'donation_receipt', 'tax_deductible_receipt'],
    defaultDocumentType: 'donation_receipt',
    // סעיף 29: עמותה זו מפיקה קבלות רק לאחר אישור גזבר.
    receiptIssueMode: 'manual_approval',
    receiptConfig: { numberPrefix: 'AT-', startingNumber: 5001 },
  });

  // --- חברי קהילה -----------------------------------------------------------
  const members = [
    { firstName: 'יעקב', lastName: 'כהן', hebrewName: 'יעקב בן יצחק', phone: '050-1112233', email: 'yaakov@example.com', preferredChannel: 'whatsapp' as const },
    { firstName: 'משה', lastName: 'לוי', hebrewName: 'משה בן אהרן', phone: '052-2223344', email: 'moshe@example.com', preferredChannel: 'sms' as const },
    { firstName: 'דוד', lastName: 'מזרחי', hebrewName: 'דוד בן שלמה', phone: '054-3334455', email: 'david@example.com', preferredChannel: 'email' as const },
    { firstName: 'אברהם', lastName: 'פרידמן', hebrewName: 'אברהם בן מנחם', phone: '053-4445566', email: 'avraham@example.com', preferredChannel: 'whatsapp' as const },
    { firstName: 'שמואל', lastName: 'רוזנברג', hebrewName: 'שמואל בן חיים', phone: '058-5556677', email: 'shmuel@example.com', preferredChannel: 'email' as const },
  ].map((member) => createMember(db, member));

  // --- אירועים / שבתות / חגים ------------------------------------------------
  const shabbatVayera = createEvent(db, {
    name: 'שבת וירא',
    kind: 'shabbat',
    hebrewDate: 'י"ח בחשוון',
    gregorianDate: daysAgo(75),
    organizationId: synagogue.id,
  });
  const yomKippur = createEvent(db, {
    name: 'יום כיפור',
    kind: 'holiday',
    hebrewDate: 'י׳ בתשרי',
    gregorianDate: daysAgo(45),
    organizationId: synagogue.id,
  });
  const dinner = createEvent(db, {
    name: 'דינר שנתי',
    kind: 'event',
    gregorianDate: daysAgo(20),
    organizationId: achvatTorah.id,
  });

  const types = listCommitmentTypes(db);
  const typeId = (key: string): number => types.find((type) => type.key === key)!.id;

  // --- התרחיש מסעיף 27: עלייה ב-1,800 ₪ ------------------------------------
  const aliyah = createCommitment(db, {
    memberId: members[0]!.id,
    organizationId: synagogue.id,
    commitmentTypeId: typeId('aliyah'),
    eventId: yomKippur.id,
    amountAgorot: shekelsToAgorot(1800),
    commitmentDate: daysAgo(45),
    dueDate: daysAgo(15),
    plannedPaymentMethod: 'bank_transfer',
    notes: 'עליית מפטיר יונה',
  });

  // שלב 2: תשלום חלקי של 1,000 ₪ -> יתרה 800 ₪, נרשמת הכנסה ומופקת קבלה.
  await recordPayment(db, {
    commitmentId: aliyah.id,
    amountAgorot: shekelsToAgorot(1000),
    paymentDate: daysAgo(30),
    method: 'bank_transfer',
    description: 'תשלום חלקי עבור עלייה לתורה',
  });

  // --- התחייבויות נוספות במצבים שונים ---------------------------------------
  const shabbatAliyah = createCommitment(db, {
    memberId: members[1]!.id,
    organizationId: synagogue.id,
    commitmentTypeId: typeId('aliyah'),
    eventId: shabbatVayera.id,
    amountAgorot: shekelsToAgorot(540),
    commitmentDate: daysAgo(75),
    plannedPaymentMethod: 'cash',
  });

  // שולם במלואו
  await recordPayment(db, {
    commitmentId: shabbatAliyah.id,
    amountAgorot: shekelsToAgorot(540),
    paymentDate: daysAgo(70),
    method: 'cash',
    description: 'עלייה לתורה - שבת וירא',
  });

  // חוב ותיק (מעל 60 יום), טרם שולם
  createCommitment(db, {
    memberId: members[2]!.id,
    organizationId: synagogue.id,
    commitmentTypeId: typeId('seat'),
    amountAgorot: shekelsToAgorot(2500),
    commitmentDate: daysAgo(95),
    dueDate: daysAgo(65),
    plannedPaymentMethod: 'credit_card',
    notes: 'מקום קבוע לשנת תשפ"ו',
  });

  // חוב חדש (מעל 30 יום)
  createCommitment(db, {
    memberId: members[3]!.id,
    organizationId: achvatTorah.id,
    commitmentTypeId: typeId('event'),
    eventId: dinner.id,
    amountAgorot: shekelsToAgorot(1200),
    commitmentDate: daysAgo(35),
    dueDate: daysAgo(5),
    plannedPaymentMethod: 'credit_card',
  });

  // תרומה לאחוות תורה - עמותה עם אישור ידני לקבלות (סעיף 29)
  const donation = createCommitment(db, {
    memberId: members[4]!.id,
    organizationId: achvatTorah.id,
    commitmentTypeId: typeId('donation'),
    amountAgorot: shekelsToAgorot(3600),
    commitmentDate: daysAgo(50),
    plannedPaymentMethod: 'bank_transfer',
    notes: 'תרומה שנתית',
  });
  // התשלום מתקבל החודש עבור התחייבות מחודש קודם - מזין את הכרטיס
  // "נגבה החודש בגין חובות קודמים" (סעיף 23).

  await recordPayment(db, {
    commitmentId: donation.id,
    amountAgorot: shekelsToAgorot(1800),
    paymentDate: daysAgo(3),
    method: 'bank_transfer',
    description: 'מחצית התרומה השנתית',
  });

  // התחייבות חדשה שנוצרה החודש
  createCommitment(db, {
    memberId: members[1]!.id,
    organizationId: synagogue.id,
    commitmentTypeId: typeId('kiddush'),
    amountAgorot: shekelsToAgorot(750),
    commitmentDate: daysAgo(5),
    plannedPaymentMethod: 'bit',
    notes: 'קידוש לרגל הולדת נכד',
  });

  // --- הוראת קבע + חיוב חודשי ------------------------------------------------
  const standingOrder = createStandingOrder(db, {
    memberId: members[0]!.id,
    organizationId: synagogue.id,
    commitmentTypeId: typeId('membership'),
    amountAgorot: shekelsToAgorot(250),
    dayOfMonth: 1,
    method: 'standing_order',
    startDate: daysAgo(200),
  });
  await chargeStandingOrder(db, standingOrder.id);

  // --- תרומה ישירה ללא התחייבות מוקדמת --------------------------------------
  await recordPayment(db, {
    organizationId: synagogue.id,
    memberId: members[2]!.id,
    amountAgorot: shekelsToAgorot(500),
    paymentDate: daysAgo(8),
    method: 'bit',
    description: 'תרומה לקידוש',
  });

  // --- תשלום שלא שויך לחבר (סעיף 30) ----------------------------------------
  await recordPayment(db, {
    organizationId: synagogue.id,
    memberId: null,
    amountAgorot: shekelsToAgorot(360),
    paymentDate: daysAgo(2),
    method: 'bank_transfer',
    description: 'העברה בנקאית ללא זיהוי',
    receiptRequired: false,
  });

  // --- הוצאות, כדי שהדוח המאוחד יציג תמונה מלאה ------------------------------
  db.prepare(
    `INSERT INTO expenses (organization_id, category, supplier, amount_agorot, expense_date, method, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(synagogue.id, 'חשמל', 'חברת החשמל', shekelsToAgorot(1450), daysAgo(12), 'bank_transfer', 'חשבון דו-חודשי');
  db.prepare(
    `INSERT INTO expenses (organization_id, category, supplier, amount_agorot, expense_date, method, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(achvatTorah.id, 'ספרים', 'הוצאת ספרים', shekelsToAgorot(2200), daysAgo(25), 'credit_card', 'ספרי לימוד לכולל');

  // eslint-disable-next-line no-console
  console.log('נתוני הדוגמה נוצרו בהצלחה.');
}

const isMain = process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js');
if (isMain) {
  const db = openDatabase();
  seed(db)
    .then(() => db.close())
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(error);
      process.exit(1);
    });
}
