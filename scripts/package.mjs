/**
 * אריזת המערכת לקובץ אחד, לשליחה למישהו אחר.
 *
 * המערכת אינה שירות באינטרנט אלא תוכנה שרצה על המחשב. לכן הדרך הפשוטה
 * ביותר להראות אותה למישהו היא לשלוח לו אותה, ושתרוץ אצלו - על המחשב
 * שלו, עם עותק נתונים משלו, בלי תלות במחשב הזה ובלי לפתוח דבר לאינטרנט.
 *
 * הקובץ שנוצר כולל את כל הקוד, את המפעילים ללחיצה אחת ובסיס נתונים
 * להדגמה. מה שהוא אינו כולל, במכוון: את תיקיית החבילות (נוצרת אצלו
 * בהפעלה הראשונה) ואת הנתונים האמיתיים של בית המדרש.
 *
 * שימוש:
 *   npm run package                  נתוני דוגמה נקיים
 *   npm run package -- --with-my-data  עותק של הנתונים שבמחשב הזה
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'package');
const ZIP_NAME = 'beit-knesset-system.zip';
/** שם התיקייה שתיפתח אצל המקבל. באנגלית, כדי שלא ישתבש בשום מערכת. */
const FOLDER = 'beit-knesset';
const WITH_MY_DATA = process.argv.includes('--with-my-data');

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

// --- כותב ZIP קטן ----------------------------------------------------------
// ללא תלות חיצונית ובלי הסתמכות על כלי של מערכת ההפעלה: בחלונות אין
// zip בשורת הפקודה, וב-tar המובנה ההתנהגות שונה בין גרסאות.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** תאריך ושעה בתבנית של MS-DOS, כפי שתקן ה-ZIP מחייב. */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function writeZip(entries, target) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    // דחיסה שמגדילה קובץ קטן - נשמר כפי שהוא.
    const store = deflated.length >= entry.data.length;
    const payload = store ? entry.data : deflated;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // גרסה נדרשת
    local.writeUInt16LE(0x0800, 6); // שמות קבצים ב-UTF-8
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(store ? 0 : 8, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((entry.mode << 16) >>> 0, 38); // הרשאות, לשמירת קבצי הפעלה
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, name]));

    offset += local.length + name.length + payload.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(target, Buffer.concat([...chunks, directory, end]));
}

// --- בחירת הקבצים ----------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'data']);

/** כל הקבצים תחת תיקייה, ביחס לשורש הפרויקט. */
function filesUnder(relativeDir) {
  const out = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const relative = path.posix.join(dir, item.name);
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) walk(relative);
      } else {
        out.push(relative);
      }
    }
  };
  walk(relativeDir);
  return out;
}

/** ההוראות שהמקבל רואה ראשונות, לפני שהוא נוגע במשהו. */
function instructions() {
  return [
    'בית המדרש אנשי מעשה — מערכת ניהול קהילה וגבייה',
    '='.repeat(46),
    '',
    'המערכת רצה על המחשב שלכם. אין צורך בחשבון, בהרשמה או באינטרנט',
    'אחרי ההתקנה הראשונה.',
    '',
    'שלב 1 — התקנת Node.js (פעם אחת, אם אינו מותקן)',
    '  הורידו את גרסת ה-LTS מ-https://nodejs.org והתקינו.',
    '  אין צורך לסמן "Tools for Native Modules" בסוף ההתקנה.',
    '',
    'שלב 2 — הפעלה',
    '  חלונות:  לחיצה כפולה על  start-windows.cmd',
    '  מק:      לחיצה כפולה על  start-mac.command',
    '  לינוקס:  ./start-linux.sh',
    '',
    'ההפעלה הראשונה נמשכת כדקה: המערכת מתקינה לעצמה את מה שהיא צריכה,',
    'ואז נפתח הדפדפן על http://localhost:3000',
    '',
    'כל הפעלה נוספת מיידית.',
    '',
    'הנתונים',
    '-'.repeat(46),
    WITH_MY_DATA
      ? 'הקובץ כולל עותק של הנתונים שהיו במחשב ששלח אותו.'
      : 'הקובץ כולל נתוני דוגמה בלבד, לא נתונים אמיתיים.',
    'הכול נשמר בקובץ אחד: data/beit-knesset.db, על המחשב שלכם בלבד.',
    'מחיקת התיקייה מוחקת את המערכת ואת הנתונים יחד.',
    '',
    'לתשומת לבכם: למערכת אין עדיין מסך התחברות. כל מי שיושב מול המחשב',
    'הזה רואה ועורך את הכול. היא מיועדת להרצה מקומית, ואין לחשוף אותה',
    'לאינטרנט לפני שתיווסף הזדהות.',
    '',
  ].join('\r\n'); // שורות בתבנית של חלונות, כדי שייקרא נכון ב-Notepad
}

/** בסיס הנתונים שייכלל בחבילה. */
async function buildDatabase() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, 'beit-knesset.db');
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });

  if (WITH_MY_DATA) {
    const source = path.resolve(ROOT, process.env['DATABASE_FILE'] ?? './data/beit-knesset.db');
    if (!fs.existsSync(source)) throw new Error(`לא נמצא בסיס נתונים ב-${source}`);
    log('  מעתיק את הנתונים שבמחשב הזה...');
    // מצב WAL: העתקת הקובץ הראשי לבדו עלולה להחסיר כתיבות אחרונות.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(source, { readonly: true });
    await db.backup(target);
    db.close();
  } else {
    log('  יוצר נתוני דוגמה נקיים...');
    const result = spawnSync('npm run seed', {
      cwd: ROOT,
      shell: true,
      stdio: 'ignore',
      env: { ...process.env, DATABASE_FILE: path.relative(ROOT, target) },
    });
    if (result.status !== 0) throw new Error('יצירת נתוני הדוגמה נכשלה');
  }

  // ההעתק נפתח פעם אחת ונסגר, כדי לקפל את ה-WAL לתוך הקובץ עצמו
  // ולוודא שקובץ יחיד מספיק אצל המקבל.
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(target);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    /* אם לא ניתן - הקבצים הנלווים ייכללו כפי שהם */
  }
  return target;
}

async function main() {
  log();
  log('  אריזת המערכת לשליחה');
  log('  ─────────────────────');

  const dbFile = await buildDatabase();

  const sources = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'vitest.config.ts',
    'README.md',
    'start-windows.cmd',
    'start-mac.command',
    'start-linux.sh',
    'import-data.cmd',
    ...filesUnder('src'),
    ...filesUnder('scripts'),
    ...filesUnder('tests'),
  ].filter((relative) => fs.existsSync(path.join(ROOT, relative)));

  const entries = sources.map((relative) => ({
    name: path.posix.join(FOLDER, relative),
    data: fs.readFileSync(path.join(ROOT, relative)),
    // קבצי ההפעלה של מק ולינוקס חייבים להישאר ברי-הרצה
    mode: /\.(command|sh)$/.test(relative) ? 0o100755 : 0o100644,
  }));

  entries.push({
    name: path.posix.join(FOLDER, 'data', 'beit-knesset.db'),
    data: fs.readFileSync(dbFile),
    mode: 0o100644,
  });
  for (const suffix of ['-wal', '-shm']) {
    if (!fs.existsSync(`${dbFile}${suffix}`)) continue;
    entries.push({
      name: path.posix.join(FOLDER, 'data', `beit-knesset.db${suffix}`),
      data: fs.readFileSync(`${dbFile}${suffix}`),
      mode: 0o100644,
    });
  }
  entries.push({
    name: path.posix.join(FOLDER, 'התחילו-כאן.txt'),
    data: Buffer.from('﻿' + instructions(), 'utf8'), // BOM, כדי ש-Notepad יזהה עברית
    mode: 0o100644,
  });

  const zipPath = path.join(OUT_DIR, ZIP_NAME);
  writeZip(entries, zipPath);

  const megabytes = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  log();
  log(`  ✔ נוצר קובץ אחד לשליחה (${megabytes} מ"ב, ${entries.length} קבצים):`);
  log();
  log(`     ${zipPath}`);
  log();
  log(WITH_MY_DATA
    ? '  הקובץ כולל עותק של הנתונים שבמחשב הזה.'
    : '  הקובץ כולל נתוני דוגמה בלבד. לשליחת הנתונים שכאן: npm run package -- --with-my-data');
  log('  המקבל פותח את הקובץ, קורא את "התחילו-כאן", ולוחץ על המפעיל.');
  log('  נדרש Node.js אצלו. אין צורך בחשבון, בשרת או באינטרנט.');
  log();
}

main().catch((error) => {
  log(`\n  ✖ ${error.message}\n`);
  process.exitCode = 1;
});
