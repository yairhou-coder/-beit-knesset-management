import { Router } from 'express';
import type { Db } from '../db/index.js';
import type { DocumentType, EventKind } from '../domain/types.js';
import {
  createCommitmentType,
  createEvent,
  listCommitmentTypes,
  listEvents,
} from '../services/catalog.js';
import {
  COMMITMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  EVENT_KIND_LABELS,
  INCOME_RECEIPT_STATUS_LABELS,
  NOTIFICATION_CHANNEL_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  RECEIPT_ISSUE_MODE_LABELS,
  RECEIPT_STATUS_LABELS,
  STANDING_ORDER_STATUS_LABELS,
} from '../domain/types.js';
import { EXPENSE_KIND_LABELS, PLANNED_PERIOD_LABELS } from '../services/expenses.js';
import { SEAT_PAYMENT_MODE_LABELS } from '../services/seats.js';
import { body, optionalInt, optionalString } from './helpers.js';

export function createCatalogRouter(db: Db): Router {
  const router = Router();

  /** כל התוויות בעברית במקום אחד, כדי שה-UI לא ישכפל אותן. */
  router.get('/lookups', (_req, res) => {
    res.json({
      commitmentStatuses: COMMITMENT_STATUS_LABELS,
      paymentMethods: PAYMENT_METHOD_LABELS,
      paymentStatuses: PAYMENT_STATUS_LABELS,
      receiptStatuses: RECEIPT_STATUS_LABELS,
      incomeReceiptStatuses: INCOME_RECEIPT_STATUS_LABELS,
      documentTypes: DOCUMENT_TYPE_LABELS,
      receiptIssueModes: RECEIPT_ISSUE_MODE_LABELS,
      eventKinds: EVENT_KIND_LABELS,
      notificationChannels: NOTIFICATION_CHANNEL_LABELS,
      standingOrderStatuses: STANDING_ORDER_STATUS_LABELS,
      expenseKinds: EXPENSE_KIND_LABELS,
      plannedPeriods: PLANNED_PERIOD_LABELS,
      seatPaymentModes: SEAT_PAYMENT_MODE_LABELS,
    });
  });

  router.get('/commitment-types', (_req, res) => {
    res.json({ items: listCommitmentTypes(db) });
  });

  router.post('/commitment-types', (req, res) => {
    const input = body(req);
    res.status(201).json({
      commitmentType: createCommitmentType(db, {
        key: String(input['key'] ?? ''),
        name: String(input['name'] ?? ''),
        ...(optionalString(input['documentType'])
          ? { documentType: optionalString(input['documentType']) as DocumentType }
          : {}),
        ...(optionalInt(input['sortOrder']) !== undefined
          ? { sortOrder: optionalInt(input['sortOrder'])! }
          : {}),
      }),
    });
  });

  router.get('/events', (req, res) => {
    const organizationId = optionalInt(req.query['organizationId']);
    res.json({ items: listEvents(db, organizationId ? { organizationId } : {}) });
  });

  router.post('/events', (req, res) => {
    const input = body(req);
    res.status(201).json({
      event: createEvent(db, {
        name: String(input['name'] ?? ''),
        ...(optionalString(input['kind']) ? { kind: optionalString(input['kind']) as EventKind } : {}),
        hebrewDate: optionalString(input['hebrewDate']) ?? null,
        gregorianDate: optionalString(input['gregorianDate']) ?? null,
        organizationId: optionalInt(input['organizationId']) ?? null,
        notes: optionalString(input['notes']) ?? null,
      }),
    });
  });

  return router;
}
