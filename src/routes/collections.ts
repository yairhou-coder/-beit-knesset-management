import { Router } from 'express';
import type { Db } from '../db/index.js';
import {
  debtByEvent,
  debtByOrganization,
  debtByType,
  getAgingBuckets,
  getCollectionSummary,
  listDebtors,
  type CollectionScope,
} from '../services/collections.js';
import { listCommitments } from '../services/commitments.js';
import { optionalAmountAgorot, optionalInt, optionalString } from './helpers.js';
import { parseCommitmentFilters } from './commitments.js';

function parseScope(query: Record<string, unknown>): CollectionScope {
  const scope: CollectionScope = {};
  const organizationId = optionalInt(query['organizationId']);
  const eventId = optionalInt(query['eventId']);
  const typeId = optionalInt(query['commitmentTypeId'] ?? query['typeId']);
  const fromDate = optionalString(query['fromDate']);
  const toDate = optionalString(query['toDate']);
  if (organizationId) scope.organizationId = organizationId;
  if (eventId) scope.eventId = eventId;
  if (typeId) scope.commitmentTypeId = typeId;
  if (fromDate) scope.fromDate = fromDate;
  if (toDate) scope.toDate = toDate;
  return scope;
}

/** מסך "גבייה וחובות" (סעיף 23). */
export function createCollectionsRouter(db: Db): Router {
  const router = Router();

  /** תמונת מצב מלאה למסך הגבייה בקריאה אחת. */
  router.get('/', (req, res) => {
    const query = req.query as Record<string, unknown>;
    const scope = parseScope(query);
    const filters = parseCommitmentFilters(query);
    if (filters.status === undefined && !filters.outstandingOnly) filters.outstandingOnly = true;

    res.json({
      summary: getCollectionSummary(db, scope),
      debtors: listDebtors(db, {
        ...scope,
        ...(optionalInt(query['minAgeDays']) !== undefined
          ? { minAgeDays: optionalInt(query['minAgeDays'])! }
          : {}),
        ...(optionalAmountAgorot(query['minOutstandingAgorot']) !== undefined
          ? { minOutstandingAgorot: optionalAmountAgorot(query['minOutstandingAgorot'])! }
          : {}),
      }),
      aging: getAgingBuckets(db, scope),
      byOrganization: debtByOrganization(db, scope),
      byEvent: debtByEvent(db, scope),
      byType: debtByType(db, scope),
      commitments: listCommitments(db, filters),
    });
  });

  router.get('/summary', (req, res) => {
    res.json(getCollectionSummary(db, parseScope(req.query as Record<string, unknown>)));
  });

  /** מי חייב כסף וכמה (סעיף 23). */
  router.get('/debtors', (req, res) => {
    const query = req.query as Record<string, unknown>;
    res.json({
      debtors: listDebtors(db, {
        ...parseScope(query),
        ...(optionalInt(query['minAgeDays']) !== undefined
          ? { minAgeDays: optionalInt(query['minAgeDays'])! }
          : {}),
        ...(optionalAmountAgorot(query['minOutstandingAgorot']) !== undefined
          ? { minOutstandingAgorot: optionalAmountAgorot(query['minOutstandingAgorot'])! }
          : {}),
        ...(optionalInt(query['limit']) !== undefined ? { limit: optionalInt(query['limit'])! } : {}),
      }),
    });
  });

  router.get('/aging', (req, res) => {
    res.json({ buckets: getAgingBuckets(db, parseScope(req.query as Record<string, unknown>)) });
  });

  router.get('/by-organization', (req, res) => {
    res.json({ rows: debtByOrganization(db, parseScope(req.query as Record<string, unknown>)) });
  });

  router.get('/by-event', (req, res) => {
    res.json({ rows: debtByEvent(db, parseScope(req.query as Record<string, unknown>)) });
  });

  router.get('/by-type', (req, res) => {
    res.json({ rows: debtByType(db, parseScope(req.query as Record<string, unknown>)) });
  });

  return router;
}
