import { Router } from 'express';
import type { Db } from '../db/index.js';
import { getDashboard } from '../services/dashboard.js';
import { getFinancialReport } from '../services/collections.js';
import { listAlerts, resolveAlert } from '../services/alerts.js';
import { intParam, optionalInt, optionalString } from './helpers.js';

export function createDashboardRouter(db: Db): Router {
  const router = Router();

  // Dashboard ראשי + אזור גבייה (סעיפים 23, 30)
  router.get('/', (req, res) => {
    const organizationId = optionalInt(req.query['organizationId']);
    res.json(getDashboard(db, organizationId ? { organizationId } : {}));
  });

  // דוח כספי: כל עמותה בנפרד + תמונה מאוחדת (סעיף 25)
  router.get('/report', (req, res) => {
    const range: { fromDate?: string; toDate?: string } = {};
    const from = optionalString(req.query['fromDate']);
    const to = optionalString(req.query['toDate']);
    if (from) range.fromDate = from;
    if (to) range.toDate = to;
    res.json(getFinancialReport(db, range));
  });

  // התראות למנהל (סעיף 28)
  router.get('/alerts', (req, res) => {
    const organizationId = optionalInt(req.query['organizationId']);
    res.json({
      alerts: listAlerts(db, {
        resolved: req.query['resolved'] === 'true',
        ...(organizationId ? { organizationId } : {}),
        ...(optionalString(req.query['kind']) ? { kind: optionalString(req.query['kind'])! } : {}),
      }),
    });
  });

  router.post('/alerts/:id/resolve', (req, res) => {
    resolveAlert(db, intParam(req.params['id'], 'id'));
    res.json({ ok: true });
  });

  return router;
}
