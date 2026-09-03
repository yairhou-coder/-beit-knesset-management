/**
 * ניהול הוצאות הקהילה.
 *
 * ההוצאות מקובצות לפי אופי - משכורות, הוצאות שוטפות, חגים ואירועים,
 * תחזוקה ואחר - כדי שניתן יהיה לראות לא רק כמה יצא, אלא לאן.
 * הוצאה יכולה להיות משויכת לאירוע, וכך רואים כמה עלה חג או אירוע מסוים.
 *
 * לכל הוצאה ניתן לצרף חשבוניות (ראו attachments.ts).
 */

import type { Db } from '../db/index.js';
import { assertPositiveAgorot } from '../domain/money.js';
import { NotFoundError, ValidationError } from './errors.js';
import { WhereBuilder, safeOrderBy, today } from './util.js';

export const EXPENSE_KINDS = ['salary', 'ongoing', 'events', 'maintenance', 'other'] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

export const EXPENSE_KIND_LABELS: Record<ExpenseKind, string> = {
  salary: 'משכורות',
  ongoing: 'הוצאות שוטפות',
  events: 'חגים ואירועים',
  maintenance: 'תחזוקה',
  other: 'אחר',
};

// ---------------------------------------------------------------------------
// קטגוריות
// ---------------------------------------------------------------------------

/** תדירות ההוצאה המתוכננת. */
export const PLANNED_PERIODS = ['monthly', 'yearly', 'occasional'] as const;
export type PlannedPeriod = (typeof PLANNED_PERIODS)[number];

export const PLANNED_PERIOD_LABELS: Record<PlannedPeriod, string> = {
  monthly: 'חודשי',
  yearly: 'שנתי',
  occasional: 'לפי הצורך',
};

export interface ExpenseCategoryView {
  id: number;
  key: string;
  name: string;
  kind: ExpenseKind;
  kindLabel: string;
  active: boolean;
  /** אומדן ההוצאה לקטגוריה, כפי שנמסר. אינו הוצאה בפועל. */
  plannedAmountAgorot: number | null;
  plannedPeriod: PlannedPeriod | null;
  plannedPeriodLabel: string | null;
  plannedNote: string | null;
}

interface ExpenseCategoryRow {
  id: number;
  key: string;
  name: string;
  kind: ExpenseKind;
  active: number;
  sort_order: number;
  planned_amount_agorot: number | null;
  planned_period: PlannedPeriod | null;
  planned_note: string | null;
}

function toCategoryView(row: ExpenseCategoryRow): ExpenseCategoryView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    kindLabel: EXPENSE_KIND_LABELS[row.kind] ?? row.kind,
    active: row.active === 1,
    plannedAmountAgorot: row.planned_amount_agorot,
    plannedPeriod: row.planned_period,
    plannedPeriodLabel: row.planned_period
      ? (PLANNED_PERIOD_LABELS[row.planned_period] ?? row.planned_period)
      : null,
    plannedNote: row.planned_note,
  };
}

export function listExpenseCategories(db: Db, includeInactive = false): ExpenseCategoryView[] {
  const rows = db
    .prepare(
      `SELECT * FROM expense_categories ${includeInactive ? '' : 'WHERE active = 1'}
       ORDER BY sort_order, name`,
    )
    .all() as ExpenseCategoryRow[];
  return rows.map(toCategoryView);
}

export interface ExpenseCategoryInput {
  key?: string;
  name: string;
  kind?: ExpenseKind;
  sortOrder?: number;
  plannedAmountAgorot?: number | null;
  plannedPeriod?: PlannedPeriod | null;
  plannedNote?: string | null;
}

export function createExpenseCategory(db: Db, input: ExpenseCategoryInput): ExpenseCategoryView {
  if (!input.name?.trim()) throw new ValidationError('שם הקטגוריה הוא שדה חובה');
  const kind = input.kind ?? 'ongoing';
  if (!EXPENSE_KINDS.includes(kind)) throw new ValidationError(`אופי הוצאה לא מוכר: ${kind}`);
  assertPlannedPeriod(input.plannedPeriod);

  // מפתח נגזר מהשם כאשר לא סופק, כדי שהוספה מהממשק לא תדרוש מפתח טכני
  const key = input.key?.trim() || `cat_${Date.now().toString(36)}`;
  const result = db
    .prepare(
      `INSERT INTO expense_categories
         (key, name, kind, sort_order, planned_amount_agorot, planned_period, planned_note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      key,
      input.name.trim(),
      kind,
      input.sortOrder ?? 500,
      input.plannedAmountAgorot ?? null,
      input.plannedPeriod ?? null,
      input.plannedNote ?? null,
    );
  const row = db
    .prepare('SELECT * FROM expense_categories WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as ExpenseCategoryRow;
  return toCategoryView(row);
}

function assertPlannedPeriod(period: PlannedPeriod | null | undefined): void {
  if (period && !PLANNED_PERIODS.includes(period)) {
    throw new ValidationError(`תדירות לא מוכרת: ${period}`);
  }
}

/**
 * עדכון האומדן התקציבי של קטגוריה.
 *
 * האומדן הוא הערכה בלבד ואינו נרשם כהוצאה. שינוי שלו אינו נוגע
 * לאף הוצאה שכבר נרשמה.
 */
export function updateExpenseCategoryBudget(
  db: Db,
  id: number,
  patch: {
    plannedAmountAgorot?: number | null;
    plannedPeriod?: PlannedPeriod | null;
    plannedNote?: string | null;
  },
): ExpenseCategoryView {
  getCategoryRow(db, id);
  assertPlannedPeriod(patch.plannedPeriod);
  if (
    patch.plannedAmountAgorot !== undefined &&
    patch.plannedAmountAgorot !== null &&
    (!Number.isInteger(patch.plannedAmountAgorot) || patch.plannedAmountAgorot < 0)
  ) {
    throw new ValidationError('האומדן חייב להיות סכום שאינו שלילי');
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.plannedAmountAgorot !== undefined) {
    sets.push('planned_amount_agorot = ?');
    values.push(patch.plannedAmountAgorot);
  }
  if (patch.plannedPeriod !== undefined) {
    sets.push('planned_period = ?');
    values.push(patch.plannedPeriod);
  }
  if (patch.plannedNote !== undefined) {
    sets.push('planned_note = ?');
    values.push(patch.plannedNote);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE expense_categories SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }
  return toCategoryView(getCategoryRow(db, id));
}

function getCategoryRow(db: Db, id: number): ExpenseCategoryRow {
  const row = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id) as
    | ExpenseCategoryRow
    | undefined;
  if (!row) throw new NotFoundError(`קטגוריית הוצאה ${id}`);
  return row;
}

// ---------------------------------------------------------------------------
// הוצאות
// ---------------------------------------------------------------------------

export interface ExpenseView {
  id: number;
  organization: { id: number; name: string };
  category: { id: number | null; name: string; kind: ExpenseKind | null; kindLabel: string | null };
  event: { id: number; name: string } | null;
  supplier: string | null;
  amountAgorot: number;
  expenseDate: string;
  method: string | null;
  invoiceNumber: string | null;
  description: string | null;
  notes: string | null;
  attachments: Array<{ id: number; filename: string; mimeType: string; sizeBytes: number }>;
  createdAt: string;
}

interface ExpenseJoinedRow {
  id: number;
  organization_id: number;
  organization_name: string;
  category_id: number | null;
  category: string;
  category_name: string | null;
  category_kind: ExpenseKind | null;
  event_id: number | null;
  event_name: string | null;
  supplier: string | null;
  amount_agorot: number;
  expense_date: string;
  method: string | null;
  invoice_number: string | null;
  description: string | null;
  notes: string | null;
  created_at: string;
}

const JOINED_SELECT = `
  SELECT e.*, o.name AS organization_name,
         ec.name AS category_name, ec.kind AS category_kind,
         ev.name AS event_name
  FROM expenses e
  JOIN organizations o ON o.id = e.organization_id
  LEFT JOIN expense_categories ec ON ec.id = e.category_id
  LEFT JOIN events ev ON ev.id = e.event_id
`;

const SORT_COLUMNS: Record<string, string> = {
  date: 'e.expense_date',
  amount: 'e.amount_agorot',
  category: 'ec.name',
  supplier: 'e.supplier',
};

function attachmentsFor(db: Db, expenseId: number): ExpenseView['attachments'] {
  return (
    db
      .prepare(
        `SELECT id, filename, mime_type, size_bytes FROM expense_attachments
         WHERE expense_id = ? ORDER BY id`,
      )
      .all(expenseId) as Array<{
      id: number;
      filename: string;
      mime_type: string;
      size_bytes: number;
    }>
  ).map((row) => ({
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
  }));
}

function toView(db: Db, row: ExpenseJoinedRow): ExpenseView {
  return {
    id: row.id,
    organization: { id: row.organization_id, name: row.organization_name },
    category: {
      id: row.category_id,
      name: row.category_name ?? row.category,
      kind: row.category_kind,
      kindLabel: row.category_kind ? EXPENSE_KIND_LABELS[row.category_kind] : null,
    },
    event: row.event_id && row.event_name ? { id: row.event_id, name: row.event_name } : null,
    supplier: row.supplier,
    amountAgorot: row.amount_agorot,
    expenseDate: row.expense_date,
    method: row.method,
    invoiceNumber: row.invoice_number,
    description: row.description,
    notes: row.notes,
    attachments: attachmentsFor(db, row.id),
    createdAt: row.created_at,
  };
}

export interface ExpenseFilters {
  organizationId?: number;
  categoryId?: number;
  kind?: ExpenseKind;
  eventId?: number;
  supplier?: string;
  search?: string;
  fromDate?: string;
  toDate?: string;
  minAmountAgorot?: number;
  maxAmountAgorot?: number;
  /** רק הוצאות שיש/אין להן חשבונית מצורפת. */
  withAttachment?: boolean;
  sort?: string;
  limit?: number;
  offset?: number;
}

function buildWhere(filters: ExpenseFilters): WhereBuilder {
  const where = new WhereBuilder();
  where.addIf(filters.organizationId, 'e.organization_id = ?', filters.organizationId);
  where.addIf(filters.categoryId, 'e.category_id = ?', filters.categoryId);
  where.addIf(filters.kind, 'ec.kind = ?', filters.kind);
  where.addIf(filters.eventId, 'e.event_id = ?', filters.eventId);
  where.addIf(filters.fromDate, 'e.expense_date >= ?', filters.fromDate);
  where.addIf(filters.toDate, 'e.expense_date <= ?', filters.toDate);
  where.addIf(filters.minAmountAgorot, 'e.amount_agorot >= ?', filters.minAmountAgorot);
  where.addIf(filters.maxAmountAgorot, 'e.amount_agorot <= ?', filters.maxAmountAgorot);
  if (filters.supplier?.trim()) where.add('e.supplier LIKE ?', `%${filters.supplier.trim()}%`);
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    where.add(
      '(e.supplier LIKE ? OR e.description LIKE ? OR e.invoice_number LIKE ? OR e.notes LIKE ?)',
      term,
      term,
      term,
      term,
    );
  }
  if (filters.withAttachment === true) {
    where.add('EXISTS (SELECT 1 FROM expense_attachments a WHERE a.expense_id = e.id)');
  } else if (filters.withAttachment === false) {
    where.add('NOT EXISTS (SELECT 1 FROM expense_attachments a WHERE a.expense_id = e.id)');
  }
  return where;
}

export function listExpenses(db: Db, filters: ExpenseFilters = {}): ExpenseView[] {
  const where = buildWhere(filters);
  const rows = db
    .prepare(
      `${JOINED_SELECT} ${where.sql}
       ORDER BY ${safeOrderBy(filters.sort, SORT_COLUMNS, 'e.expense_date DESC, e.id DESC')}
       LIMIT ? OFFSET ?`,
    )
    .all(
      ...where.values,
      Math.min(Math.max(filters.limit ?? 200, 1), 1000),
      Math.max(filters.offset ?? 0, 0),
    ) as ExpenseJoinedRow[];
  return rows.map((row) => toView(db, row));
}

export function getExpense(db: Db, id: number): ExpenseView {
  const row = db.prepare(`${JOINED_SELECT} WHERE e.id = ?`).get(id) as ExpenseJoinedRow | undefined;
  if (!row) throw new NotFoundError(`הוצאה ${id}`);
  return toView(db, row);
}

export interface ExpenseInput {
  organizationId: number;
  categoryId: number;
  eventId?: number | null;
  supplier?: string | null;
  amountAgorot: number;
  expenseDate?: string;
  method?: string | null;
  invoiceNumber?: string | null;
  description?: string | null;
  notes?: string | null;
}

export function createExpense(db: Db, input: ExpenseInput): ExpenseView {
  assertPositiveAgorot(input.amountAgorot, 'סכום ההוצאה');
  const category = getCategoryRow(db, input.categoryId);

  // אירוע, אם צוין, חייב להשתייך לאותה עמותה או להיות כלל-קהילתי
  if (input.eventId) {
    const event = db.prepare('SELECT organization_id FROM events WHERE id = ?').get(input.eventId) as
      | { organization_id: number | null }
      | undefined;
    if (!event) throw new NotFoundError(`אירוע ${input.eventId}`);
    if (event.organization_id !== null && event.organization_id !== input.organizationId) {
      throw new ValidationError('האירוע משויך לעמותה אחרת');
    }
  }

  const result = db
    .prepare(
      `INSERT INTO expenses
         (organization_id, category_id, category, event_id, supplier, amount_agorot,
          expense_date, method, invoice_number, description, notes, updated_at)
       VALUES (@organization_id, @category_id, @category, @event_id, @supplier, @amount_agorot,
               @expense_date, @method, @invoice_number, @description, @notes, datetime('now'))`,
    )
    .run({
      organization_id: input.organizationId,
      category_id: category.id,
      category: category.name,
      event_id: input.eventId ?? null,
      supplier: input.supplier ?? null,
      amount_agorot: input.amountAgorot,
      expense_date: input.expenseDate ?? today(),
      method: input.method ?? null,
      invoice_number: input.invoiceNumber ?? null,
      description: input.description ?? null,
      notes: input.notes ?? null,
    });

  return getExpense(db, Number(result.lastInsertRowid));
}

export function updateExpense(db: Db, id: number, input: Partial<ExpenseInput>): ExpenseView {
  const existing = getExpense(db, id);
  const categoryId = input.categoryId ?? existing.category.id;
  if (!categoryId) throw new ValidationError('יש לבחור קטגוריה');
  const category = getCategoryRow(db, categoryId);

  const amount = input.amountAgorot ?? existing.amountAgorot;
  assertPositiveAgorot(amount, 'סכום ההוצאה');

  db.prepare(
    `UPDATE expenses SET
       organization_id = @organization_id, category_id = @category_id, category = @category,
       event_id = @event_id, supplier = @supplier, amount_agorot = @amount_agorot,
       expense_date = @expense_date, method = @method, invoice_number = @invoice_number,
       description = @description, notes = @notes, updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id,
    organization_id: input.organizationId ?? existing.organization.id,
    category_id: category.id,
    category: category.name,
    event_id: input.eventId !== undefined ? input.eventId : existing.event?.id ?? null,
    supplier: input.supplier !== undefined ? input.supplier : existing.supplier,
    amount_agorot: amount,
    expense_date: input.expenseDate ?? existing.expenseDate,
    method: input.method !== undefined ? input.method : existing.method,
    invoice_number: input.invoiceNumber !== undefined ? input.invoiceNumber : existing.invoiceNumber,
    description: input.description !== undefined ? input.description : existing.description,
    notes: input.notes !== undefined ? input.notes : existing.notes,
  });

  return getExpense(db, id);
}

export function deleteExpense(db: Db, id: number): void {
  getExpense(db, id); // מוודא קיום, ומחזיר שגיאה ברורה אם אינה קיימת
  db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// סיכומים - לאן הכסף יוצא
// ---------------------------------------------------------------------------

export interface ExpenseBreakdownRow {
  id: number | null;
  label: string;
  amountAgorot: number;
  count: number;
  /** אחוז מסך ההוצאות בטווח. */
  share: number;
}

export interface ExpenseSummary {
  totalAgorot: number;
  count: number;
  byKind: ExpenseBreakdownRow[];
  byCategory: ExpenseBreakdownRow[];
  byEvent: ExpenseBreakdownRow[];
  byMonth: Array<{ month: string; amountAgorot: number; count: number }>;
  missingInvoice: { count: number; amountAgorot: number };
}

function withShare(
  rows: Array<{ id: number | null; label: string | null; amount: number; count: number }>,
  total: number,
): ExpenseBreakdownRow[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label ?? 'ללא שיוך',
    amountAgorot: row.amount,
    count: row.count,
    share: total > 0 ? Math.round((row.amount / total) * 1000) / 10 : 0,
  }));
}

export function getExpenseSummary(db: Db, filters: ExpenseFilters = {}): ExpenseSummary {
  const where = buildWhere(filters);
  const base = `FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    LEFT JOIN events ev ON ev.id = e.event_id
    ${where.sql}`;

  const totals = db
    .prepare(`SELECT COALESCE(SUM(e.amount_agorot), 0) AS amount, COUNT(*) AS count ${base}`)
    .get(...where.values) as { amount: number; count: number };

  const group = (columns: string, groupBy: string) =>
    db
      .prepare(`SELECT ${columns} ${base} GROUP BY ${groupBy} ORDER BY amount DESC`)
      .all(...where.values) as Array<{
      id: number | null;
      label: string | null;
      amount: number;
      count: number;
    }>;

  const byKind = group(
    "ec.kind AS id, ec.kind AS label, COALESCE(SUM(e.amount_agorot),0) AS amount, COUNT(*) AS count",
    'ec.kind',
  ).map((row) => ({
    ...row,
    label: row.label ? (EXPENSE_KIND_LABELS[row.label as ExpenseKind] ?? row.label) : 'ללא קטגוריה',
  }));

  const byCategory = group(
    'e.category_id AS id, COALESCE(ec.name, e.category) AS label, COALESCE(SUM(e.amount_agorot),0) AS amount, COUNT(*) AS count',
    'e.category_id, label',
  );

  const byEvent = group(
    "e.event_id AS id, COALESCE(ev.name, 'ללא אירוע') AS label, COALESCE(SUM(e.amount_agorot),0) AS amount, COUNT(*) AS count",
    'e.event_id, label',
  );

  const byMonth = (
    db
      .prepare(
        `SELECT substr(e.expense_date, 1, 7) AS month,
                COALESCE(SUM(e.amount_agorot), 0) AS amount, COUNT(*) AS count
         ${base} GROUP BY month ORDER BY month DESC LIMIT 24`,
      )
      .all(...where.values) as Array<{ month: string; amount: number; count: number }>
  ).map((row) => ({ month: row.month, amountAgorot: row.amount, count: row.count }));

  const missing = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(e.amount_agorot), 0) AS amount ${base}
       ${where.sql ? 'AND' : 'WHERE'} NOT EXISTS
         (SELECT 1 FROM expense_attachments a WHERE a.expense_id = e.id)`,
    )
    .get(...where.values) as { count: number; amount: number };

  return {
    totalAgorot: totals.amount,
    count: totals.count,
    byKind: withShare(byKind, totals.amount),
    byCategory: withShare(byCategory, totals.amount),
    byEvent: withShare(byEvent, totals.amount),
    byMonth,
    missingInvoice: { count: missing.count, amountAgorot: missing.amount },
  };
}

// ---------------------------------------------------------------------------
// תקציב - אומדן מול הוצאה בפועל
// ---------------------------------------------------------------------------

/**
 * שורת תקציב אחת: מה תוכנן, ומה יצא בפועל.
 *
 * האומדן והביצוע מיושרים לאותה יחידה - חודש - כדי שיהיה אפשר להשוות
 * ביניהם. הוצאה שנתית מחולקת ב-12, וההוצאה בפועל מחושבת כממוצע חודשי
 * על פני החודשים שנמדדו. זהו קירוב, וכך הוא מוצג.
 */
export interface BudgetLine {
  categoryId: number;
  name: string;
  kind: ExpenseKind;
  kindLabel: string;
  plannedAmountAgorot: number | null;
  plannedPeriod: PlannedPeriod | null;
  plannedPeriodLabel: string | null;
  plannedNote: string | null;
  /** האומדן בשקלול חודשי - הבסיס להשוואה. */
  plannedMonthlyAgorot: number | null;
  plannedYearlyAgorot: number | null;
  /** ההוצאה בפועל בטווח שנמדד, והממוצע החודשי שלה. */
  actualAgorot: number;
  actualMonthlyAgorot: number;
  expenseCount: number;
}

export interface BudgetReport {
  /** מספר החודשים שנכללו בחישוב ההוצאה בפועל. */
  monthsMeasured: number;
  lines: BudgetLine[];
  plannedMonthlyAgorot: number;
  plannedYearlyAgorot: number;
  actualMonthlyAgorot: number;
  /** כמה קטגוריות עדיין ללא אומדן - כדי שיהיה ברור מה חסר. */
  withoutPlanCount: number;
}

/**
 * מייצר את דוח התקציב.
 *
 * `months` קובע על פני כמה חודשים אחרונים נמדדת ההוצאה בפועל.
 * ברירת המחדל היא 12 חודשים, כדי שהוצאות עונתיות - חגים למשל -
 * ייכללו בממוצע ולא יעוותו אותו.
 */
export function getBudgetReport(
  db: Db,
  options: { organizationId?: number; months?: number } = {},
): BudgetReport {
  const months = Math.max(1, options.months ?? 12);

  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - (months - 1), 1);
  const fromDate = since.toISOString().slice(0, 10);

  const where = new WhereBuilder();
  where.add('e.expense_date >= ?', fromDate);
  where.addIf(options.organizationId, 'e.organization_id = ?', options.organizationId);

  const actuals = db
    .prepare(
      `SELECT e.category_id AS id,
              COALESCE(SUM(e.amount_agorot), 0) AS amount,
              COUNT(*) AS count
         FROM expenses e ${where.sql}
        GROUP BY e.category_id`,
    )
    .all(...where.values) as Array<{ id: number | null; amount: number; count: number }>;
  const actualByCategory = new Map(actuals.map((row) => [row.id, row]));

  const categories = db
    .prepare('SELECT * FROM expense_categories WHERE active = 1 ORDER BY sort_order, name')
    .all() as ExpenseCategoryRow[];

  const lines: BudgetLine[] = categories.map((row) => {
    const actual = actualByCategory.get(row.id);
    const actualAgorot = actual?.amount ?? 0;

    // אומדן "לפי הצורך" אינו ניתן לפריסה חודשית, ולכן הוא נשאר ריק.
    const plannedMonthlyAgorot =
      row.planned_amount_agorot === null
        ? null
        : row.planned_period === 'monthly'
          ? row.planned_amount_agorot
          : row.planned_period === 'yearly'
            ? Math.round(row.planned_amount_agorot / 12)
            : null;

    return {
      categoryId: row.id,
      name: row.name,
      kind: row.kind,
      kindLabel: EXPENSE_KIND_LABELS[row.kind] ?? row.kind,
      plannedAmountAgorot: row.planned_amount_agorot,
      plannedPeriod: row.planned_period,
      plannedPeriodLabel: row.planned_period
        ? (PLANNED_PERIOD_LABELS[row.planned_period] ?? row.planned_period)
        : null,
      plannedNote: row.planned_note,
      plannedMonthlyAgorot,
      plannedYearlyAgorot: plannedMonthlyAgorot === null ? null : plannedMonthlyAgorot * 12,
      actualAgorot,
      actualMonthlyAgorot: Math.round(actualAgorot / months),
      expenseCount: actual?.count ?? 0,
    };
  });

  const sum = (pick: (line: BudgetLine) => number | null): number =>
    lines.reduce((total, line) => total + (pick(line) ?? 0), 0);

  return {
    monthsMeasured: months,
    lines,
    plannedMonthlyAgorot: sum((line) => line.plannedMonthlyAgorot),
    plannedYearlyAgorot: sum((line) => line.plannedYearlyAgorot),
    actualMonthlyAgorot: sum((line) => line.actualMonthlyAgorot),
    withoutPlanCount: lines.filter((line) => line.plannedAmountAgorot === null).length,
  };
}
