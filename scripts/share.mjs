/**
 * הכנת המערכת לשיתוף עם אדם חיצוני.
 *
 * למערכת אין עדיין משתמשים וסיסמאות, ולכן פתיחה שלה למישהו אחר מחייבת
 * הפרדה מפורשת. הסקריפט הזה מרים עותק הדגמה נפרד לחלוטין:
 *
 *  1. בסיס נתונים משוכפל - מה שהאורח משנה אינו נוגע לנתונים האמיתיים.
 *  2. תיקיית קבלות נפרדת - שום קובץ אמיתי אינו נגיש דרך העותק.
 *  3. מפתח גישה אקראי בכתובת - מי שאין לו את הקישור המלא אינו נכנס.
 *
 * הסקריפט מפעיל את המערכת מקומית בלבד ומדפיס את הכתובות. כדי שהאורח
 * יגיע אליה מרחוק נדרשת מנהרה או אחסון - החלטה שנעשית מחוץ לקוד הזה.
 *
 * שימוש:
 *   npm run share              האורח יכול גם לנסות לרשום (בעותק בלבד)
 *   npm run share -- --view    צפייה בלבד: כל שינוי נחסם בשרת
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';
const SHARE_DIR = path.join(ROOT, 'data', 'share');
const SHARE_DB = path.join(SHARE_DIR, 'demo.db');
const READ_ONLY = process.argv.includes('--view') || process.argv.includes('--readonly');

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

/** מאתר פורט פנוי, כדי שפורט תפוס לא יפיל את ההפעלה. */
function findFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * עותק של בסיס הנתונים.
 *
 * המערכת עובדת במצב WAL, ולכן העתקת הקובץ הראשי לבדו עלולה להחסיר את
 * הכתיבות האחרונות. לכן נעשה שימוש בגיבוי של SQLite עצמו, ורק אם אינו
 * זמין מועתקים גם הקבצים הנלווים.
 */
async function copyDatabase(source) {
  fs.mkdirSync(SHARE_DIR, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${SHARE_DB}${suffix}`, { force: true });

  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(source, { readonly: true });
    await db.backup(SHARE_DB);
    db.close();
  } catch {
    for (const suffix of ['', '-wal', '-shm']) {
      const from = `${source}${suffix}`;
      if (fs.existsSync(from)) fs.copyFileSync(from, `${SHARE_DB}${suffix}`);
    }
  }
}

/** ממתין עד שהשרת עונה. המפתח נדרש גם כאן, כי שומר הסף חוסם הכול. */
function waitForServer(port, key, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const request = http.get(
        {
          host: '127.0.0.1',
          port,
          path: `/api/health?key=${encodeURIComponent(key)}`,
          timeout: 2000,
        },
        (response) => {
          response.resume();
          if (response.statusCode === 200) resolve(true);
          else retry();
        },
      );
      request.on('error', retry);
      request.on('timeout', () => {
        request.destroy();
        retry();
      });
    };
    const retry = () => (Date.now() > deadline ? resolve(false) : setTimeout(attempt, 500));
    attempt();
  });
}

/** כתובת המחשב ברשת הביתית, למי שנמצא באותו בית. */
function localNetworkAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const [a, b] = address.address.split('.').map(Number);
      if (a === 192 && b === 168) return address.address;
      if (a === 10) return address.address;
      if (a === 172 && b >= 16 && b <= 31) return address.address;
    }
  }
  return null;
}

async function main() {
  log();
  log('  עותק הדגמה לשיתוף');
  log('  ───────────────────');

  const sourceDb = path.resolve(ROOT, process.env['DATABASE_FILE'] ?? './data/beit-knesset.db');
  if (!fs.existsSync(sourceDb)) {
    log(`\n  ✖ לא נמצא בסיס נתונים ב-${sourceDb}.`);
    log('    הפעילו את המערכת פעם אחת לפני השיתוף.\n');
    process.exitCode = 1;
    return;
  }

  log('  מכין עותק נפרד של הנתונים...');
  await copyDatabase(sourceDb);

  const key = crypto.randomBytes(16).toString('base64url');
  const port = await findFreePort();

  const server = spawn(IS_WINDOWS ? 'npx.cmd' : 'npx', ['tsx', 'src/server.ts'], {
    cwd: ROOT,
    shell: IS_WINDOWS,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_FILE: path.relative(ROOT, SHARE_DB),
      RECEIPT_STORAGE_DIR: path.relative(ROOT, path.join(SHARE_DIR, 'receipts')),
      SHARE_KEY: key,
      SHARE_READ_ONLY: READ_ONLY ? '1' : '',
    },
  });

  const stop = () => {
    server.kill();
    log('\n  עותק ההדגמה נסגר.\n');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (!(await waitForServer(port, key))) {
    log('\n  ✖ השרת לא עלה בזמן.\n');
    stop();
    return;
  }

  const lan = localNetworkAddress();
  log();
  log('  ✔ עותק ההדגמה פועל. הקישורים כוללים את מפתח הגישה:');
  log();
  log(`     מהמחשב הזה:        http://localhost:${port}/?key=${key}`);
  if (lan) log(`     מאותה רשת ביתית:   http://${lan}:${port}/?key=${key}`);
  log();
  log(READ_ONLY
    ? '  צפייה בלבד: אפשר לעבור בין כל המסכים, וכל ניסיון לשנות נחסם בשרת.'
    : '  האורח יכול גם לרשום. הרישום נכנס לעותק ההדגמה, ולא לנתונים האמיתיים.');
  log(`  העותק נשמר ב-${path.relative(ROOT, SHARE_DB)} וניתן למחיקה בכל רגע.`);
  log();
  log('  כדי שהאורח ייכנס מחוץ לבית נדרשת מנהרה או אחסון - ראו README.');
  log('  (להפסקה: Ctrl+C)');
  log();
}

main().catch((error) => {
  log(`\n  ✖ ${error.message}\n`);
  process.exitCode = 1;
});
