/** בדיקות HTTP מקצה לקצה מול שכבת ה-API. */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import { createTestDb, makeMember, makeOrganization, typeId } from './helpers.js';

let db: Db;
let server: Server;
let baseUrl: string;
let orgId: number;
let memberId: number;

beforeAll(async () => {
  db = createTestDb();
  orgId = makeOrganization(db).id;
  memberId = makeMember(db).id;

  const app = createApp(db);
  server = await new Promise<Server>((resolve) => {
    const created = app.listen(0, () => resolve(created));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

describe('API', () => {
  it('מחזיר תקינות', async () => {
    const result = await call('GET', '/api/health');
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it('מריץ את תהליך התשלום המלא דרך ה-API', async () => {
    // שלב 1: התחייבות 1,800 ₪
    const created = await call('POST', '/api/commitments', {
      memberId,
      organizationId: orgId,
      commitmentTypeId: typeId(db, 'aliyah'),
      amountShekels: 1800,
    });
    expect(created.status).toBe(201);
    const commitmentId = created.body.commitment.id;
    expect(created.body.commitment.balanceAgorot).toBe(180_000);

    // שלב 2: תשלום 1,000 ₪
    const first = await call('POST', '/api/payments', {
      commitmentId,
      amountShekels: 1000,
      method: 'bank_transfer',
    });
    expect(first.status).toBe(201);
    expect(first.body.commitment.balanceAgorot).toBe(80_000);
    expect(first.body.commitment.status).toBe('partially_paid');
    expect(first.body.payment.receipt.number).toBeTruthy();

    // שלב 3: תשלום היתרה
    const second = await call('POST', '/api/payments', {
      commitmentId,
      amountShekels: 800,
      method: 'cash',
    });
    expect(second.body.commitment.status).toBe('paid');
    expect(second.body.commitment.balanceAgorot).toBe(0);

    // הקבלות זמינות במסך הקבלות
    const receipts = await call('GET', `/api/receipts?memberId=${memberId}`);
    expect(receipts.body.items).toHaveLength(2);

    // וגם בכרטיס החבר
    const card = await call('GET', `/api/members/${memberId}/card`);
    expect(card.body.receipts).toHaveLength(2);
    expect(card.body.totals.outstandingAgorot).toBe(0);
  });

  it('מחזיר שגיאה מובנת על קלט לא תקין', async () => {
    const result = await call('POST', '/api/payments', {
      organizationId: orgId,
      amountShekels: -5,
      method: 'cash',
    });
    expect(result.status).toBe(422);
    expect(result.body.error.message).toMatch(/גדול מאפס/);
  });

  it('מחזיר 404 על משאב שאינו קיים', async () => {
    const result = await call('GET', '/api/commitments/9999');
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('not_found');
  });

  it('מסך הגבייה מחזיר את כל החלקים בקריאה אחת', async () => {
    const result = await call('GET', `/api/collections?organizationId=${orgId}`);
    expect(result.status).toBe(200);
    for (const key of ['summary', 'debtors', 'aging', 'byOrganization', 'byEvent', 'byType', 'commitments']) {
      expect(result.body[key], `חסר ${key}`).toBeDefined();
    }
  });

  it('הדשבורד מחזיר כרטיסים עם קישורים', async () => {
    const result = await call('GET', '/api/dashboard');
    expect(result.body.headline.length).toBeGreaterThan(0);
    expect(result.body.collection.length).toBe(9);
    for (const card of [...result.body.headline, ...result.body.collection]) {
      expect(card.link).toMatch(/^#\//);
    }
  });

  it('מגיש את ממשק המשתמש', async () => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('אנשי מעשה');
    // הלוגו של בית המדרש מוגש כנכס סטטי.
    const logo = await fetch(`${baseUrl}/assets/logo.jpg`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toContain('image/jpeg');
  });

  it('מוריד PDF של קבלה', async () => {
    const receipts = await call('GET', `/api/receipts?status=issued&limit=1`);
    const receiptId = receipts.body.items[0].id;
    const response = await fetch(`${baseUrl}/api/receipts/${receiptId}/pdf`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
  });
});
