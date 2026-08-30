import { Router } from 'express';
import type { Db } from '../db/index.js';
import type { PaymentMethod, StandingOrderStatus } from '../domain/types.js';
import {
  cancelStandingOrder,
  chargeStandingOrder,
  createStandingOrder,
  getStandingOrder,
  listStandingOrders,
  registerWithProvider,
} from '../services/standingOrders.js';
import {
  asyncHandler,
  body,
  intParam,
  optionalInt,
  optionalString,
  readAmountAgorot,
} from './helpers.js';

export function createStandingOrdersRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({
      items: listStandingOrders(db, {
        ...(optionalInt(req.query['memberId'])
          ? { memberId: optionalInt(req.query['memberId'])! }
          : {}),
        ...(optionalInt(req.query['organizationId'])
          ? { organizationId: optionalInt(req.query['organizationId'])! }
          : {}),
        ...(optionalString(req.query['status'])
          ? { status: optionalString(req.query['status']) as StandingOrderStatus }
          : {}),
      }),
    });
  });

  router.get('/:id', (req, res) => {
    res.json({ standingOrder: getStandingOrder(db, intParam(req.params['id'], 'id')) });
  });

  router.post('/', (req, res) => {
    const input = body(req);
    res.status(201).json({
      standingOrder: createStandingOrder(db, {
        memberId: intParam(input['memberId'], 'memberId'),
        organizationId: intParam(input['organizationId'], 'organizationId'),
        commitmentTypeId: optionalInt(input['commitmentTypeId']) ?? null,
        amountAgorot: readAmountAgorot(input, 'סכום הוראת הקבע'),
        ...(optionalInt(input['dayOfMonth']) !== undefined
          ? { dayOfMonth: optionalInt(input['dayOfMonth'])! }
          : {}),
        ...(optionalString(input['method'])
          ? { method: optionalString(input['method']) as PaymentMethod }
          : {}),
        ...(optionalString(input['startDate'])
          ? { startDate: optionalString(input['startDate'])! }
          : {}),
        endDate: optionalString(input['endDate']) ?? null,
        notes: optionalString(input['notes']) ?? null,
      }),
    });
  });

  router.post(
    '/:id/register',
    asyncHandler(async (req, res) => {
      res.json({ standingOrder: await registerWithProvider(db, intParam(req.params['id'], 'id')) });
    }),
  );

  /** חיוב חודשי. `period` (YYYY-MM) מונע חיוב כפול באותו חודש. */
  router.post(
    '/:id/charge',
    asyncHandler(async (req, res) => {
      const period = optionalString(body(req)['period']);
      res.json(await chargeStandingOrder(db, intParam(req.params['id'], 'id'), period));
    }),
  );

  router.post(
    '/:id/cancel',
    asyncHandler(async (req, res) => {
      const reason = optionalString(body(req)['reason']);
      res.json({
        standingOrder: await cancelStandingOrder(db, intParam(req.params['id'], 'id'), reason),
      });
    }),
  );

  return router;
}
