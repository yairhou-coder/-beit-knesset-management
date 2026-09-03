/**
 * תקציב: אומדן מתוכנן מול הוצאה בפועל.
 *
 * העיקרון שנבדק כאן הוא שהאומדן לעולם אינו הוצאה - הוא אינו נספר
 * בסיכומי ההוצאות, ואינו יוצר שום רשומה כספית.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import {
  createExpense,
  getBudgetReport,
  getExpenseSummary,
  listExpenseCategories,
  updateExpenseCategoryBudget,
} from '../src/services/expenses.js';
import { createTestDb, makeOrganization } from './helpers.js';

function categoryByKey(db: Db, key: string) {
  const category = listExpenseCategories(db).find((row) => row.key === key);
  if (!category) throw new Error(`קטגוריה ${key} לא נמצאה`);
  return category;
}

/** תאריך בתוך החודש הנוכחי, כדי שההוצאה תיכלל בטווח המדידה. */
function thisMonth(day: number): string {
  return `${new Date().toISOString().slice(0, 7)}-${String(day).padStart(2, '0')}`;
}

describe('תקציב הקהילה', () => {
  let db: Db;
  let orgId: number;

  beforeEach(() => {
    db = createTestDb();
    orgId = makeOrganization(db).id;
  });

  afterEach(() => db.close());

  it('הקטגוריות מרשימת ההוצאות של הגבאי נזרעות עם האומדנים שלהן', () => {
    expect(categoryByKey(db, 'kiddush').plannedAmountAgorot).toBe(shekelsToAgorot(11500));
    expect(categoryByKey(db, 'kiddush').plannedPeriod).toBe('monthly');
    expect(categoryByKey(db, 'cleaning').plannedAmountAgorot).toBe(shekelsToAgorot(3500));
    expect(categoryByKey(db, 'rabbi_salary').plannedAmountAgorot).toBe(shekelsToAgorot(3000));
    expect(categoryByKey(db, 'loan_repayment').plannedAmountAgorot).toBe(shekelsToAgorot(4000));
    expect(categoryByKey(db, 'holidays').plannedAmountAgorot).toBe(shekelsToAgorot(100000));
    expect(categoryByKey(db, 'holidays').plannedPeriod).toBe('yearly');
    expect(categoryByKey(db, 'special_events').plannedAmountAgorot).toBe(shekelsToAgorot(20000));
  });

  it('הקטגוריות שנמסרו ללא סכום קיימות, עם תדירות ובלי אומדן', () => {
    for (const key of ['permit_elevator', 'permit_electrician', 'permit_fire', 'accountant']) {
      const category = categoryByKey(db, key);
      expect(category.plannedAmountAgorot).toBeNull();
      expect(category.plannedPeriod).toBe('yearly');
    }
    expect(categoryByKey(db, 'fathers_and_sons').plannedAmountAgorot).toBeNull();
    expect(categoryByKey(db, 'repairs_damage').plannedPeriod).toBe('occasional');
  });

  it('אומדן שנתי נפרס לחודש, ואומדן "לפי הצורך" אינו נפרס', () => {
    const report = getBudgetReport(db, { organizationId: orgId });
    const holidays = report.lines.find((line) => line.name === 'חגים')!;
    expect(holidays.plannedMonthlyAgorot).toBe(shekelsToAgorot(100000 / 12));
    expect(holidays.plannedYearlyAgorot).toBe(shekelsToAgorot(100000 / 12) * 12);

    const repairs = report.lines.find((line) => line.name === 'תיקוני שבר ונזקים')!;
    expect(repairs.plannedMonthlyAgorot).toBeNull();
  });

  it('האומדן אינו הוצאה: הוא אינו נספר בסיכום ההוצאות', () => {
    const summary = getExpenseSummary(db, { organizationId: orgId });
    expect(summary.totalAgorot).toBe(0);
    expect(summary.count).toBe(0);

    const report = getBudgetReport(db, { organizationId: orgId });
    expect(report.plannedMonthlyAgorot).toBeGreaterThan(0);
    expect(report.actualMonthlyAgorot).toBe(0);
  });

  it('הוצאה שנרשמה מופיעה בעמודת הביצוע מול האומדן', () => {
    const cleaning = categoryByKey(db, 'cleaning');
    createExpense(db, {
      organizationId: orgId,
      categoryId: cleaning.id,
      amountAgorot: shekelsToAgorot(3600),
      expenseDate: thisMonth(5),
      supplier: 'שירותי ניקיון',
    });

    const line = getBudgetReport(db, { organizationId: orgId, months: 1 }).lines.find(
      (row) => row.categoryId === cleaning.id,
    )!;
    expect(line.actualAgorot).toBe(shekelsToAgorot(3600));
    expect(line.actualMonthlyAgorot).toBe(shekelsToAgorot(3600));
    expect(line.plannedMonthlyAgorot).toBe(shekelsToAgorot(3500));
    expect(line.expenseCount).toBe(1);
  });

  it('ההוצאה בפועל היא ממוצע על פני החודשים שנמדדו', () => {
    const cleaning = categoryByKey(db, 'cleaning');
    createExpense(db, {
      organizationId: orgId,
      categoryId: cleaning.id,
      amountAgorot: shekelsToAgorot(12000),
      expenseDate: thisMonth(5),
    });

    const report = getBudgetReport(db, { organizationId: orgId, months: 12 });
    const line = report.lines.find((row) => row.categoryId === cleaning.id)!;
    expect(line.actualAgorot).toBe(shekelsToAgorot(12000));
    expect(line.actualMonthlyAgorot).toBe(shekelsToAgorot(1000));
  });

  it('עדכון האומדן משנה את התחזית ואינו נוגע להוצאות שנרשמו', () => {
    const insurance = categoryByKey(db, 'insurance');
    createExpense(db, {
      organizationId: orgId,
      categoryId: insurance.id,
      amountAgorot: shekelsToAgorot(9000),
      expenseDate: thisMonth(3),
    });

    const updated = updateExpenseCategoryBudget(db, insurance.id, {
      plannedAmountAgorot: shekelsToAgorot(12000),
      plannedPeriod: 'yearly',
      plannedNote: 'לפי ההצעה החדשה',
    });
    expect(updated.plannedAmountAgorot).toBe(shekelsToAgorot(12000));

    const line = getBudgetReport(db, { organizationId: orgId, months: 1 }).lines.find(
      (row) => row.categoryId === insurance.id,
    )!;
    expect(line.plannedMonthlyAgorot).toBe(shekelsToAgorot(1000));
    // ההוצאה שנרשמה נשארה כפי שהיא
    expect(line.actualAgorot).toBe(shekelsToAgorot(9000));
  });

  it('ביטול אומדן וסכום שלילי', () => {
    const cleaning = categoryByKey(db, 'cleaning');
    expect(updateExpenseCategoryBudget(db, cleaning.id, { plannedAmountAgorot: null })
      .plannedAmountAgorot).toBeNull();
    expect(() =>
      updateExpenseCategoryBudget(db, cleaning.id, { plannedAmountAgorot: -100 }),
    ).toThrow(/שאינו שלילי/);
    expect(() =>
      // @ts-expect-error - בדיקה של קלט לא תקין מהממשק
      updateExpenseCategoryBudget(db, cleaning.id, { plannedPeriod: 'weekly' }),
    ).toThrow(/תדירות לא מוכרת/);
  });

  it('סינון לפי עמותה: הוצאה של עמותה אחרת אינה נספרת', () => {
    const other = makeOrganization(db, { name: 'אחוות תורה' }).id;
    const cleaning = categoryByKey(db, 'cleaning');
    createExpense(db, {
      organizationId: other,
      categoryId: cleaning.id,
      amountAgorot: shekelsToAgorot(5000),
      expenseDate: thisMonth(7),
    });

    const mine = getBudgetReport(db, { organizationId: orgId, months: 1 }).lines.find(
      (row) => row.categoryId === cleaning.id,
    )!;
    expect(mine.actualAgorot).toBe(0);

    const theirs = getBudgetReport(db, { organizationId: other, months: 1 }).lines.find(
      (row) => row.categoryId === cleaning.id,
    )!;
    expect(theirs.actualAgorot).toBe(shekelsToAgorot(5000));
  });
});
