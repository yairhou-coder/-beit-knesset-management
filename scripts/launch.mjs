/**
 * מפעיל המערכת בלחיצה אחת.
 *
 * נועד להיות מופעל מקיצור דרך בשולחן העבודה, ולכן הוא עושה לבד את כל מה
 * שנדרש: מתקין תלויות אם חסרות, יוצר בסיס נתונים אם אין, בוחר פורט פנוי,
 * מריץ את השרת, ופותח את הדפדפן ברגע שהמערכת מוכנה.
 *
 * משתמש אך ורק במודולים המובנים של Node, כדי שיוכל לרוץ עוד לפני
 * ההתקנה הראשונה של התלויות.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  log(`\n  ✖ ${message}\n`);
  process.exitCode = 1;
}

/**
 * מריץ פקודה ומחכה לסיומה. מחזיר true אם הצליחה.
 *
 * הפקודה מועברת כמחרוזת אחת ולא כמערך ארגומנטים: בחלונות npm הוא קובץ
 * אצווה ומחייב shell, ושילוב של shell עם מערך ארגומנטים מפיק ב-Node 22+
 * אזהרת DEP0190. כל הפקודות כאן קבועות בקוד, ולכן אין כאן קלט חיצוני.
 */
function run(commandLine) {
  const result = spawnSync(commandLine, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  return result.status === 0;
}

/**
 * מוחק את תיקיית החבילות, כדי לאפשר התקנה נקייה.
 * בחלונות קבצים עשויים להיות נעולים לרגע, ולכן נעשים ניסיונות חוזרים.
 */
function removeNodeModules() {
  const target = path.join(ROOT, 'node_modules');
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    return !fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * בודק שההתקנה שלמה ותקינה.
 *
 * קיום קבצים אינו מספיק: עץ חבילות פגום עשוי להכיל package.json בלי
 * הבינארי שלצדו. לכן, מעבר לבדיקת הקבצים, החבילה המקומפלת נטענת בפועל
 * בתהליך נפרד - זו הבדיקה היחידה שבאמת מוכיחה שהמערכת תוכל לרוץ.
 */
function dependenciesReady() {
  const required = [
    'node_modules/tsx/package.json',
    'node_modules/express/package.json',
    IS_WINDOWS ? 'node_modules/.bin/tsx.cmd' : 'node_modules/.bin/tsx',
  ];
  if (!required.every((relative) => fs.existsSync(path.join(ROOT, relative)))) return false;

  // טעינת הרכיב המקומפל בפועל
  const sqlite = spawnSync(
    `node -e "const D=require('better-sqlite3');new D(':memory:').close()"`,
    { cwd: ROOT, shell: true, stdio: 'ignore' },
  );
  if (sqlite.status !== 0) return false;

  // ו-tsx, שבלעדיו לא ניתן להריץ את קוד המערכת
  const tsx = spawnSync('npx tsx -e ""', { cwd: ROOT, shell: true, stdio: 'ignore' });
  return tsx.status === 0;
}

/** מאתר פורט פנוי, כדי שפורט תפוס לא יפיל את ההפעלה. */
function findFreePort(preferred) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });

  return (async () => {
    for (const port of [preferred, 3001, 3100, 3200, 8080, 0]) {
      if (port === 0) break;
      if (await tryPort(port)) return port;
      log(`  פורט ${port} תפוס, מנסה אחר...`);
    }
    return 0; // 0 = שהמערכת תבחר פורט אקראי פנוי
  })();
}

/** ממתין עד שהשרת עונה, ומחזיר false אם לא עלה בזמן. */
function waitForServer(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const request = http.get(
        { host: '127.0.0.1', port, path: '/api/health', timeout: 2000 },
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
    const retry = () => {
      if (Date.now() > deadline) resolve(false);
      else setTimeout(attempt, 500);
    };
    attempt();
  });
}

/** פותח את הדפדפן בכתובת המערכת. */
function openBrowser(url) {
  if (process.env['BK_NO_BROWSER'] === '1') return;
  const [command, args] = IS_WINDOWS
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    log(`  לא הצלחתי לפתוח את הדפדפן. פתחו ידנית: ${url}`);
  }
}

async function main() {
  log('');
  log('  בית המדרש אנשי מעשה — מערכת הניהול');
  log('  ─────────────────────────────────────');

  const [major] = process.versions.node.split('.');
  if (Number(major) < 22) {
    fail(`נדרש Node.js בגרסה 22 ומעלה. מותקנת אצלכם גרסה ${process.versions.node}.\n    להורדה: https://nodejs.org (גרסת LTS)`);
    return;
  }

  // התקנת התלויות.
  // בדיקת קיום התיקייה node_modules אינה מספיקה: התקנה שנקטעה באמצע
  // (למשל סגירת החלון) משאירה תיקייה חלקית, ואז ההרצה נופלת בהמשך על
  // "tsx is not recognized". לכן נבדקות החבילות עצמן.
  if (!dependenciesReady()) {
    const partial = fs.existsSync(path.join(ROOT, 'node_modules'));
    log(partial ? '  ההתקנה הקודמת לא הושלמה, משלים אותה...' : '  התקנה ראשונה, זה ייקח כדקה...');
    log('  אנא אל תסגרו את החלון עד לסיום.');
    log('');

    // --ignore-scripts מונע מ-npm לנסות לבנות רכיבים מקומפלים.
    // הרכיב היחיד כזה כאן, better-sqlite3, מגיע עם בינארי מוכן לכל מערכת
    // הפעלה ואינו זקוק לבנייה. בלי הדגל הזה npm בחלונות מנסה להריץ
    // node-gyp, ונכשל אצל מי שאין לו Visual Studio מותקן.
    if (!run('npm install --ignore-scripts') || !dependenciesReady()) {
      log('');
      log('  מנקה ומתקין מחדש מאפס...');
      if (!removeNodeModules()) {
        fail('לא הצלחתי למחוק את תיקיית node_modules. סגרו חלונות פתוחים ונסו שוב.');
        return;
      }
      log('');
      if (!run('npm install --ignore-scripts') || !dependenciesReady()) {
        // רשת ביטחון: אם בכל זאת חסר משהו שדורש סקריפט התקנה, ננסה
        // התקנה רגילה. היא עלולה להיכשל בבנייה, ולכן היא אחרונה בתור.
        log('');
        log('  מנסה התקנה מלאה...');
        if (!run('npm install') || !dependenciesReady()) {
          fail(
            'ההתקנה נכשלה.\n' +
              '    בדקו חיבור לאינטרנט ונסו שוב.\n' +
              '    אם זה חוזר - שלחו את הטקסט שמופיע למעלה.',
          );
          return;
        }
      }
    }
  }

  // יצירת בסיס הנתונים ונתוני הדוגמה בהרצה הראשונה
  const dbFile = path.join(ROOT, 'data', 'beit-knesset.db');
  if (!fs.existsSync(dbFile)) {
    log('  יוצר את בסיס הנתונים...');
    if (!run('npm run seed')) {
      fail(
        'יצירת בסיס הנתונים נכשלה.\n' +
          '    נסו להפעיל שוב. אם זה חוזר - שלחו את הטקסט שמופיע למעלה.',
      );
      return;
    }
  }

  const port = await findFreePort(Number(process.env['PORT']) || 3000);
  const url = `http://localhost:${port}`;

  log('  מפעיל את המערכת...');
  const server = spawn('npm run app', {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit',
    shell: true,
  });

  server.on('exit', (code) => {
    if (code && code !== 0) fail(`השרת נסגר עם שגיאה (קוד ${code}).`);
    process.exit(code ?? 0);
  });

  // סגירה מסודרת של השרת יחד עם חלון המפעיל
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.kill();
      process.exit(0);
    });
  }

  if (await waitForServer(port)) {
    log('');
    log(`  ✔ המערכת פועלת: ${url}`);
    log('    לסגירה: סגרו את החלון הזה, או הקישו Ctrl+C');
    log('');
    openBrowser(url);
  } else {
    fail('השרת לא עלה בזמן. נסו שוב, או הריצו npm run dev כדי לראות את השגיאה.');
    server.kill();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
