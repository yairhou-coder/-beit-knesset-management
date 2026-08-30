import { Router } from 'express';
import type { Db } from '../db/index.js';
import type { DocumentType, ReceiptIssueMode } from '../domain/types.js';
import {
  createOrganization,
  getOrganization,
  listOrganizations,
  updateOrganization,
} from '../services/organizations.js';
import { handleWebhook } from '../services/webhooks.js';
import { asyncHandler, body, intParam, optionalBool, optionalString } from './helpers.js';

function asDocumentTypes(value: unknown): DocumentType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(String) as DocumentType[];
}

function asConfig(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createOrganizationsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({
      items: listOrganizations(db, {
        ...(optionalBool(req.query['includeInactive']) ? { includeInactive: true } : {}),
      }),
    });
  });

  router.get('/:id', (req, res) => {
    res.json({ organization: getOrganization(db, intParam(req.params['id'], 'id')) });
  });

  router.post('/', (req, res) => {
    const input = body(req);
    res.status(201).json({
      organization: createOrganization(db, {
        name: String(input['name'] ?? ''),
        shortName: optionalString(input['shortName']) ?? null,
        legalNumber: optionalString(input['legalNumber']) ?? null,
        address: optionalString(input['address']) ?? null,
        phone: optionalString(input['phone']) ?? null,
        email: optionalString(input['email']) ?? null,
        bankName: optionalString(input['bankName']) ?? null,
        bankBranch: optionalString(input['bankBranch']) ?? null,
        bankAccount: optionalString(input['bankAccount']) ?? null,
        accountHolder: optionalString(input['accountHolder']) ?? null,
        ...(optionalString(input['paymentProvider'])
          ? { paymentProvider: optionalString(input['paymentProvider'])! }
          : {}),
        ...(asConfig(input['paymentConfig']) ? { paymentConfig: asConfig(input['paymentConfig'])! } : {}),
        ...(optionalString(input['receiptProvider'])
          ? { receiptProvider: optionalString(input['receiptProvider'])! }
          : {}),
        ...(asConfig(input['receiptConfig']) ? { receiptConfig: asConfig(input['receiptConfig'])! } : {}),
        ...(optionalString(input['notificationProvider'])
          ? { notificationProvider: optionalString(input['notificationProvider'])! }
          : {}),
        ...(asConfig(input['notificationConfig'])
          ? { notificationConfig: asConfig(input['notificationConfig'])! }
          : {}),
        ...(asDocumentTypes(input['allowedDocumentTypes'])
          ? { allowedDocumentTypes: asDocumentTypes(input['allowedDocumentTypes'])! }
          : {}),
        ...(optionalString(input['defaultDocumentType'])
          ? { defaultDocumentType: optionalString(input['defaultDocumentType']) as DocumentType }
          : {}),
        ...(optionalString(input['receiptIssueMode'])
          ? { receiptIssueMode: optionalString(input['receiptIssueMode']) as ReceiptIssueMode }
          : {}),
      }),
    });
  });

  router.patch('/:id', (req, res) => {
    const input = body(req);
    const patch: Parameters<typeof updateOrganization>[2] = {};
    const stringFields: Array<[string, keyof typeof patch]> = [
      ['name', 'name'],
      ['shortName', 'shortName'],
      ['legalNumber', 'legalNumber'],
      ['address', 'address'],
      ['phone', 'phone'],
      ['email', 'email'],
      ['bankName', 'bankName'],
      ['bankBranch', 'bankBranch'],
      ['bankAccount', 'bankAccount'],
      ['accountHolder', 'accountHolder'],
      ['paymentProvider', 'paymentProvider'],
      ['receiptProvider', 'receiptProvider'],
      ['notificationProvider', 'notificationProvider'],
    ];
    for (const [source, target] of stringFields) {
      if (input[source] !== undefined) {
        (patch as Record<string, unknown>)[target] = optionalString(input[source]) ?? null;
      }
    }
    if (asConfig(input['paymentConfig'])) patch.paymentConfig = asConfig(input['paymentConfig']);
    if (asConfig(input['receiptConfig'])) patch.receiptConfig = asConfig(input['receiptConfig']);
    if (asConfig(input['notificationConfig'])) {
      patch.notificationConfig = asConfig(input['notificationConfig']);
    }
    if (asDocumentTypes(input['allowedDocumentTypes'])) {
      patch.allowedDocumentTypes = asDocumentTypes(input['allowedDocumentTypes']);
    }
    if (optionalString(input['defaultDocumentType'])) {
      patch.defaultDocumentType = optionalString(input['defaultDocumentType']) as DocumentType;
    }
    // סעיף 29: אופן הפקת הקבלות ניתן להגדרה נפרדת לכל עמותה.
    if (optionalString(input['receiptIssueMode'])) {
      patch.receiptIssueMode = optionalString(input['receiptIssueMode']) as ReceiptIssueMode;
    }
    if (input['active'] !== undefined) patch.active = optionalBool(input['active']) ?? true;

    res.json({ organization: updateOrganization(db, intParam(req.params['id'], 'id'), patch) });
  });

  /**
   * נקודת קצה ל-Webhooks מספק הסליקה של העמותה (סעיף 26).
   * הגוף הגולמי נדרש לאימות החתימה, ולכן נקרא כטקסט ולא כ-JSON מפוענח.
   */
  router.post(
    '/:id/webhooks/payments',
    asyncHandler(async (req, res) => {
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      const result = await handleWebhook(
        db,
        intParam(req.params['id'], 'id'),
        req.headers as Record<string, string | undefined>,
        rawBody,
      );
      res.json(result);
    }),
  );

  return router;
}
