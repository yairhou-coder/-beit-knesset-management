/**
 * שיתוף המערכת עם אדם חיצוני, בקישור אחד.
 *
 * למערכת אין עדיין משתמשים וסיסמאות, ולכן כתובת פתוחה באינטרנט היא
 * כתובת שכל מי שמגיע אליה רשאי גם למחוק בה נתונים. שתי השכבות כאן הן
 * המינימום שמאפשר לשלוח קישור לאדם מסוים בלי לפתוח את המערכת לכולם:
 *
 *  1. מפתח גישה - הקישור נושא מפתח אקראי חד-פעמי. בלעדיו אין גישה לדבר,
 *     גם לא ל-API. המפתח מומר לעוגייה בכניסה הראשונה, כדי שלא יישאר
 *     בשורת הכתובת ויודבק בטעות.
 *  2. מצב צפייה - חסימה של כל פעולה שמשנה נתונים.
 *
 * זו אינה מערכת הרשאות: אין כאן זהות, אין תפקידים ואין תיעוד מי עשה מה.
 * היא נועדה להדגמה מוגבלת בזמן, ולא לשימוש היומיומי בנתונים אמיתיים.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** שיטות שאינן משנות דבר, ולכן מותרות גם במצב צפייה. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const ACCESS_COOKIE = 'bk_access';

/** השוואה בזמן קבוע, כדי שלא ניתן יהיה לנחש את המפתח תו אחר תו. */
function sameKey(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** קריאת עוגייה מהבקשה, בלי תלות בחבילה חיצונית. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function isApiRequest(req: Request): boolean {
  return req.path === '/api' || req.path.startsWith('/api/');
}

/** דף החסימה. מוצג לדפדפן; ל-API מוחזר JSON. */
function deniedPage(): string {
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>נדרש קישור גישה</title>
<style>
  body { font-family: system-ui, "Segoe UI", sans-serif; background: #f2efe9; color: #1d2b2f;
         display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; }
  .box { background: #fff; border: 1px solid #ddd6ca; border-radius: 14px; padding: 28px 32px;
         max-width: 30rem; box-shadow: 0 8px 24px rgba(29,79,90,.08); }
  h1 { font-size: 1.25rem; margin: 0 0 12px; color: #1d4f5a; }
  p { margin: 0 0 10px; line-height: 1.7; }
</style></head>
<body><div class="box">
  <h1>הקישור אינו שלם</h1>
  <p>המערכת נפתחת רק דרך קישור הגישה המלא שנשלח אליכם, זה שכולל את מפתח הגישה שבסופו.</p>
  <p>אם הקישור הועתק בחלקו - בקשו מהגבאי לשלוח אותו שוב.</p>
</div></body></html>`;
}

/**
 * שומר הסף: דורש את מפתח הגישה.
 *
 * כאשר לא הוגדר מפתח - אין כאן שכבה כלל, וההתנהגות זהה להרצה מקומית.
 */
export function createAccessGate(key: string | null): RequestHandler {
  if (!key) return (_req, _res, next) => next();

  return (req: Request, res: Response, next: NextFunction) => {
    const fromCookie = readCookie(req.headers.cookie, ACCESS_COOKIE);
    if (fromCookie !== null && sameKey(fromCookie, key)) {
      next();
      return;
    }

    const fromQuery = req.query['key'];
    if (typeof fromQuery === 'string' && sameKey(fromQuery, key)) {
      // שבוע אחד: די לצפייה, וקצר מכדי שקישור נשכח יישאר פתוח לאורך זמן.
      res.setHeader(
        'Set-Cookie',
        `${ACCESS_COOKIE}=${encodeURIComponent(key)}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax`,
      );
      // המפתח מוסר משורת הכתובת, כדי שלא ייחשף בהעתקה או בהיסטוריה.
      if (!isApiRequest(req)) {
        res.redirect(302, req.path);
        return;
      }
      next();
      return;
    }

    if (isApiRequest(req)) {
      res
        .status(401)
        .json({ error: { code: 'access_denied', message: 'נדרש קישור גישה תקף' } });
      return;
    }
    res.status(401).type('html').send(deniedPage());
  };
}

/**
 * מצב צפייה: חוסם כל פעולה שמשנה נתונים.
 *
 * החסימה היא בשרת ולא בממשק, כי ממשק אפשר לעקוף. הממשק רק מסמן את
 * המצב למשתמש, דרך /api/access.
 */
export function createReadOnlyGuard(readOnly: boolean): RequestHandler {
  if (!readOnly) return (_req, _res, next) => next();

  return (req: Request, res: Response, next: NextFunction) => {
    if (READ_METHODS.has(req.method)) {
      next();
      return;
    }
    res.status(403).json({
      error: {
        code: 'read_only',
        message: 'הקישור הזה נפתח לצפייה בלבד. אפשר לעיין בכל המסכים, אך לא לשנות נתונים.',
      },
    });
  };
}
