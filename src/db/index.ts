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

  // ה-CHECK על סטטוס הוראת קבע נכתב לפני שנוסף הסטטוס "הושלמה". SQLite
  // אינו מאפשר לשנות אילוץ קיים, ולכן הטבלה נבנית מחדש רק אם צריך.
  const standingOrdersSql = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='standing_orders'")
      .get() as { sql: string } | undefined
  )?.sql;
  if (standingOrdersSql && !standingOrdersSql.includes("'completed'")) {
    db.exec("PRAGMA writable_schema = ON");
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type='table' AND name='standing_orders'").run(
      standingOrdersSql.replace(
        "'card_expired','failed')",
        "'card_expired','failed','completed')",
      ),
    );
    db.exec("PRAGMA writable_schema = OFF");
  }
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

  // קטגוריות הוצאה, מקובצות לפי אופי ההוצאה
  const insertCategory = db.prepare(`
    INSERT INTO expense_categories (key, name, kind, sort_order)
    VALUES (@key, @name, @kind, @sort_order)
    ON CONFLICT(key) DO NOTHING
  `);
  const categories = [
    { key: 'rabbi_salary', name: 'משכורת הרב', kind: 'salary', sort_order: 10 },
    { key: 'gabai_salary', name: 'משכורת גבאי', kind: 'salary', sort_order: 20 },
    { key: 'staff_salary', name: 'שכר עובדים', kind: 'salary', sort_order: 30 },

    { key: 'kiddush', name: 'קידושים', kind: 'ongoing', sort_order: 110 },
    { key: 'cleaning', name: 'ניקיון', kind: 'ongoing', sort_order: 120 },
    { key: 'electricity', name: 'חשמל', kind: 'ongoing', sort_order: 130 },
    { key: 'water', name: 'מים', kind: 'ongoing', sort_order: 140 },
    { key: 'municipal_tax', name: 'ארנונה', kind: 'ongoing', sort_order: 150 },
    { key: 'insurance', name: 'ביטוח', kind: 'ongoing', sort_order: 160 },
    { key: 'supplies', name: 'ציוד ומתכלים', kind: 'ongoing', sort_order: 170 },
    { key: 'books', name: 'ספרים ותשמישי קדושה', kind: 'ongoing', sort_order: 180 },

    { key: 'holidays', name: 'חגים', kind: 'events', sort_order: 210 },
    { key: 'special_events', name: 'אירועים מיוחדים', kind: 'events', sort_order: 220 },
    { key: 'meals', name: 'סעודות ואירוח', kind: 'events', sort_order: 230 },

    { key: 'maintenance', name: 'תחזוקה ותיקונים', kind: 'maintenance', sort_order: 310 },
    { key: 'furniture', name: 'ריהוט וציוד קבוע', kind: 'maintenance', sort_order: 320 },

    { key: 'other_expense', name: 'אחר', kind: 'other', sort_order: 999 },
  ];
  db.transaction(() => categories.forEach((row) => insertCategory.run(row)))();

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
