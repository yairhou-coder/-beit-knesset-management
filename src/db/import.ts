/**
 * ייבוא חברי הקהילה מקובץ האקסל שסופק.
 *
 * הרצה:
 *   npm run import              - ייבוא הנתונים + התחייבויות לדוגמה
 *   npm run import -- --reset   - מחיקת בסיס הנתונים הקיים ובנייה מחדש
 *   npm run import -- --members-only  - רק החברים והוראות הקבע, בלי דוגמאות
 *
 * מה מיובא מהקובץ:
 *   שם, טלפון, מייל, סכום הו"ק שוטפת, סכום הו"ק מקום/ריהוט,
 *   תאריך הוראת הקבע, 4 ספרות אחרונות של הכרטיס ומספר המקומות.
 *
 * מה נגזר מהנתונים:
 *   היסטוריית החיובים החודשיים - המערכת מריצה את הוראות הקבע מתאריך
 *   ההתחלה של כל חבר ועד היום, וכך נוצרים תשלומים, הכנסות וקבלות.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type Db } from './index.js';
import { shekelsToAgorot } from '../domain/money.js';
import { createOrganization, listOrganizations } from '../services/organizations.js';
import { createMember } from '../services/members.js';
import { createEvent, listCommitmentTypes } from '../services/catalog.js';
import { createCommitment } from '../services/commitments.js';
import { recordPayment } from '../services/payments.js';
import { chargeStandingOrder, createStandingOrder } from '../services/standingOrders.js';
import { resetProviderCaches } from '../integrations/registry.js';

interface ImportedMember {
  serial: number;
  fullName: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  monthlyDuesShekels: number;
  seatDuesShekels: number;
  standingOrderDate: string | null;
  cardLast4: string;
  seats: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * מספר התשלומים שבהם נפרסת התחייבות המקום/ריהוט.
 *
 * קובץ האקסל כולל את סכום התשלום החודשי בלבד ולא את הסכום הכולל, ולכן
 * הסכום הכולל נגזר כאן. ניתן לשנות את הערך, או לתקן כל התחייבות בנפרד
 * במסך ההתחייבויות.
 */
const SEAT_INSTALMENTS = 20;

function loadMembers(): ImportedMember[] {
  const file = path.join(here, 'import-data', 'members.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { members: ImportedMember[] };
  return parsed.members;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** רשימת החודשים (YYYY-MM) מתאריך ההתחלה ועד היום, כולל. */
function monthsBetween(startDate: string, endDate: string): string[] {
  const months: string[] = [];
  const start = new Date(`${startDate.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${endDate.slice(0, 7)}-01T00:00:00Z`);
  while (start <= end) {
    months.push(start.toISOString().slice(0, 7));
    start.setUTCMonth(start.getUTCMonth() + 1);
  }
  return months;
}

/** מספר פסאודו-אקראי יציב, כדי שכל הרצה תיתן את אותה תוצאה. */
function seededRandom(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

export async function importFromExcel(
  db: Db,
  options: { withExamples?: boolean; log?: (message: string) => void } = {},
): Promise<void> {
  const log = options.log ?? ((message: string) => console.log(message));
  const members = loadMembers();

  // --- עמותות ---------------------------------------------------------------
  let organizations = listOrganizations(db);
  let synagogue = organizations.find((org) => org.name.includes('אנשי מעשה'));
  if (!synagogue) {
    synagogue = createOrganization(db, {
      name: 'בית המדרש אנשי מעשה',
      shortName: 'אנשי מעשה',
      legalNumber: '580123456',
      allowedDocumentTypes: ['receipt', 'donation_receipt'],
      defaultDocumentType: 'receipt',
      receiptIssueMode: 'automatic',
      receiptConfig: { numberPrefix: 'BK-', startingNumber: 10001 },
    });
  }
  let achvatTorah = organizations.find((org) => org.name.includes('אחוות תורה'));
  if (!achvatTorah) {
    achvatTorah = createOrganization(db, {
      name: 'אחוות תורה',
      shortName: 'אחוות תורה',
      legalNumber: '580987654',
      allowedDocumentTypes: ['receipt', 'donation_receipt', 'tax_deductible_receipt'],
      defaultDocumentType: 'donation_receipt',
      receiptIssueMode: 'manual_approval',
      receiptConfig: { numberPrefix: 'AT-', startingNumber: 5001 },
    });
  }

  const types = listCommitmentTypes(db);
  const typeId = (key: string): number => types.find((type) => type.key === key)!.id;

  // --- חברים והוראות קבע ----------------------------------------------------
  log(`  מייבא ${members.length} חברים...`);
  const created: Array<{ memberId: number; source: ImportedMember; orders: number[] }> = [];
  const seatCommitments: Array<{ commitmentId: number; orderId: number }> = [];

  for (const source of members) {
    const member = createMember(db, {
      firstName: source.firstName,
      lastName: source.lastName,
      phone: source.phone,
      email: source.email,
      preferredChannel: 'whatsapp',
      notes: `מס״ד ${source.serial} · ${source.seats} מקומות · כרטיס ****${source.cardLast4}`,
    });

    const startDate = source.standingOrderDate ?? today();
    // יום החיוב נגזר מתאריך הוראת הקבע. המערכת מגבילה ל-1..28.
    const dayOfMonth = Math.min(28, Math.max(1, Number(startDate.slice(8, 10))));
    const orders: number[] = [];

    const dues = createStandingOrder(db, {
      memberId: member.id,
      organizationId: synagogue.id,
      commitmentTypeId: typeId('membership'),
      amountAgorot: shekelsToAgorot(source.monthlyDuesShekels),
      dayOfMonth,
      method: 'standing_order',
      startDate,
      notes: 'הו״ק שוטפת',
    });
    orders.push(dues.id);

    // מקום/ריהוט הוא התחייבות עם סכום כולל, ולא חיוב חודשי ללא סוף.
    // ההוראה החודשית משלמת אותה בתשלומים, וכל חיוב מקטין את היתרה.
    const seatTotal = shekelsToAgorot(source.seatDuesShekels * SEAT_INSTALMENTS);
    const seatCommitment = createCommitment(db, {
      memberId: member.id,
      organizationId: synagogue.id,
      commitmentTypeId: typeId('seat'),
      amountAgorot: seatTotal,
      commitmentDate: startDate,
      plannedPaymentMethod: 'standing_order',
      notes: `מקום/ריהוט · ${source.seats} מקומות · ${SEAT_INSTALMENTS} תשלומים של ${source.seatDuesShekels} ₪`,
    });

    // פריסת התשלומים נשמרת על ההתחייבות עצמה, כדי שמסך המקומות יציג
    // כמה תשלומים סוכמו ומתי התחיל התשלום הראשון.
    db.prepare(
      'UPDATE commitments SET instalments_count = ?, first_payment_date = ? WHERE id = ?',
    ).run(SEAT_INSTALMENTS, startDate, seatCommitment.id);

    const seat = createStandingOrder(db, {
      memberId: member.id,
      organizationId: synagogue.id,
      commitmentTypeId: typeId('seat'),
      commitmentId: seatCommitment.id,
      amountAgorot: shekelsToAgorot(source.seatDuesShekels),
      dayOfMonth,
      method: 'standing_order',
      startDate,
      notes: `הו״ק מקום/ריהוט · ${source.seats} מקומות`,
    });
    orders.push(seat.id);
    seatCommitments.push({ commitmentId: seatCommitment.id, orderId: seat.id });

    // 4 הספרות האחרונות של הכרטיס, כפי שהופיעו בקובץ
    for (const orderId of orders) {
      db.prepare('UPDATE standing_orders SET card_last4 = ? WHERE id = ?').run(
        source.cardLast4,
        orderId,
      );
    }

    created.push({ memberId: member.id, source, orders });
  }

  // --- היסטוריית חיובים ------------------------------------------------------
  // כל חיוב נרשם בתאריך שבו הוא באמת בוצע, ולא בתאריך הטעינה, כדי
  // שהדוחות החודשיים וגיל החוב יציגו תמונה נכונה.
  log('  מריץ את החיובים החודשיים מתאריך ההתחלה של כל חבר ועד היום...');
  let charges = 0;
  const now = today();
  for (const entry of created) {
    const startDate = entry.source.standingOrderDate ?? now;
    const dayOfMonth = Math.min(28, Math.max(1, Number(startDate.slice(8, 10))));
    for (const period of monthsBetween(startDate, now)) {
      const chargeDate = `${period}-${String(dayOfMonth).padStart(2, '0')}`;
      // חיוב שמועדו טרם הגיע - למשל בחודש הנוכחי - אינו נרשם
      if (chargeDate < startDate || chargeDate > now) continue;
      for (const orderId of entry.orders) {
        try {
          await chargeStandingOrder(db, orderId, period, { paymentDate: chargeDate });
          charges += 1;
        } catch {
          // הוראה שסיימה לשלם את ההתחייבות שלה - אין עוד מה לחייב
        }
      }
    }
  }
  log(`  נרשמו ${charges.toLocaleString('he-IL')} חיובי הוראת קבע.`);

  if (!options.withExamples) return;

  // --- התחייבויות להמחשה ----------------------------------------------------
  // אלה אינן מגיעות מקובץ האקסל. הן נוספות כדי שמסכי הגבייה והחובות לא
  // יהיו ריקים. כולן מסומנות בהערה "[דוגמה]" וניתן לזהותן ולמחוק אותן.
  log('  מוסיף התחייבויות להמחשה, לצורך מסכי הגבייה...');

  const shabbat = createEvent(db, {
    name: 'שבת פרשת נח',
    kind: 'shabbat',
    gregorianDate: addDays(today(), -70),
    organizationId: synagogue.id,
    notes: '[דוגמה]',
  });
  const holiday = createEvent(db, {
    name: 'ראש השנה',
    kind: 'holiday',
    gregorianDate: addDays(today(), -40),
    organizationId: synagogue.id,
    notes: '[דוגמה]',
  });
  const dinner = createEvent(db, {
    name: 'דינר שנתי',
    kind: 'event',
    gregorianDate: addDays(today(), -15),
    organizationId: achvatTorah.id,
    notes: '[דוגמה]',
  });

  const random = seededRandom(20260830);
  const plans: Array<{
    typeKey: string;
    amounts: number[];
    eventId: number | null;
    organizationId: number;
    ageDays: number[];
  }> = [
    { typeKey: 'aliyah', amounts: [180, 360, 540, 1800], eventId: holiday.id, organizationId: synagogue.id, ageDays: [40, 45, 50] },
    { typeKey: 'aliyah', amounts: [180, 260, 360], eventId: shabbat.id, organizationId: synagogue.id, ageDays: [68, 72, 75] },
    { typeKey: 'donation', amounts: [500, 1000, 1800, 3600], eventId: null, organizationId: achvatTorah.id, ageDays: [12, 25, 95] },
    { typeKey: 'event', amounts: [750, 1200], eventId: dinner.id, organizationId: achvatTorah.id, ageDays: [15, 18] },
    { typeKey: 'kiddush', amounts: [750, 900], eventId: null, organizationId: synagogue.id, ageDays: [1, 2, 4] },
    { typeKey: 'membership', amounts: [600, 900], eventId: null, organizationId: synagogue.id, ageDays: [2, 6] },
  ];

  let commitments = 0;
  let examplePayments = 0;

  for (const plan of plans) {
    // כל תוכנית מוחלת על קבוצת חברים שונה
    for (let index = 0; index < 9; index += 1) {
      const entry = created[Math.floor(random() * created.length)]!;
      const amount = plan.amounts[Math.floor(random() * plan.amounts.length)]!;
      const age = plan.ageDays[Math.floor(random() * plan.ageDays.length)]!;
      const commitmentDate = addDays(today(), -age);

      const commitment = createCommitment(db, {
        memberId: entry.memberId,
        organizationId: plan.organizationId,
        commitmentTypeId: typeId(plan.typeKey),
        eventId: plan.eventId,
        amountAgorot: shekelsToAgorot(amount),
        commitmentDate,
        dueDate: addDays(commitmentDate, 30),
        plannedPaymentMethod: 'bank_transfer',
        notes: '[דוגמה] התחייבות להמחשת מסכי הגבייה',
      });
      commitments += 1;

      // שליש שולמו במלואם, שליש חלקית, שליש טרם שולמו
      const state = index % 3;
      if (state === 0) {
        await recordPayment(db, {
          commitmentId: commitment.id,
          amountAgorot: shekelsToAgorot(amount),
          paymentDate: addDays(commitmentDate, 5),
          method: 'bank_transfer',
          description: 'תשלום מלא',
        });
        examplePayments += 1;
      } else if (state === 1) {
        await recordPayment(db, {
          commitmentId: commitment.id,
          amountAgorot: shekelsToAgorot(Math.round(amount / 2)),
          paymentDate: addDays(commitmentDate, 7),
          method: 'cash',
          description: 'תשלום חלקי',
        });
        examplePayments += 1;
      }
    }
  }

  // תשלום שאינו משויך לחבר, כדי שהכרטיס המתאים בדשבורד יציג נתון
  await recordPayment(db, {
    organizationId: synagogue.id,
    memberId: null,
    amountAgorot: shekelsToAgorot(360),
    paymentDate: addDays(today(), -3),
    method: 'bank_transfer',
    description: '[דוגמה] העברה בנקאית ללא זיהוי',
    receiptRequired: false,
  });

  // --- הוצאות להמחשה, על פני שנה ---------------------------------------
  log('  מוסיף הוצאות להמחשה...');
  const categoryId = (key: string): number =>
    (db.prepare('SELECT id FROM expense_categories WHERE key = ?').get(key) as { id: number }).id;

  // הסכומים תואמים את רישום ההוצאות של הגבאי, כדי שמסך התקציב יציג
  // מהתחלה השוואה שנראית כמו המציאות ולא מספרים שרירותיים.
  const monthlyExpenses: Array<{ key: string; supplier: string; amount: number; day: number }> = [
    { key: 'rabbi_salary', supplier: 'הרב', amount: 3000, day: 1 },
    { key: 'cleaning', supplier: 'שירותי ניקיון', amount: 3500, day: 5 },
    { key: 'loan_repayment', supplier: 'החזר הלוואה', amount: 4000, day: 10 },
    { key: 'electricity', supplier: 'חברת החשמל', amount: 1450, day: 12 },
    { key: 'water', supplier: 'תאגיד המים', amount: 320, day: 12 },
  ];
  // כ-11,500 ₪ קידושים בחודש, בפריסה שבועית
  const weeklyKiddush = { key: 'kiddush', supplier: 'מכולת השכונה', amounts: [2400, 2800, 3000, 3300] };

  const insertExpense = db.prepare(
    `INSERT INTO expenses
       (organization_id, category_id, category, event_id, supplier, amount_agorot,
        expense_date, method, invoice_number, description, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  const categoryName = (id: number): string =>
    (db.prepare('SELECT name FROM expense_categories WHERE id = ?').get(id) as { name: string }).name;

  let expenseCount = 0;
  const addExpense = (
    orgId: number,
    key: string,
    supplier: string,
    amount: number,
    expenseDate: string,
    eventId: number | null,
    description: string,
  ): void => {
    const cid = categoryId(key);
    insertExpense.run(
      orgId,
      cid,
      categoryName(cid),
      eventId,
      supplier,
      shekelsToAgorot(amount),
      expenseDate,
      'bank_transfer',
      String(100000 + Math.floor(random() * 899999)),
      description,
      '[דוגמה]',
    );
    expenseCount += 1;
  };

  for (let monthsAgo = 11; monthsAgo >= 0; monthsAgo -= 1) {
    const anchor = new Date();
    anchor.setUTCMonth(anchor.getUTCMonth() - monthsAgo, 1);
    const month = anchor.toISOString().slice(0, 7);

    for (const item of monthlyExpenses) {
      const when = `${month}-${String(item.day).padStart(2, '0')}`;
      if (when > today()) continue;
      addExpense(synagogue.id, item.key, item.supplier, item.amount, when, null, `${item.supplier} - ${month}`);
    }

    // קידוש שבועי
    for (const week of [4, 11, 18, 25]) {
      const when = `${month}-${String(week).padStart(2, '0')}`;
      if (when > today()) continue;
      const amount = weeklyKiddush.amounts[Math.floor(random() * weeklyKiddush.amounts.length)]!;
      addExpense(synagogue.id, weeklyKiddush.key, weeklyKiddush.supplier, amount, when, null, 'קידוש שבת');
    }
  }

  // הוצאות שמשויכות לאירועים, כדי לראות כמה עלה כל אירוע
  addExpense(synagogue.id, 'holidays', 'קייטרינג', 6800, addDays(today(), -38), holiday.id, 'סעודות ראש השנה');
  addExpense(synagogue.id, 'holidays', 'ספרים ומחזורים', 2400, addDays(today(), -42), holiday.id, 'מחזורים לחג');
  addExpense(synagogue.id, 'meals', 'מכולת השכונה', 1350, addDays(today(), -69), shabbat.id, 'קידוש מורחב');
  addExpense(achvatTorah.id, 'special_events', 'אולם אירועים', 14500, addDays(today(), -14), dinner.id, 'הדינר השנתי');
  addExpense(achvatTorah.id, 'books', 'הוצאת ספרים', 3400, addDays(today(), -25), null, 'ספרי לימוד לכולל');
  addExpense(synagogue.id, 'maintenance', 'חשמלאי', 1750, addDays(today(), -33), null, 'תיקון תאורה בעזרת נשים');
  addExpense(synagogue.id, 'furniture', 'נגריית שטיבל', 9600, addDays(today(), -55), null, 'שדרוג שולחנות');

  log(`  נוספו ${expenseCount} הוצאות להמחשה.`);

  log(`  נוספו ${commitments} התחייבויות להמחשה ו-${examplePayments} תשלומים.`);
}

/**
 * מרוקן את טבלאות הנתונים, בלי למחוק את קובץ בסיס הנתונים.
 *
 * מחיקת הקובץ עצמו נכשלת בחלונות כאשר המערכת פועלת ומחזיקה אותו פתוח.
 * ריקון מבפנים עובד גם אז, ו-SQLite מאפשר גישה מכמה תהליכים במקביל -
 * כך שאפשר לייבא בזמן שהמערכת רצה, ולראות את התוצאה ברענון הדפדפן.
 *
 * טבלאות העזר - סוגי ההתחייבות והגדרות המערכת - נשמרות.
 */
function clearAllData(db: Db): void {
  const tables = [
    'receipts',
    'incomes',
    'payments',
    'commitments',
    'standing_orders',
    'expenses',
    'notifications',
    'admin_alerts',
    'provider_webhook_events',
    'events',
    'members',
    'organizations',
  ];
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    for (const table of tables) db.prepare(`DELETE FROM ${table}`).run();
    // איפוס המונים, כדי שהמזהים יתחילו מחדש מאחד
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${tables.map(() => '?').join(',')})`).run(
      ...tables,
    );
  })();
  db.pragma('foreign_keys = ON');
  // הגדרות ה-Integration של העמותות נמחקו יחד איתן
  resetProviderCaches();
}

// --- הרצה מהשורה ------------------------------------------------------------

const isMain = process.argv[1]?.endsWith('import.ts') || process.argv[1]?.endsWith('import.js');
if (isMain) {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const membersOnly = args.includes('--members-only');

  const db = openDatabase();

  if (reset) {
    clearAllData(db);
    console.log('  הנתונים הקודמים נמחקו.');
  }

  const existing = listOrganizations(db).length > 0 && db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number };
  if (existing && existing.c > 0 && !reset) {
    console.log('');
    console.log('  בבסיס הנתונים כבר קיימים חברים.');
    console.log('  להתחלה נקייה הריצו:  npm run import -- --reset');
    console.log('');
    db.close();
    process.exit(1);
  }

  console.log('');
  console.log('  ייבוא נתוני חברי הקהילה');
  console.log('  ───────────────────────');
  const started = Date.now();

  importFromExcel(db, { withExamples: !membersOnly })
    .then(() => {
      const stat = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
      console.log('');
      console.log('  ✔ הייבוא הושלם בהצלחה');
      console.log(`    חברים          : ${stat('SELECT COUNT(*) AS c FROM members')}`);
      console.log(`    הוראות קבע     : ${stat('SELECT COUNT(*) AS c FROM standing_orders')}`);
      console.log(`    התחייבויות     : ${stat('SELECT COUNT(*) AS c FROM commitments')}`);
      console.log(`    תשלומים        : ${stat('SELECT COUNT(*) AS c FROM payments')}`);
      console.log(`    הכנסות         : ${stat('SELECT COUNT(*) AS c FROM incomes')}`);
      console.log(`    קבלות          : ${stat('SELECT COUNT(*) AS c FROM receipts')}`);
      console.log(`    זמן            : ${Math.round((Date.now() - started) / 1000)} שניות`);
      console.log('');
      db.close();
    })
    .catch((error: unknown) => {
      console.error(error);
      db.close();
      process.exit(1);
    });
}
