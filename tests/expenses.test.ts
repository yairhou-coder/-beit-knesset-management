/** מודול ההוצאות: קטגוריות, פילוחים, שיוך לאירוע וצירוף חשבוניות. */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import {
  createExpense,
  deleteExpense,
  getExpenseSummary,
  listExpenseCategories,
  listExpenses,
  updateExpense,
} from '../src/services/expenses.js';
import { attachToExpense, decodeUpload, readAttachment } from '../src/services/attachments.js';
import { createEvent } from '../src/services/catalog.js';
import { createTestDb, makeOrganization } from './helpers.js';

describe('הוצאות', () => {
  let db: Db;
  let orgId: number;
  const categoryOf = (key: string): number =>
    listExpenseCategories(db).find((category) => category.key === key)!.id;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
  });

  afterEach(() => db.close());

  it('קטגוריות ברירת המחדל מכסות את סוגי ההוצאה של הקהילה', () => {
    const categories = listExpenseCategories(db);
    const keys = categories.map((category) => category.key);
    expect(keys).toContain('rabbi_salary');
    expect(keys).toContain('kiddush');
    expect(keys).toContain('cleaning');
    expect(keys).toContain('holidays');

    const kinds = new Set(categories.map((category) => category.kind));
    expect(kinds).toContain('salary');
    expect(kinds).toContain('ongoing');
    expect(kinds).toContain('events');
  });

  it('רישום הוצאה ושיוכה לקטגוריה', () => {
    const expense = createExpense(db, {
      organizationId: orgId,
      categoryId: categoryOf('rabbi_salary'),
      amountAgorot: shekelsToAgorot(8000),
      expenseDate: '2026-08-01',
      description: 'משכורת אוגוסט',
    });

    expect(expense.amountAgorot).toBe(800_000);
    expect(expense.category.name).toBe('משכורת הרב');
    expect(expense.category.kind).toBe('salary');
    expect(expense.category.kindLabel).toBe('משכורות');
  });

  it('הפילוח מראה לאן הכסף יוצא', () => {
    createExpense(db, { organizationId: orgId, categoryId: categoryOf('rabbi_salary'), amountAgorot: shekelsToAgorot(8000) });
    createExpense(db, { organizationId: orgId, categoryId: categoryOf('cleaning'), amountAgorot: shekelsToAgorot(1800) });
    createExpense(db, { organizationId: orgId, categoryId: categoryOf('kiddush'), amountAgorot: shekelsToAgorot(700) });

    const summary = getExpenseSummary(db);
    expect(summary.totalAgorot).toBe(1_050_000);
    expect(summary.count).toBe(3);

    const byKind = Object.fromEntries(summary.byKind.map((row) => [row.label, row.amountAgorot]));
    expect(byKind['משכורות']).toBe(800_000);
    expect(byKind['הוצאות שוטפות']).toBe(250_000);

    const salaryShare = summary.byKind.find((row) => row.label === 'משכורות')!.share;
    expect(salaryShare).toBeCloseTo(76.2, 1);
  });

  it('הוצאה משויכת לאירוע, וניתן לראות כמה עלה האירוע', () => {
    const event = createEvent(db, { name: 'ראש השנה', kind: 'holiday', organizationId: orgId });
    createExpense(db, {
      organizationId: orgId,
      categoryId: categoryOf('holidays'),
      eventId: event.id,
      amountAgorot: shekelsToAgorot(6800),
      description: 'סעודות',
    });
    createExpense(db, {
      organizationId: orgId,
      categoryId: categoryOf('meals'),
      eventId: event.id,
      amountAgorot: shekelsToAgorot(2400),
    });

    const byEvent = getExpenseSummary(db).byEvent;
    expect(byEvent.find((row) => row.label === 'ראש השנה')?.amountAgorot).toBe(920_000);
    expect(listExpenses(db, { eventId: event.id })).toHaveLength(2);
  });

  it('סינון לפי סוג, קטגוריה ותאריך', () => {
    createExpense(db, { organizationId: orgId, categoryId: categoryOf('rabbi_salary'), amountAgorot: shekelsToAgorot(8000), expenseDate: '2026-07-01' });
    createExpense(db, { organizationId: orgId, categoryId: categoryOf('cleaning'), amountAgorot: shekelsToAgorot(1800), expenseDate: '2026-08-05' });

    expect(listExpenses(db, { kind: 'salary' })).toHaveLength(1);
    expect(listExpenses(db, { categoryId: categoryOf('cleaning') })).toHaveLength(1);
    expect(listExpenses(db, { fromDate: '2026-08-01' })).toHaveLength(1);
    expect(listExpenses(db, { minAmountAgorot: shekelsToAgorot(5000) })).toHaveLength(1);
  });

  it('צירוף חשבונית להוצאה, והורדתה', () => {
    const expense = createExpense(db, {
      organizationId: orgId,
      categoryId: categoryOf('cleaning'),
      amountAgorot: shekelsToAgorot(1800),
    });

    const file = decodeUpload({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 test invoice', 'latin1').toString('base64'),
    });
    const attachment = attachToExpense(db, expense.id, file);

    expect(attachment.filename).toBe('invoice.pdf');
    expect(listExpenses(db)[0]!.attachments).toHaveLength(1);
    expect(readAttachment(db, attachment.id).data.toString('latin1')).toContain('%PDF');

    // הוצאות ללא חשבונית מזוהות בנפרד, לצורך מעקב
    expect(getExpenseSummary(db).missingInvoice.count).toBe(0);
    createExpense(db, { organizationId: orgId, categoryId: categoryOf('water'), amountAgorot: shekelsToAgorot(320) });
    expect(getExpenseSummary(db).missingInvoice.count).toBe(1);
    expect(listExpenses(db, { withAttachment: false })).toHaveLength(1);
  });

  it('דוחה סוג קובץ שאינו נתמך וקובץ גדול מדי', () => {
    expect(() =>
      decodeUpload({ filename: 'a.exe', mimeType: 'application/x-msdownload', dataBase64: 'AAAA' }),
    ).toThrow(/שאינו נתמך/);

    const huge = Buffer.alloc(16 * 1024 * 1024).toString('base64');
    expect(() =>
      decodeUpload({ filename: 'big.pdf', mimeType: 'application/pdf', dataBase64: huge }),
    ).toThrow(/גדול מדי/);
  });

  it('עדכון ומחיקה של הוצאה', () => {
    const expense = createExpense(db, {
      organizationId: orgId,
      categoryId: categoryOf('cleaning'),
      amountAgorot: shekelsToAgorot(1800),
    });

    const updated = updateExpense(db, expense.id, {
      amountAgorot: shekelsToAgorot(2000),
      categoryId: categoryOf('maintenance'),
      supplier: 'חשמלאי',
    });
    expect(updated.amountAgorot).toBe(200_000);
    expect(updated.category.name).toBe('תחזוקה ותיקונים');
    expect(updated.supplier).toBe('חשמלאי');

    deleteExpense(db, expense.id);
    expect(listExpenses(db)).toHaveLength(0);
  });

  it('סכום הוצאה חייב להיות חיובי', () => {
    expect(() =>
      createExpense(db, {
        organizationId: orgId,
        categoryId: categoryOf('cleaning'),
        amountAgorot: 0,
      }),
    ).toThrow(/גדול מאפס/);
  });
});
