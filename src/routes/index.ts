import { Router } from 'express';
import type { Db } from '../db/index.js';
import { createCatalogRouter } from './catalog.js';
import { createCollectionsRouter } from './collections.js';
import { createCommitmentsRouter } from './commitments.js';
import { createDashboardRouter } from './dashboard.js';
import { createIncomesRouter } from './incomes.js';
import { createMembersRouter } from './members.js';
import { createNotificationsRouter } from './notifications.js';
import { createOrganizationsRouter } from './organizations.js';
import { createPaymentsRouter } from './payments.js';
import { createReceiptsRouter } from './receipts.js';
import { createStandingOrdersRouter } from './standingOrders.js';

export function createApiRouter(db: Db): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  router.use('/dashboard', createDashboardRouter(db));
  router.use('/collections', createCollectionsRouter(db));
  router.use('/commitments', createCommitmentsRouter(db));
  router.use('/payments', createPaymentsRouter(db));
  router.use('/incomes', createIncomesRouter(db));
  router.use('/receipts', createReceiptsRouter(db));
  router.use('/members', createMembersRouter(db));
  router.use('/organizations', createOrganizationsRouter(db));
  router.use('/standing-orders', createStandingOrdersRouter(db));
  router.use('/notifications', createNotificationsRouter(db));
  router.use('/', createCatalogRouter(db));

  return router;
}
