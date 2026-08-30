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
  seedReferenceData(db);
  return db;
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
