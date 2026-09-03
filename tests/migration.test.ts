/**
 * שדרוג בסיס נתונים קיים.
 *
 * CREATE TABLE IF NOT EXISTS אינו משנה טבלה קיימת, ולכן מי שכבר מריץ את
 * המערכת מקבל את העמודות החדשות רק דרך migrate(). הטסט פותח בסיס נתונים
 * שנוצר בגרסה קודמת ומוודא שהוא נפתח, משתדרג ועובד.
 */

import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import {
  createExpense,
  listExpenseCategories,
  updateExpenseCategoryBudget,
} from '../src/services/expenses.js';
import { createStandingOrder, listStandingOrders } from '../src/services/standingOrders.js';
import { createCommitment } from '../src/services/commitments.js';
import { listSeatCommitments } from '../src/services/seats.js';
import { createOrganization } from '../src/services/organizations.js';
import { createMember } from '../src/services/members.js';
import { listCommitmentTypes } from '../src/services/catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OLD_SCHEMA = path.join(here, 'fixtures', 'schema-before-expenses.sql');

const created: string[] = [];

afterEach(() => {
  for (const file of created.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  }
});

/** יוצר קובץ בסיס נתונים לפי הסכמה שקדמה לשינוי, ומכניס בו נתונים. */
function makeLegacyDatabase(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'legacy.db');
  created.push(file);

  const legacy = new Database(file);
  legacy.pragma('journal_mode = WAL');
  legacy.exec(fs.readFileSync(OLD_SCHEMA, 'utf8'));
  legacy.exec(`
    INSERT INTO organizations (id, name) VALUES (1, 'בית המדרש אנשי מעשה');
    INSERT INTO members (id, first_name, last_name) VALUES (1, 'יעקב', 'כהן');
    INSERT INTO commitment_types (id, key, name) VALUES (1, 'seat', 'מקום בבית הכנסת');
    INSERT INTO standing_orders (member_id, organization_id, amount_agorot, start_date)
      VALUES (1, 1, 15000, '2024-01-15');
    INSERT INTO expenses (organization_id, category, amount_agorot, expense_date)
      VALUES (1, 'חשמל', 145000, '2026-01-12');
  `);
  legacy.close();
  return file;
}

describe('שדרוג בסיס נתונים קיים', () => {
  it('בסיס נתונים מגרסה קודמת נפתח ומשתדרג', () => {
    const file = makeLegacyDatabase();

    // זו הנקודה שנכשלה: הסכמה ניסתה ליצור אינדקס על עמודה שטרם נוספה
    const db = openDatabase(file);

    const columns = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

    expect(columns('standing_orders')).toContain('commitment_id');
    expect(columns('expenses')).toContain('category_id');
    expect(columns('expenses')).toContain('event_id');
    expect(columns('expenses')).toContain('notes');
    expect(columns('commitments')).toContain('instalments_count');
    expect(columns('commitments')).toContain('first_payment_date');
    expect(columns('expense_categories')).toContain('planned_amount_agorot');
    expect(columns('expense_categories')).toContain('planned_period');

    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
      name: string;
    }>).map((row) => row.name);
    expect(indexes).toContain('idx_standing_orders_commitment');
    expect(indexes).toContain('idx_expenses_category');

    db.close();
  });

  it('הנתונים הקיימים נשמרים', () => {
    const file = makeLegacyDatabase();
    const db = openDatabase(file);

    expect((db.prepare('SELECT COUNT(*) c FROM members').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM standing_orders').get() as { c: number }).c).toBe(1);
    const expense = db.prepare('SELECT * FROM expenses').get() as { category: string; category_id: number | null };
    expect(expense.category).toBe('חשמל');
    expect(expense.category_id).toBeNull(); // הוצאה ישנה נשארת, ללא קטגוריה מקושרת

    db.close();
  });

  it('התכונות החדשות עובדות על בסיס הנתונים המשודרג', () => {
    const file = makeLegacyDatabase();
    const db = openDatabase(file);

    // קטגוריות ההוצאה נזרעות גם בשדרוג
    const categories = listExpenseCategories(db);
    expect(categories.length).toBeGreaterThan(10);

    createExpense(db, {
      organizationId: 1,
      categoryId: categories.find((c) => c.key === 'kiddush')!.id,
      amountAgorot: shekelsToAgorot(700),
    });

    // הוראת קבע מקושרת להתחייבות - התכונה שדרשה את העמודה החדשה
    const org = createOrganization(db, { name: 'אחוות תורה' });
    const member = createMember(db, { firstName: 'משה', lastName: 'לוי' });
    const commitment = createCommitment(db, {
      memberId: member.id,
      organizationId: org.id,
      commitmentTypeId: listCommitmentTypes(db)[0]!.id,
      amountAgorot: shekelsToAgorot(1200),
    });
    const order = createStandingOrder(db, {
      memberId: member.id,
      organizationId: org.id,
      commitmentId: commitment.id,
      amountAgorot: shekelsToAgorot(300),
    });
    expect(order.commitment?.amountAgorot).toBe(120_000);

    db.close();
  });

  it('שדרוג חוזר אינו משנה דבר', () => {
    const file = makeLegacyDatabase();
    openDatabase(file).close();
    const db = openDatabase(file); // הרצה שנייה
    expect((db.prepare('SELECT COUNT(*) c FROM members').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('קטגוריות ואומדנים חדשים מגיעים גם לבסיס נתונים קיים', () => {
    const file = makeLegacyDatabase();
    const db = openDatabase(file);

    const categories = listExpenseCategories(db);
    const byKey = (key: string) => categories.find((row) => row.key === key);

    // קטגוריות שנוספו לאחר שהמערכת כבר רצה
    expect(byKey('loan_repayment')).toBeDefined();
    expect(byKey('permit_fire')).toBeDefined();
    expect(byKey('accountant')).toBeDefined();

    // והאומדנים מוזנים גם לקטגוריות שכבר היו קיימות
    expect(byKey('kiddush')!.plannedAmountAgorot).toBe(shekelsToAgorot(11500));
    expect(byKey('cleaning')!.plannedAmountAgorot).toBe(shekelsToAgorot(3500));

    // סוג ההתחייבות מקבל את השם המעודכן
    expect(listCommitmentTypes(db).find((type) => type.key === 'seat')!.name).toBe('מקום וריהוט');

    db.close();
  });

  it('אומדן שהגבאי שינה אינו נדרס בהפעלה הבאה', () => {
    const file = makeLegacyDatabase();
    const first = openDatabase(file);
    const kiddush = listExpenseCategories(first).find((row) => row.key === 'kiddush')!;
    updateExpenseCategoryBudget(first, kiddush.id, {
      plannedAmountAgorot: shekelsToAgorot(9000),
      plannedNote: 'ירד השנה',
    });
    first.close();

    const second = openDatabase(file);
    const after = listExpenseCategories(second).find((row) => row.key === 'kiddush')!;
    expect(after.plannedAmountAgorot).toBe(shekelsToAgorot(9000));
    expect(after.plannedNote).toBe('ירד השנה');
    second.close();
  });

  it('סכומי מקום/ריהוט שהומצאו בייבוא מנוקים, והתשלומים נשמרים', () => {
    const file = makeLegacyDatabase();

    // מצב הביניים שנוצר אצל המשתמש: הוא כבר הריץ את הגרסה הקודמת, ולכן
    // הסכמה עודכנה. הייבוא של אותה גרסה גזר סכום כולל מהכפלת התשלום
    // החודשי ב-20 ורשם אותו כאילו סוכם כך, וההוראה סומנה כהושלמה ברגע
    // שהמצטבר הגיע לסכום המומצא.
    openDatabase(file).close();

    const previous = new Database(file);
    previous.exec(`
      INSERT INTO commitments
        (id, member_id, organization_id, commitment_type_id, commitment_date,
         amount_agorot, paid_agorot, status, notes)
      VALUES (1, 1, 1, 1, '2024-01-15', 800000, 800000, 'paid',
              'מקום/ריהוט · 2 מקומות · 20 תשלומים של 400 ₪');
      UPDATE standing_orders SET commitment_id = 1, status = 'completed';
    `);
    previous.close();

    const db = openDatabase(file);
    const row = db.prepare('SELECT * FROM commitments WHERE id = 1').get() as {
      amount_confirmed: number;
      amount_agorot: number;
      paid_agorot: number;
      status: string;
      instalments_count: number | null;
      notes: string;
    };

    // הסכום המומצא ירד, והסכום מסומן כלא ידוע
    expect(row.amount_confirmed).toBe(0);
    expect(row.amount_agorot).toBe(800000); // המצטבר ששולם בפועל
    expect(row.paid_agorot).toBe(800000); // התשלומים לא נגעו
    expect(row.status).toBe('open');
    expect(row.instalments_count).toBeNull();
    expect(row.notes).toContain('תשלום חודשי');
    expect(row.notes).not.toContain('20 תשלומים');

    // ההוראה שסומנה כהושלמה רק בגלל הסכום המומצא חוזרת לפעילות
    const order = db.prepare('SELECT status FROM standing_orders WHERE commitment_id = 1').get() as {
      status: string;
    };
    expect(order.status).toBe('active');

    db.close();
  });

  it('התחייבות שהגבאי הזין בעצמו אינה מנוקה', () => {
    const file = makeLegacyDatabase();
    const legacy = new Database(file);
    legacy.exec(`
      INSERT INTO commitments
        (id, member_id, organization_id, commitment_type_id, commitment_date,
         amount_agorot, paid_agorot, status, notes)
      VALUES (2, 1, 1, 1, '2024-05-01', 2000000, 500000, 'partially_paid',
              'סוכם איתו 20,000 ב-40 תשלומים');
    `);
    legacy.close();

    const db = openDatabase(file);
    const row = db.prepare('SELECT * FROM commitments WHERE id = 2').get() as {
      amount_confirmed: number;
      amount_agorot: number;
    };
    expect(row.amount_confirmed).toBe(1);
    expect(row.amount_agorot).toBe(2000000);
    db.close();
  });

  /**
   * המצב שנוצר אצל המשתמש בפועל: הייבוא הראשון יצר לכל חבר שתי הוראות
   * קבע נפרדות - שוטפת ומקום/ריהוט - בלי שום התחייבות מאחוריהן. שתיהן
   * נראו למערכת כהוראה שוטפת, ולכן כל חבר הופיע פעמיים במסך ההו"ק.
   */
  function makeTwoOrdersPerMember(): string {
    const file = makeLegacyDatabase();
    const legacy = new Database(file);
    legacy.exec(`
      -- מתחילים נקי, כדי שהתרחיש יהיה בדיוק שתי הוראות לחבר אחד
      DELETE FROM standing_orders;
      INSERT INTO commitment_types (id, key, name) VALUES (2, 'membership', 'דמי חבר');
      -- הו"ק שוטפת
      INSERT INTO standing_orders (id, member_id, organization_id, commitment_type_id,
                                   amount_agorot, day_of_month, start_date)
        VALUES (10, 1, 1, 2, 15000, 11, '2024-03-11');
      -- הו"ק מקום/ריהוט, ללא התחייבות מקושרת
      INSERT INTO standing_orders (id, member_id, organization_id, commitment_type_id,
                                   amount_agorot, day_of_month, start_date)
        VALUES (11, 1, 1, 1, 40000, 11, '2024-03-11');
      -- שני חיובים היסטוריים של הוראת המקום
      INSERT INTO payments (id, organization_id, member_id, standing_order_id, idempotency_key,
                            amount_agorot, payment_date, method, status)
        VALUES (100, 1, 1, 11, 'so-11-2024-03', 40000, '2024-03-11', 'standing_order', 'completed'),
               (101, 1, 1, 11, 'so-11-2024-04', 40000, '2024-04-11', 'standing_order', 'completed');
      INSERT INTO incomes (id, payment_id, organization_id, member_id, amount_agorot, income_date)
        VALUES (200, 100, 1, 1, 40000, '2024-03-11'),
               (201, 101, 1, 1, 40000, '2024-04-11');
    `);
    legacy.close();
    return file;
  }

  it('הוראת מקום/ריהוט ללא התחייבות מומרת להתחייבות ויוצאת מהמסך השוטף', () => {
    const db = openDatabase(makeTwoOrdersPerMember());

    const recurring = listStandingOrders(db, { kind: 'recurring' });
    expect(recurring).toHaveLength(1);
    expect(recurring[0]!.amountAgorot).toBe(15000); // רק ההו"ק השוטפת

    const seats = listSeatCommitments(db, {});
    expect(seats).toHaveLength(1);
    expect(seats[0]!.instalmentAgorot).toBe(40000);
    // התשלומים ההיסטוריים שויכו להתחייבות שנוצרה
    expect(seats[0]!.paidAgorot).toBe(80000);
    expect(seats[0]!.instalmentsPaid).toBe(2);
    // והסכום הכולל נשאר לא ידוע, כי הוא באמת אינו ידוע
    expect(seats[0]!.amountConfirmed).toBe(false);
    expect(seats[0]!.amountAgorot).toBeNull();

    db.close();
  });

  it('ההמרה אינה משנה שום סכום ואינה מוחקת רשומות', () => {
    const file = makeTwoOrdersPerMember();
    const db = openDatabase(file);

    expect((db.prepare('SELECT COUNT(*) c FROM payments').get() as { c: number }).c).toBe(2);
    expect((db.prepare('SELECT COUNT(*) c FROM incomes').get() as { c: number }).c).toBe(2);
    expect(
      (db.prepare('SELECT SUM(amount_agorot) s FROM payments').get() as { s: number }).s,
    ).toBe(80000);
    expect((db.prepare('SELECT COUNT(*) c FROM standing_orders').get() as { c: number }).c).toBe(2);

    // ההכנסות קיבלו את סוג ההתחייבות, כדי שהעמודה "סוג" תציג מקום וריהוט
    const income = db.prepare('SELECT commitment_type_id FROM incomes WHERE id = 200').get() as {
      commitment_type_id: number;
    };
    expect(income.commitment_type_id).toBe(1);

    db.close();
  });

  it('הרצה חוזרת אינה יוצרת התחייבות נוספת', () => {
    const file = makeTwoOrdersPerMember();
    openDatabase(file).close();
    const db = openDatabase(file);
    expect((db.prepare('SELECT COUNT(*) c FROM commitments').get() as { c: number }).c).toBe(1);
    expect(listSeatCommitments(db, {})).toHaveLength(1);
    db.close();
  });
});
