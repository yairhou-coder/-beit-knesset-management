import { Router } from 'express';
import type { Db } from '../db/index.js';
import type { DocumentType, ReceiptStatus } from '../domain/types.js';
import {
  approveReceipt,
  cancelReceipt,
  downloadReceiptPdf,
  getReceipt,
  listReceipts,
  refreshReceiptStatus,
  retryAllPending,
  retryReceipt,
  type ReceiptFilters,
} from '../services/receipts.js';
import {
  asArray,
  asyncHandler,
  body,
  intParam,
  optionalAmountAgorot,
  optionalInt,
  optionalString,
} from './helpers.js';

/** מסננים למסך "קבלות ומסמכים" (סעיף 24). */
function parseFilters(query: Record<string, unknown>): ReceiptFilters {
  const filters: ReceiptFilters = {};
  const assign = <K extends keyof ReceiptFilters>(key: K, value: ReceiptFilters[K]) => {
    if (value !== undefined) filters[key] = value;
  };
  assign('memberId', optionalInt(query['memberId']));
  assign('memberSearch', optionalString(query['memberSearch'] ?? query['search']));
  assign('receiptNumber', optionalString(query['receiptNumber']));
  assign('organizationId', optionalInt(query['organizationId']));
  assign('documentType', optionalString(query['documentType']) as DocumentType | undefined);
  assign('paymentMethod', optionalString(query['paymentMethod'] ?? query['method']));
  assign('fromDate', optionalString(query['fromDate']));
  assign('toDate', optionalString(query['toDate']));
  assign('minAmountAgorot', optionalAmountAgorot(query['minAmountAgorot']));
  assign('maxAmountAgorot', optionalAmountAgorot(query['maxAmountAgorot']));
  assign('sort', optionalString(query['sort']));
  assign('limit', optionalInt(query['limit']));
  assign('offset', optionalInt(query['offset']));
  const statuses = asArray(query['status']);
  if (statuses?.length) filters.status = statuses as ReceiptStatus[];
  return filters;
}

export function createReceiptsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const items = listReceipts(db, parseFilters(req.query as Record<string, unknown>));
    res.json({
      items,
      totals: {
        amountAgorot: items
          .filter((item) => item.status === 'issued')
          .reduce((sum, item) => sum + item.amountAgorot, 0),
        issued: items.filter((item) => item.status === 'issued').length,
        pending: items.filter(
          (item) => item.status === 'pending' || item.status === 'awaiting_approval',
        ).length,
        failed: items.filter((item) => item.status === 'failed').length,
      },
    });
  });

  router.get('/:id', (req, res) => {
    res.json({ receipt: getReceipt(db, intParam(req.params['id'], 'id')) });
  });

  /** ניסיון חוזר להפקת קבלה שנכשלה (סעיף 28). */
  router.post(
    '/:id/retry',
    asyncHandler(async (req, res) => {
      res.json(await retryReceipt(db, intParam(req.params['id'], 'id')));
    }),
  );

  /** ניסיון חוזר לכל הקבלות הממתינות. */
  router.post(
    '/retry-all',
    asyncHandler(async (req, res) => {
      const organizationId = optionalInt(body(req)['organizationId']);
      res.json(await retryAllPending(db, organizationId ? { organizationId } : {}));
    }),
  );

  /** אישור ידני של גזבר/מנהל להפקת קבלה (סעיף 29). */
  router.post(
    '/:id/approve',
    asyncHandler(async (req, res) => {
      res.json(await approveReceipt(db, intParam(req.params['id'], 'id')));
    }),
  );

  router.post(
    '/:id/cancel',
    asyncHandler(async (req, res) => {
      const reason = optionalString(body(req)['reason']);
      res.json({ receipt: await cancelReceipt(db, intParam(req.params['id'], 'id'), reason) });
    }),
  );

  router.post(
    '/:id/refresh',
    asyncHandler(async (req, res) => {
      res.json({ receipt: await refreshReceiptStatus(db, intParam(req.params['id'], 'id')) });
    }),
  );

  /** הורדת ה-PDF של הקבלה. */
  router.get(
    '/:id/pdf',
    asyncHandler(async (req, res) => {
      const download = await downloadReceiptPdf(db, intParam(req.params['id'], 'id'));
      res.setHeader('Content-Type', download.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${download.filename}"`);
      res.send(download.data);
    }),
  );

  return router;
}
