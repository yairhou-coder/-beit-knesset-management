import { Router } from 'express';
import type { Db } from '../db/index.js';
import {
  cancelCommitment,
  createCommitment,
  countCommitments,
  getCommitment,
  listCommitments,
  reopenCommitment,
  updateCommitment,
  type CommitmentFilters,
} from '../services/commitments.js';
import { listPayments } from '../services/payments.js';
import type { CommitmentStatus, PaymentMethod } from '../domain/types.js';
import {
  asArray,
  body,
  intParam,
  optionalAmountAgorot,
  optionalBool,
  optionalInt,
  optionalString,
  readAmountAgorot,
} from './helpers.js';

/** בונה מסננים מתוך query string. משותף למסך ההתחייבויות ולמסך הגבייה. */
export function parseCommitmentFilters(query: Record<string, unknown>): CommitmentFilters {
  const filters: CommitmentFilters = {};
  const assign = <K extends keyof CommitmentFilters>(key: K, value: CommitmentFilters[K]) => {
    if (value !== undefined) filters[key] = value;
  };

  assign('memberId', optionalInt(query['memberId']));
  assign('memberSearch', optionalString(query['memberSearch'] ?? query['search']));
  assign('organizationId', optionalInt(query['organizationId']));
  assign('commitmentTypeId', optionalInt(query['commitmentTypeId'] ?? query['typeId']));
  assign('eventId', optionalInt(query['eventId']));
  assign('minAmountAgorot', optionalAmountAgorot(query['minAmountAgorot']));
  assign('maxAmountAgorot', optionalAmountAgorot(query['maxAmountAgorot']));
  assign('fromDate', optionalString(query['fromDate']));
  assign('toDate', optionalString(query['toDate']));
  assign('dueBefore', optionalString(query['dueBefore']));
  assign('minAgeDays', optionalInt(query['minAgeDays']));
  assign('maxAgeDays', optionalInt(query['maxAgeDays']));
  assign('sort', optionalString(query['sort']));
  assign('limit', optionalInt(query['limit']));
  assign('offset', optionalInt(query['offset']));

  if (optionalBool(query['overdueOnly'])) filters.overdueOnly = true;

  // status=outstanding הוא קיצור נוח לשתי הסטטוסים עם יתרה פתוחה.
  const statuses = asArray(query['status']);
  if (statuses?.includes('outstanding')) {
    filters.outstandingOnly = true;
  } else if (statuses?.length) {
    filters.status = statuses as CommitmentStatus[];
  }
  if (optionalBool(query['outstandingOnly'])) filters.outstandingOnly = true;

  return filters;
}

export function createCommitmentsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const filters = parseCommitmentFilters(req.query as Record<string, unknown>);
    const items = listCommitments(db, filters);
    res.json({
      items,
      total: countCommitments(db, filters),
      totals: {
        amountAgorot: items.reduce((sum, item) => sum + item.amountAgorot, 0),
        paidAgorot: items.reduce((sum, item) => sum + item.paidAgorot, 0),
        balanceAgorot: items.reduce((sum, item) => sum + item.balanceAgorot, 0),
      },
    });
  });

  router.get('/:id', (req, res) => {
    const id = intParam(req.params['id'], 'id');
    res.json({
      commitment: getCommitment(db, id),
      payments: listPayments(db, { commitmentId: id }),
    });
  });

  router.post('/', (req, res) => {
    const input = body(req);
    const commitment = createCommitment(db, {
      memberId: intParam(input['memberId'], 'memberId'),
      organizationId: intParam(input['organizationId'], 'organizationId'),
      commitmentTypeId: intParam(input['commitmentTypeId'], 'commitmentTypeId'),
      eventId: optionalInt(input['eventId']) ?? null,
      amountAgorot: readAmountAgorot(input, 'סכום ההתחייבות'),
      ...(optionalString(input['commitmentDate'])
        ? { commitmentDate: optionalString(input['commitmentDate'])! }
        : {}),
      dueDate: optionalString(input['dueDate']) ?? null,
      plannedPaymentMethod: (optionalString(input['plannedPaymentMethod']) as PaymentMethod) ?? null,
      notes: optionalString(input['notes']) ?? null,
    });
    res.status(201).json({ commitment });
  });

  router.patch('/:id', (req, res) => {
    const input = body(req);
    const patch: Parameters<typeof updateCommitment>[2] = {};
    if (input['amountAgorot'] !== undefined || input['amountShekels'] !== undefined) {
      patch.amountAgorot = readAmountAgorot(input, 'סכום ההתחייבות');
    }
    if (input['commitmentTypeId'] !== undefined) {
      patch.commitmentTypeId = intParam(input['commitmentTypeId'], 'commitmentTypeId');
    }
    if (input['eventId'] !== undefined) patch.eventId = optionalInt(input['eventId']) ?? null;
    if (input['commitmentDate'] !== undefined) {
      patch.commitmentDate = optionalString(input['commitmentDate'])!;
    }
    if (input['dueDate'] !== undefined) patch.dueDate = optionalString(input['dueDate']) ?? null;
    if (input['plannedPaymentMethod'] !== undefined) {
      patch.plannedPaymentMethod =
        (optionalString(input['plannedPaymentMethod']) as PaymentMethod) ?? null;
    }
    if (input['notes'] !== undefined) patch.notes = optionalString(input['notes']) ?? null;

    res.json({ commitment: updateCommitment(db, intParam(req.params['id'], 'id'), patch) });
  });

  router.post('/:id/cancel', (req, res) => {
    const reason = optionalString(body(req)['reason']);
    res.json({ commitment: cancelCommitment(db, intParam(req.params['id'], 'id'), reason) });
  });

  router.post('/:id/reopen', (req, res) => {
    res.json({ commitment: reopenCommitment(db, intParam(req.params['id'], 'id')) });
  });

  return router;
}
