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
const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm';

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  log(`\n  ✖ ${message}\n`);
  process.exitCode = 1;
}

/** מריץ פקודה ומחכה לסיומה. מחזיר true אם הצליחה. */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS, // בחלונות npm הוא קובץ אצווה ודורש shell
  });
  return result.status === 0;
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
  if (Number(major) < 20) {
    fail(`נדרש Node.js בגרסה 20 ומעלה. מותקנת אצלכם גרסה ${process.versions.node}.\n    להורדה: https://nodejs.org`);
    return;
  }

  // התקנה ראשונה של התלויות
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    log('  התקנה ראשונה, זה ייקח כדקה...');
    if (!run(NPM, ['install'])) {
      fail('ההתקנה נכשלה. בדקו חיבור לאינטרנט ונסו שוב.');
      return;
    }
  }

  // יצירת בסיס הנתונים ונתוני הדוגמה בהרצה הראשונה
  const dbFile = path.join(ROOT, 'data', 'beit-knesset.db');
  if (!fs.existsSync(dbFile)) {
    log('  יוצר את בסיס הנתונים...');
    if (!run(NPM, ['run', 'seed'])) {
      fail('יצירת בסיס הנתונים נכשלה.');
      return;
    }
  }

  const port = await findFreePort(Number(process.env['PORT']) || 3000);
  const url = `http://localhost:${port}`;

  log('  מפעיל את המערכת...');
  const server = spawn(NPM, ['run', 'app'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit',
    shell: IS_WINDOWS,
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
