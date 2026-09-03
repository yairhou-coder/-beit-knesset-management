import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.js';

export type Db = Database.Database;

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, 'schema.sql');

/** מריץ את הסכמה ומגדיר את ה-pragmas הנדרשים. */
export function initializeDatabase(db: Db): Db {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  seedReferenceData(db);
  return db;
}

/**
 * מוסיף עמודות שנוספו לסכמה לאחר שבסיס הנתונים כבר נוצר.
 *
 * CREATE TABLE IF NOT EXISTS אינו משנה טבלה קיימת, ולכן מי שכבר מריץ את
 * המערכת לא היה מקבל עמודות חדשות. הפונקציה בודקת מה קיים בפועל ומוסיפה
 * רק את החסר, ולכן היא בטוחה להרצה חוזרת.
 */
function migrate(db: Db): void {
  const columnsOf = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

  const addColumn = (table: string, column: string, definition: string): void => {
    if (!columnsOf(table).includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  addColumn('standing_orders', 'commitment_id', 'INTEGER REFERENCES commitments(id)');
  addColumn('expenses', 'category_id', 'INTEGER REFERENCES expense_categories(id)');
  addColumn('expenses', 'event_id', 'INTEGER REFERENCES events(id)');
  addColumn('expenses', 'notes', 'TEXT');
  addColumn('expenses', 'updated_at', 'TEXT');

  // פריסת תשלומים על התחייבות (מקום/ריהוט)
  addColumn('commitments', 'instalments_count', 'INTEGER');
  addColumn('commitments', 'first_payment_date', 'TEXT');

  // תקציב מתוכנן לקטגוריית הוצאה
  addColumn('expense_categories', 'planned_amount_agorot', 'INTEGER');
  addColumn('expense_categories', 'planned_period', 'TEXT');
  addColumn('expense_categories', 'planned_note', 'TEXT');


  // ה-CHECK על סטטוס הוראת קבע נכתב לפני שנוסף הסטטוס "הושלמה". SQLite
  // אינו מאפשר לשנות אילוץ קיים, ולכן הטבלה נבנית מחדש - זהו הדפוס התקני.
  // עריכה ישירה של sqlite_master אינה אפשרית ואינה בטוחה.
  const standingOrdersSql = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='standing_orders'")
      .get() as { sql: string } | undefined
  )?.sql;
  if (standingOrdersSql && !standingOrdersSql.includes("'completed'")) {
    rebuildStandingOrders(db);
  }

  // האינדקסים נוצרים כאן ולא ב-schema.sql: חלקם מצביעים על עמודות שנוספו
  // זה עתה, ובבסיס נתונים קיים הם היו נכשלים בשלב הסכמה. הם נוצרים גם
  // לאחר בנייה מחדש של הטבלה, שבה האינדקסים הישנים נמחקים יחד איתה.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_standing_orders_member     ON standing_orders(member_id);
    CREATE INDEX IF NOT EXISTS idx_standing_orders_org        ON standing_orders(organization_id);
    CREATE INDEX IF NOT EXISTS idx_standing_orders_status     ON standing_orders(status);
    CREATE INDEX IF NOT EXISTS idx_standing_orders_commitment ON standing_orders(commitment_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_event    ON expenses(event_id);
  `);
}

/**
 * בונה מחדש את טבלת הוראות הקבע, כדי להרחיב את אילוץ הסטטוס.
 * הנתונים מועתקים במלואם; האינדקסים נוצרים מחדש אצל הקורא.
 */
function rebuildStandingOrders(db: Db): void {
  const columns = [
    'id', 'member_id', 'organization_id', 'commitment_type_id', 'commitment_id',
    'amount_agorot', 'day_of_month', 'method', 'status', 'start_date', 'end_date',
    'provider', 'provider_subscription_id', 'card_last4', 'card_expiry',
    'last_charge_at', 'last_failure_reason', 'notes', 'created_at', 'updated_at',
  ].join(', ');

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE standing_orders_migrated (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id          INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
        organization_id    INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        commitment_type_id INTEGER REFERENCES commitment_types(id) ON DELETE SET NULL,
        commitment_id      INTEGER REFERENCES commitments(id) ON DELETE SET NULL,
        amount_agorot      INTEGER NOT NULL CHECK (amount_agorot > 0),
        day_of_month       INTEGER NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
        method             TEXT    NOT NULL DEFAULT 'credit_card',
        status             TEXT    NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active','paused','cancelled',
                                                     'card_expired','failed','completed')),
        start_date         TEXT    NOT NULL,
        end_date           TEXT,
        provider           TEXT,
        provider_subscription_id TEXT,
        card_last4         TEXT,
        card_expiry        TEXT,
        last_charge_at     TEXT,
        last_failure_reason TEXT,
        notes              TEXT,
        created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(
      `INSERT INTO standing_orders_migrated (${columns}) SELECT ${columns} FROM standing_orders;`,
    );
    db.exec('DROP TABLE standing_orders;');
    db.exec('ALTER TABLE standing_orders_migrated RENAME TO standing_orders;');
  })();
  db.pragma('foreign_keys = ON');
}

/** נתוני יסוד שהמערכת אינה יכולה לתפקד בלעדיהם (סוגי התחייבות ברירת מחדל). */
function seedReferenceData(db: Db): void {
  const insert = db.prepare(`
    INSERT INTO commitment_types (key, name, document_type, sort_order)
    VALUES (@key, @name, @document_type, @sort_order)
    ON CONFLICT(key) DO NOTHING
  `);
  const defaults = [
    { key: 'aliyah', name: 'עלייה לתורה', document_type: 'receipt', sort_order: 10 },
    { key: 'donation', name: 'תרומה', document_type: 'donation_receipt', sort_order: 20 },
    { key: 'event', name: 'אירוע', document_type: 'receipt', sort_order: 30 },
    { key: 'membership', name: 'דמי חבר', document_type: 'receipt', sort_order: 40 },
    { key: 'seat', name: 'מקום בבית הכנסת', document_type: 'receipt', sort_order: 50 },
    { key: 'kiddush', name: 'קידוש', document_type: 'receipt', sort_order: 60 },
    { key: 'memorial', name: 'הזכרת נשמות', document_type: 'donation_receipt', sort_order: 70 },
    { key: 'other', name: 'אחר', document_type: 'receipt', sort_order: 999 },
  ];
  const tx = db.transaction(() => defaults.forEach((row) => insert.run(row)));
  tx();

  // קטגוריות הוצאה, מקובצות לפי אופי ההוצאה.
  //
  // האומדנים (planned) נלקחו מרישום ההוצאות של הגבאי. הם אומדנים בלבד -
  // המספרים נמסרו כטווח או בעיגול - ולכן הם משמשים למסך התקציב בלבד
  // ולעולם אינם נרשמים כהוצאה בפועל. כל הוצאה אמיתית נרשמת בנפרד.
  const insertCategory = db.prepare(`
    INSERT INTO expense_categories
      (key, name, kind, sort_order, planned_amount_agorot, planned_period, planned_note)
    VALUES (@key, @name, @kind, @sort_order, @planned, @period, @note)
    ON CONFLICT(key) DO NOTHING
  `);

  /** ₪ לאגורות, ו-null נשאר null (קטגוריה ללא אומדן). */
  const plan = (shekels: number | null): number | null =>
    shekels === null ? null : Math.round(shekels * 100);

  const categories: Array<{
    key: string;
    name: string;
    kind: string;
    sort_order: number;
    planned: number | null;
    period: 'monthly' | 'yearly' | 'occasional' | null;
    note: string | null;
  }> = [
    // --- משכורות ---
    { key: 'rabbi_salary', name: 'משכורת הרב', kind: 'salary', sort_order: 10,
      planned: plan(3000), period: 'monthly', note: 'אומדן לפי רישום הגבאי' },
    { key: 'gabai_salary', name: 'משכורת גבאי', kind: 'salary', sort_order: 20,
      planned: null, period: null, note: null },
    { key: 'staff_salary', name: 'שכר עובדים', kind: 'salary', sort_order: 30,
      planned: null, period: null, note: null },

    // --- הוצאות שוטפות ---
    { key: 'kiddush', name: 'קידושים', kind: 'ongoing', sort_order: 110,
      planned: plan(11500), period: 'monthly', note: 'אומדן: 11,000-12,000 ₪ בחודש' },
    { key: 'cleaning', name: 'ניקיון', kind: 'ongoing', sort_order: 120,
      planned: plan(3500), period: 'monthly', note: 'אומדן, בערך' },
    { key: 'loan_repayment', name: 'החזר הלוואה', kind: 'ongoing', sort_order: 130,
      planned: plan(4000), period: 'monthly', note: 'אומדן לפי רישום הגבאי' },
    { key: 'electricity', name: 'חשמל', kind: 'ongoing', sort_order: 140,
      planned: null, period: 'monthly', note: null },
    { key: 'water', name: 'מים', kind: 'ongoing', sort_order: 150,
      planned: null, period: 'monthly', note: null },
    { key: 'municipal_tax', name: 'ארנונה', kind: 'ongoing', sort_order: 160,
      planned: null, period: 'yearly', note: null },
    { key: 'insurance', name: 'ביטוח', kind: 'ongoing', sort_order: 170,
      planned: null, period: 'yearly', note: 'ביטוח שנתי - הסכום טרם הוזן' },
    { key: 'accountant', name: 'רואה חשבון', kind: 'ongoing', sort_order: 180,
      planned: null, period: 'yearly', note: 'שנתי - הסכום טרם הוזן' },
    { key: 'supplies', name: 'ציוד ומתכלים', kind: 'ongoing', sort_order: 190,
      planned: null, period: null, note: null },
    { key: 'books', name: 'ספרים ותשמישי קדושה', kind: 'ongoing', sort_order: 200,
      planned: null, period: null, note: null },

    // --- חגים ואירועים ---
    { key: 'holidays', name: 'חגים', kind: 'events', sort_order: 210,
      planned: plan(100000), period: 'yearly', note: 'אומדן שנתי לפי רישום הגבאי' },
    { key: 'special_events', name: 'אירועים', kind: 'events', sort_order: 220,
      planned: plan(20000), period: 'yearly', note: 'אומדן שנתי, בערך' },
    { key: 'fathers_and_sons', name: 'אבות ובנים', kind: 'events', sort_order: 230,
      planned: null, period: 'yearly', note: 'הסכום טרם הוזן' },
    { key: 'meals', name: 'סעודות ואירוח', kind: 'events', sort_order: 240,
      planned: null, period: null, note: null },

    // --- תחזוקה ואישורים ---
    { key: 'maintenance', name: 'תחזוקה ותיקונים', kind: 'maintenance', sort_order: 310,
      planned: null, period: 'occasional',
      note: 'אינסטלטור, טכנאי מזגנים, טכנאי מקררים והחזקה שוטפת' },
    { key: 'repairs_damage', name: 'תיקוני שבר ונזקים', kind: 'maintenance', sort_order: 320,
      planned: null, period: 'occasional', note: 'מה שנשבר או נהרס בבית הכנסת' },
    { key: 'permit_elevator', name: 'אישור מהנדס מעלית', kind: 'maintenance', sort_order: 330,
      planned: null, period: 'yearly', note: 'אישור שנתי' },
    { key: 'permit_electrician', name: 'אישור חשמלאי', kind: 'maintenance', sort_order: 340,
      planned: null, period: 'yearly', note: 'אישור שנתי' },
    { key: 'permit_fire', name: 'אישור כיבוי אש', kind: 'maintenance', sort_order: 350,
      planned: null, period: 'yearly', note: 'אישור שנתי' },
    { key: 'furniture', name: 'ריהוט וציוד קבוע', kind: 'maintenance', sort_order: 360,
      planned: null, period: null, note: null },

    { key: 'other_expense', name: 'אחר', kind: 'other', sort_order: 999,
      planned: null, period: null, note: null },
  ];
  db.transaction(() => categories.forEach((row) => insertCategory.run(row)))();

  // בסיס נתונים שכבר קיים לא יקבל את האומדנים דרך ה-INSERT שלמעלה, ולכן
  // הם מוזנים כאן - אך ורק לקטגוריות שאין בהן עדיין אומדן, כדי שערך
  // שהגבאי הזין ידנית לא יידרס.
  const fillPlan = db.prepare(`
    UPDATE expense_categories
       SET planned_amount_agorot = @planned,
           planned_period        = COALESCE(planned_period, @period),
           planned_note          = COALESCE(planned_note, @note)
     WHERE key = @key AND planned_amount_agorot IS NULL
  `);
  db.transaction(() =>
    categories
      .filter((row) => row.planned !== null)
      .forEach((row) => fillPlan.run({ key: row.key, planned: row.planned, period: row.period, note: row.note })),
  )();

  // הקטגוריה נקראה בעבר "אירועים מיוחדים"; השם המקוצר תואם את הרישום.
  db.prepare(
    `UPDATE expense_categories SET name = 'אירועים' WHERE key = 'special_events' AND name = 'אירועים מיוחדים'`,
  ).run();

  // סוג ההתחייבות "מקום" מכסה גם את הריהוט, וכך הוא נקרא בקהילה.
  db.prepare(
    `UPDATE commitment_types SET name = 'מקום וריהוט' WHERE key = 'seat' AND name = 'מקום בבית הכנסת'`,
  ).run();

  db.prepare(
    `INSERT INTO settings (key, value, description) VALUES (?, ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  ).run(
    'default_receipt_issue_mode',
    'automatic',
    'ברירת מחדל להפקת קבלות כאשר לעמותה אין הגדרה משלה',
  );
}

/** פותח בסיס נתונים בקובץ (או בזיכרון עבור טסטים). */
export function openDatabase(file: string = config.databaseFile): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  return initializeDatabase(db);
}

/** בסיס נתונים בזיכרון - לשימוש בטסטים. */
export function openInMemoryDatabase(): Db {
  return openDatabase(':memory:');
}

let singleton: Db | undefined;

export function getDb(): Db {
  if (!singleton) singleton = openDatabase();
  return singleton;
}

export function closeDb(): void {
  singleton?.close();
  singleton = undefined;
}
