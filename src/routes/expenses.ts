import { Router } from 'express';
import type { Db } from '../db/index.js';
import {
  createExpense,
  createExpenseCategory,
  deleteExpense,
  getBudgetReport,
  getExpense,
  getExpenseSummary,
  listExpenseCategories,
  listExpenses,
  updateExpense,
  updateExpenseCategoryBudget,
  type ExpenseFilters,
  type ExpenseKind,
  type PlannedPeriod,
} from '../services/expenses.js';
import {
  attachToExpense,
  decodeUpload,
  deleteAttachment,
  invoiceProviderInfo,
  readAttachment,
  suggestFromInvoice,
} from '../services/attachments.js';
import {
  asyncHandler,
  body,
  intParam,
  optionalAmountAgorot,
  optionalBool,
  optionalInt,
  optionalString,
  readAmountAgorot,
} from './helpers.js';

function parseFilters(query: Record<string, unknown>): ExpenseFilters {
  const filters: ExpenseFilters = {};
  const assign = <K extends keyof ExpenseFilters>(key: K, value: ExpenseFilters[K]) => {
    if (value !== undefined) filters[key] = value;
  };
  assign('organizationId', optionalInt(query['organizationId']));
  assign('categoryId', optionalInt(query['categoryId']));
  assign('kind', optionalString(query['kind']) as ExpenseKind | undefined);
  assign('eventId', optionalInt(query['eventId']));
  assign('supplier', optionalString(query['supplier']));
  assign('search', optionalString(query['search']));
  assign('fromDate', optionalString(query['fromDate']));
  assign('toDate', optionalString(query['toDate']));
  assign('minAmountAgorot', optionalAmountAgorot(query['minAmountAgorot']));
  assign('maxAmountAgorot', optionalAmountAgorot(query['maxAmountAgorot']));
  assign('sort', optionalString(query['sort']));
  assign('limit', optionalInt(query['limit']));
  assign('offset', optionalInt(query['offset']));
  const withAttachment = optionalBool(query['withAttachment']);
  if (withAttachment !== undefined) filters.withAttachment = withAttachment;
  return filters;
}

export function createExpensesRouter(db: Db): Router {
  const router = Router();

  router.get('/categories', (_req, res) => {
    res.json({ items: listExpenseCategories(db) });
  });

  router.post('/categories', (req, res) => {
    const input = body(req);
    res.status(201).json({
      category: createExpenseCategory(db, {
        name: String(input['name'] ?? ''),
        ...(optionalString(input['kind']) ? { kind: optionalString(input['kind']) as ExpenseKind } : {}),
        plannedAmountAgorot:
          input['plannedAmountAgorot'] !== undefined || input['plannedShekels'] !== undefined
            ? readAmountAgorot(
                {
                  amountAgorot: input['plannedAmountAgorot'],
                  amountShekels: input['plannedShekels'],
                },
                'אומדן ההוצאה',
              )
            : null,
        plannedPeriod: (optionalString(input['plannedPeriod']) as PlannedPeriod) ?? null,
        plannedNote: optionalString(input['plannedNote']) ?? null,
      }),
    });
  });

  /** עדכון האומדן התקציבי של קטגוריה. אינו נוגע להוצאות שנרשמו. */
  router.patch('/categories/:id', (req, res) => {
    const input = body(req);
    const patch: Parameters<typeof updateExpenseCategoryBudget>[2] = {};
    if (input['plannedAmountAgorot'] !== undefined || input['plannedShekels'] !== undefined) {
      const raw = input['plannedAmountAgorot'] ?? input['plannedShekels'];
      patch.plannedAmountAgorot =
        raw === null || raw === ''
          ? null
          : readAmountAgorot(
              { amountAgorot: input['plannedAmountAgorot'], amountShekels: input['plannedShekels'] },
              'אומדן ההוצאה',
            );
    }
    if (input['plannedPeriod'] !== undefined) {
      patch.plannedPeriod = (optionalString(input['plannedPeriod']) as PlannedPeriod) ?? null;
    }
    if (input['plannedNote'] !== undefined) {
      patch.plannedNote = optionalString(input['plannedNote']) ?? null;
    }
    res.json({
      category: updateExpenseCategoryBudget(db, intParam(req.params['id'], 'id'), patch),
    });
  });

  /** דוח תקציב: אומדן מול הוצאה בפועל. */
  router.get('/budget', (req, res) => {
    res.json(
      getBudgetReport(db, {
        ...(optionalInt(req.query['organizationId'])
          ? { organizationId: optionalInt(req.query['organizationId'])! }
          : {}),
        ...(optionalInt(req.query['months']) ? { months: optionalInt(req.query['months'])! } : {}),
      }),
    );
  });

  /** מידע על ספק חילוץ החשבוניות, כדי שהממשק יידע מה להציג. */
  router.get('/invoice-provider', (_req, res) => {
    res.json(invoiceProviderInfo());
  });

  /**
   * קריאת חשבונית והחזרת הצעה לשדות ההוצאה.
   * אינה יוצרת הוצאה - המשתמש מאשר את הנתונים בטופס.
   */
  router.post(
    '/scan-invoice',
    asyncHandler(async (req, res) => {
      const file = decodeUpload(body(req));
      res.json({ suggestion: await suggestFromInvoice(file), filename: file.filename });
    }),
  );

  router.get('/summary', (req, res) => {
    res.json(getExpenseSummary(db, parseFilters(req.query as Record<string, unknown>)));
  });

  router.get('/', (req, res) => {
    const filters = parseFilters(req.query as Record<string, unknown>);
    const items = listExpenses(db, filters);
    res.json({
      items,
      summary: getExpenseSummary(db, filters),
      totals: { amountAgorot: items.reduce((sum, item) => sum + item.amountAgorot, 0) },
    });
  });

  router.get('/:id', (req, res) => {
    res.json({ expense: getExpense(db, intParam(req.params['id'], 'id')) });
  });

  /**
   * יצירת הוצאה. ניתן לצרף חשבונית באותה קריאה, בשדה attachment,
   * וכך העלאת החשבונית והרישום הם פעולה אחת.
   */
  router.post('/', (req, res) => {
    const input = body(req);
    const expense = createExpense(db, {
      organizationId: intParam(input['organizationId'], 'organizationId'),
      categoryId: intParam(input['categoryId'], 'categoryId'),
      eventId: optionalInt(input['eventId']) ?? null,
      supplier: optionalString(input['supplier']) ?? null,
      amountAgorot: readAmountAgorot(input, 'סכום ההוצאה'),
      ...(optionalString(input['expenseDate'])
        ? { expenseDate: optionalString(input['expenseDate'])! }
        : {}),
      method: optionalString(input['method']) ?? null,
      invoiceNumber: optionalString(input['invoiceNumber']) ?? null,
      description: optionalString(input['description']) ?? null,
      notes: optionalString(input['notes']) ?? null,
    });

    const attachment = input['attachment'];
    if (attachment && typeof attachment === 'object') {
      attachToExpense(db, expense.id, decodeUpload(attachment as Record<string, unknown>));
    }

    res.status(201).json({ expense: getExpense(db, expense.id) });
  });

  router.patch('/:id', (req, res) => {
    const input = body(req);
    const patch: Parameters<typeof updateExpense>[2] = {};
    if (input['organizationId'] !== undefined) {
      patch.organizationId = intParam(input['organizationId'], 'organizationId');
    }
    if (input['categoryId'] !== undefined) {
      patch.categoryId = intParam(input['categoryId'], 'categoryId');
    }
    if (input['eventId'] !== undefined) patch.eventId = optionalInt(input['eventId']) ?? null;
    if (input['supplier'] !== undefined) patch.supplier = optionalString(input['supplier']) ?? null;
    if (input['amountAgorot'] !== undefined || input['amountShekels'] !== undefined) {
      patch.amountAgorot = readAmountAgorot(input, 'סכום ההוצאה');
    }
    if (input['expenseDate'] !== undefined) patch.expenseDate = optionalString(input['expenseDate'])!;
    if (input['method'] !== undefined) patch.method = optionalString(input['method']) ?? null;
    if (input['invoiceNumber'] !== undefined) {
      patch.invoiceNumber = optionalString(input['invoiceNumber']) ?? null;
    }
    if (input['description'] !== undefined) {
      patch.description = optionalString(input['description']) ?? null;
    }
    if (input['notes'] !== undefined) patch.notes = optionalString(input['notes']) ?? null;

    res.json({ expense: updateExpense(db, intParam(req.params['id'], 'id'), patch) });
  });

  router.delete('/:id', (req, res) => {
    deleteExpense(db, intParam(req.params['id'], 'id'));
    res.json({ ok: true });
  });

  /** צירוף חשבונית להוצאה קיימת. */
  router.post('/:id/attachments', (req, res) => {
    const file = decodeUpload(body(req));
    res.status(201).json({
      attachment: attachToExpense(db, intParam(req.params['id'], 'id'), file),
    });
  });

  router.get('/attachments/:attachmentId/file', (req, res) => {
    const file = readAttachment(db, intParam(req.params['attachmentId'], 'attachmentId'));
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    res.send(file.data);
  });

  router.delete('/attachments/:attachmentId', (req, res) => {
    deleteAttachment(db, intParam(req.params['attachmentId'], 'attachmentId'));
    res.json({ ok: true });
  });

  return router;
}
