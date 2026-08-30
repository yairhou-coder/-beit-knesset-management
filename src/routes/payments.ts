import { Router } from 'express';
import type { Db } from '../db/index.js';
import type { DocumentType, PaymentMethod, PaymentStatus } from '../domain/types.js';
import {
  assignPaymentToMember,
  getPayment,
  listPayments,
  recordPayment,
  refundPayment,
  type PaymentFilters,
} from '../services/payments.js';
import {
  asArray,
  asyncHandler,
  body,
  intParam,
  optionalAmountAgorot,
  optionalBool,
  optionalInt,
  optionalString,
  readAmountAgorot,
} from './helpers.js';

function parseFilters(query: Record<string, unknown>): PaymentFilters {
  const filters: PaymentFilters = {};
  const assign = <K extends keyof PaymentFilters>(key: K, value: PaymentFilters[K]) => {
    if (value !== undefined) filters[key] = value;
  };
  assign('memberId', optionalInt(query['memberId']));
  assign('memberSearch', optionalString(query['memberSearch'] ?? query['search']));
  assign('organizationId', optionalInt(query['organizationId']));
  assign('commitmentId', optionalInt(query['commitmentId']));
  assign('method', optionalString(query['method']) as PaymentMethod | undefined);
  assign('fromDate', optionalString(query['fromDate']));
  assign('toDate', optionalString(query['toDate']));
  assign('minAmountAgorot', optionalAmountAgorot(query['minAmountAgorot']));
  assign('maxAmountAgorot', optionalAmountAgorot(query['maxAmountAgorot']));
  assign('sort', optionalString(query['sort']));
  assign('limit', optionalInt(query['limit']));
  assign('offset', optionalInt(query['offset']));
  if (optionalBool(query['unassigned'])) filters.unassignedOnly = true;
  const statuses = asArray(query['status']);
  if (statuses?.length) filters.status = statuses as PaymentStatus[];
  return filters;
}

export function createPaymentsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const items = listPayments(db, parseFilters(req.query as Record<string, unknown>));
    res.json({
      items,
      totals: { amountAgorot: items.reduce((sum, item) => sum + item.amountAgorot, 0) },
    });
  });

  router.get('/:id', (req, res) => {
    res.json({ payment: getPayment(db, intParam(req.params['id'], 'id')) });
  });

  /**
   * רישום תשלום שהתקבל בפועל.
   * זהו הצומת המרכזי של סעיף 27: מעדכן את ההתחייבות, רושם הכנסה ומפיק קבלה.
   */
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = body(req);
      const result = await recordPayment(db, {
        commitmentId: optionalInt(input['commitmentId']) ?? null,
        ...(optionalInt(input['organizationId'])
          ? { organizationId: optionalInt(input['organizationId'])! }
          : {}),
        memberId: optionalInt(input['memberId']) ?? null,
        amountAgorot: readAmountAgorot(input, 'סכום התשלום'),
        ...(optionalString(input['paymentDate'])
          ? { paymentDate: optionalString(input['paymentDate'])! }
          : {}),
        method: (optionalString(input['method']) ?? 'cash') as PaymentMethod,
        ...(optionalString(input['status'])
          ? { status: optionalString(input['status']) as PaymentStatus }
          : {}),
        ...(optionalString(input['idempotencyKey'])
          ? { idempotencyKey: optionalString(input['idempotencyKey'])! }
          : {}),
        ...(optionalBool(input['receiptRequired']) !== undefined
          ? { receiptRequired: optionalBool(input['receiptRequired'])! }
          : {}),
        ...(optionalString(input['documentType'])
          ? { documentType: optionalString(input['documentType']) as DocumentType }
          : {}),
        notes: optionalString(input['notes']) ?? null,
        description: optionalString(input['description']) ?? null,
      });
      res.status(201).json(result);
    }),
  );

  /** שיוך תשלום "יתום" לחבר (סעיף 30). */
  router.post('/:id/assign', (req, res) => {
    const input = body(req);
    res.json({
      payment: assignPaymentToMember(
        db,
        intParam(req.params['id'], 'id'),
        intParam(input['memberId'], 'memberId'),
        optionalInt(input['commitmentId']) ?? null,
      ),
    });
  });

  router.post('/:id/refund', (req, res) => {
    res.json({
      payment: refundPayment(db, intParam(req.params['id'], 'id'), optionalString(body(req)['reason'])),
    });
  });

  return router;
}
