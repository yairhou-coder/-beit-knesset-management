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
import { createStandingOrder } from '../src/services/standingOrders.js';
import { createCommitment } from '../src/services/commitments.js';
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
});
