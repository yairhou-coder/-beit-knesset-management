import { Router } from 'express';
import type { Db } from '../db/index.js';
import type { IncomeReceiptStatus } from '../domain/types.js';
import {
  getIncome,
  getIncomeSummary,
  listIncomes,
  setReceiptRequired,
  type IncomeFilters,
  type IncomeSource,
} from '../services/incomes.js';
import { asArray, body, intParam, optionalBool, optionalInt, optionalString } from './helpers.js';

export function createIncomesRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const query = req.query as Record<string, unknown>;
    const filters: IncomeFilters = {};
    const assign = <K extends keyof IncomeFilters>(key: K, value: IncomeFilters[K]) => {
      if (value !== undefined) filters[key] = value;
    };
    assign('memberId', optionalInt(query['memberId']));
    assign('organizationId', optionalInt(query['organizationId']));
    assign('commitmentId', optionalInt(query['commitmentId']));
    assign('eventId', optionalInt(query['eventId']));
    assign('commitmentTypeId', optionalInt(query['commitmentTypeId']));
    const source = optionalString(query['source']);
    if (source === 'recurring' || source === 'seats' || source === 'other') {
      filters.source = source as IncomeSource;
    }
    assign('fromDate', optionalString(query['fromDate']));
    assign('toDate', optionalString(query['toDate']));
    assign('sort', optionalString(query['sort']));
    assign('limit', optionalInt(query['limit']));
    assign('offset', optionalInt(query['offset']));
    if (optionalBool(query['includeReversed'])) filters.includeReversed = true;
    const statuses = asArray(query['receiptStatus']);
    if (statuses?.length) filters.receiptStatus = statuses as IncomeReceiptStatus[];

    const items = listIncomes(db, filters);
    // הסיכום מחושב על כל ההכנסות התואמות, ולא רק על השורות שנטענו
    const summary = getIncomeSummary(db, filters);
    res.json({
      items,
      summary,
      totals: { amountAgorot: summary.totalAgorot },
    });
  });

  router.get('/:id', (req, res) => {
    res.json({ income: getIncome(db, intParam(req.params['id'], 'id')) });
  });

  router.patch('/:id/receipt-required', (req, res) => {
    const required = optionalBool(body(req)['required']) ?? true;
    res.json({ income: setReceiptRequired(db, intParam(req.params['id'], 'id'), required) });
  });

  return router;
}
