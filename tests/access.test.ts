/**
 * שיתוף המערכת: מפתח גישה ומצב צפייה.
 *
 * הנבדק כאן אינו הנוחות אלא הגבול: שבלי המפתח לא נחשף דבר, ושבמצב
 * צפייה השרת עצמו חוסם שינוי - ולא רק הממשק.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import { createTestDb, makeMember, makeOrganization } from './helpers.js';

const KEY = 'test-share-key-123';

let db: Db;
let guarded: Server;
let open: Server;
let guardedUrl: string;
let openUrl: string;

beforeAll(async () => {
  db = createTestDb();
  makeOrganization(db);
  makeMember(db);

  const listen = (app: ReturnType<typeof createApp>) =>
    new Promise<Server>((resolve) => {
      const created = app.listen(0, () => resolve(created));
    });

  guarded = await listen(createApp(db, { accessKey: KEY, readOnly: true }));
  open = await listen(createApp(db, { accessKey: null, readOnly: false }));
  guardedUrl = `http://127.0.0.1:${(guarded.address() as AddressInfo).port}`;
  openUrl = `http://127.0.0.1:${(open.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => guarded.close(() => resolve()));
  await new Promise<void>((resolve) => open.close(() => resolve()));
  db.close();
});

describe('מפתח גישה', () => {
  it('בלי מפתח אין גישה ל-API', async () => {
    const response = await fetch(`${guardedUrl}/api/dashboard`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('access_denied');
  });

  it('בלי מפתח גם הממשק עצמו אינו נמסר', async () => {
    const response = await fetch(`${guardedUrl}/`, { redirect: 'manual' });
    expect(response.status).toBe(401);
    // לא הודלף דבר מתוכן המערכת
    expect(await response.text()).not.toContain('app.js');
  });

  it('מפתח שגוי נדחה כמו מפתח חסר, גם אם אורכו זהה', async () => {
    const wrong = `${'x'.repeat(KEY.length)}`;
    expect((await fetch(`${guardedUrl}/api/dashboard?key=${wrong}`)).status).toBe(401);
    expect((await fetch(`${guardedUrl}/api/dashboard?key=short`)).status).toBe(401);
  });

  it('מפתח תקין פותח את ה-API ומחזיר עוגייה להמשך', async () => {
    const response = await fetch(`${guardedUrl}/api/dashboard?key=${KEY}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('bk_access=');
  });

  it('בדפדפן המפתח מוסר מהכתובת אחרי שנשמר', async () => {
    const response = await fetch(`${guardedUrl}/?key=${KEY}`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
  });

  it('העוגייה לבדה מספיקה לבקשות הבאות', async () => {
    const response = await fetch(`${guardedUrl}/api/dashboard`, {
      headers: { cookie: `bk_access=${KEY}; theme=dark` },
    });
    expect(response.status).toBe(200);
  });

  it('בלי מפתח מוגדר המערכת פתוחה כרגיל', async () => {
    expect((await fetch(`${openUrl}/api/health`)).status).toBe(200);
  });
});

describe('מצב צפייה', () => {
  const withKey = { cookie: `bk_access=${KEY}` };

  it('קריאה מותרת', async () => {
    expect((await fetch(`${guardedUrl}/api/members`, { headers: withKey })).status).toBe(200);
  });

  it('כתיבה נחסמת בשרת', async () => {
    const response = await fetch(`${guardedUrl}/api/members`, {
      method: 'POST',
      headers: { ...withKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'אורח', lastName: 'שמנסה לכתוב' }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('read_only');
  });

  it('גם מחיקה נחסמת', async () => {
    const response = await fetch(`${guardedUrl}/api/expenses/1`, {
      method: 'DELETE',
      headers: withKey,
    });
    expect(response.status).toBe(403);
  });

  it('שום רשומה לא נוצרה בפועל', async () => {
    const response = await fetch(`${guardedUrl}/api/members`, { headers: withKey });
    expect(await response.text()).not.toContain('שמנסה לכתוב');
  });

  it('הממשק מקבל את מצב הגישה כדי לסמן אותו', async () => {
    const shared = await (await fetch(`${guardedUrl}/api/access`, { headers: withKey })).json();
    expect(shared).toEqual({ shared: true, readOnly: true });
    const local = await (await fetch(`${openUrl}/api/access`)).json();
    expect(local).toEqual({ shared: false, readOnly: false });
  });

  it('במערכת רגילה הכתיבה עובדת', async () => {
    const response = await fetch(`${openUrl}/api/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'חבר', lastName: 'חדש' }),
    });
    expect(response.status).toBe(201);
  });
});
