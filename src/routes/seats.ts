import { Router } from 'express';
import type { Db } from '../db/index.js';
import type { PaymentMethod } from '../domain/types.js';
import {
  confirmSeatAmount,
  createSeatCommitment,
  getSeatSummary,
  listSeatCommitments,
  updateSeat,
  type SeatFilters,
  type SeatPaymentMode,
} from '../services/seats.js';
import {
  asyncHandler,
  body,
  intParam,
  optionalInt,
  optionalString,
  readAmountAgorot,
} from './helpers.js';

function parseFilters(query: Record<string, unknown>): SeatFilters {
  const filters: SeatFilters = {};
  const memberId = optionalInt(query['memberId']);
  if (memberId !== undefined) filters.memberId = memberId;
  const organizationId = optionalInt(query['organizationId']);
  if (organizationId !== undefined) filters.organizationId = organizationId;
  const memberSearch = optionalString(query['memberSearch'] ?? query['search']);
  if (memberSearch) filters.memberSearch = memberSearch;
  const state = optionalString(query['state']);
  if (state === 'outstanding' || state === 'paid' || state === 'unknown' || state === 'all') {
    filters.state = state;
  }
  const mode = optionalString(query['paymentMode']);
  if (mode) filters.paymentMode = mode as SeatPaymentMode;
  return filters;
}

export function createSeatsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const filters = parseFilters(req.query as Record<string, unknown>);
    res.json({
      items: listSeatCommitments(db, filters),
      summary: getSeatSummary(db, filters),
    });
  });

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = body(req);
      const mode = (optionalString(input['paymentMode']) ?? 'standing_order') as SeatPaymentMode;

      const result = await createSeatCommitment(db, {
        memberId: intParam(input['memberId'], 'memberId'),
        organizationId: intParam(input['organizationId'], 'organizationId'),
        // הסכום הכולל אינו חובה: אצל חלק מהחברים הוא פשוט אינו ידוע.
        amountAgorot:
          input['amountAgorot'] === undefined &&
          (input['amountShekels'] === undefined ||
            input['amountShekels'] === null ||
            input['amountShekels'] === '')
            ? null
            : readAmountAgorot(input, 'סכום ההתחייבות'),
        paymentMode: mode,
        ...(optionalString(input['commitmentDate'])
          ? { commitmentDate: optionalString(input['commitmentDate'])! }
          : {}),
        instalmentsCount: optionalInt(input['instalmentsCount']) ?? null,
        instalmentAgorot:
          input['instalmentAgorot'] !== undefined || input['instalmentShekels'] !== undefined
            ? readAmountAgorot(
                {
                  amountAgorot: input['instalmentAgorot'],
                  amountShekels: input['instalmentShekels'],
                },
                'סכום התשלום החודשי',
              )
            : null,
        ...(optionalInt(input['dayOfMonth']) !== undefined
          ? { dayOfMonth: optionalInt(input['dayOfMonth'])! }
          : {}),
        firstPaymentDate: optionalString(input['firstPaymentDate']) ?? null,
        ...(optionalString(input['paidMethod'])
          ? { paidMethod: optionalString(input['paidMethod']) as PaymentMethod }
          : {}),
        ...(optionalString(input['paidDate']) ? { paidDate: optionalString(input['paidDate'])! } : {}),
        notes: optionalString(input['notes']) ?? null,
      });

      res.status(201).json(result);
    }),
  );

  /** הזנת הסכום הכולל שסוכם עם החבר, כשהוא נודע. */
  router.post('/:id/amount', (req, res) => {
    const input = body(req);
    res.json({
      item: confirmSeatAmount(
        db,
        intParam(req.params['id'], 'id'),
        readAmountAgorot(input, 'סכום ההתחייבות'),
        { instalmentsCount: optionalInt(input['instalmentsCount']) ?? null },
      ),
    });
  });

  /**
   * עריכה מלאה של שורת מקום/ריהוט: הסכום הכולל, מספר התשלומים,
   * הסכום החודשי, יום החיוב ומצב ההוראה - הכל מכאן.
   */
  router.patch('/:id', (req, res) => {
    const input = body(req);
    const id = intParam(req.params['id'], 'id');
    const patch: Parameters<typeof updateSeat>[2] = {};

    if (input['amountAgorot'] !== undefined || input['amountShekels'] !== undefined) {
      const raw = input['amountAgorot'] ?? input['amountShekels'];
      patch.amountAgorot =
        raw === null || raw === '' ? null : readAmountAgorot(input, 'סכום ההתחייבות');
    }
    if (input['instalmentsCount'] !== undefined) {
      patch.instalmentsCount = optionalInt(input['instalmentsCount']) ?? null;
    }
    if (input['firstPaymentDate'] !== undefined) {
      patch.firstPaymentDate = optionalString(input['firstPaymentDate']) ?? null;
    }
    if (input['instalmentAgorot'] !== undefined || input['instalmentShekels'] !== undefined) {
      patch.instalmentAgorot = readAmountAgorot(
        { amountAgorot: input['instalmentAgorot'], amountShekels: input['instalmentShekels'] },
        'סכום התשלום החודשי',
      );
    }
    const day = optionalInt(input['dayOfMonth']);
    if (day !== undefined) patch.dayOfMonth = day;
    const orderStatus = optionalString(input['orderStatus']);
    if (orderStatus === 'active' || orderStatus === 'paused' || orderStatus === 'cancelled') {
      patch.orderStatus = orderStatus;
    }

    res.json({ item: updateSeat(db, id, patch) });
  });

  return router;
}
