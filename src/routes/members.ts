import { Router } from 'express';
import type { Db } from '../db/index.js';
import type { NotificationChannel } from '../domain/types.js';
import { createMember, getMember, listMembers, updateMember } from '../services/members.js';
import { getMemberCard } from '../services/memberCard.js';
import { listReceipts } from '../services/receipts.js';
import { body, intParam, optionalBool, optionalInt, optionalString } from './helpers.js';

export function createMembersRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({
      items: listMembers(db, {
        ...(optionalString(req.query['search'])
          ? { search: optionalString(req.query['search'])! }
          : {}),
        ...(optionalBool(req.query['includeInactive']) ? { includeInactive: true } : {}),
      }),
    });
  });

  router.get('/:id', (req, res) => {
    res.json({ member: getMember(db, intParam(req.params['id'], 'id')) });
  });

  /** כרטיס חבר מלא: התחייבויות, תשלומים, הכנסות, קבלות והוראות קבע (סעיף 24). */
  router.get('/:id/card', (req, res) => {
    const organizationId = optionalInt(req.query['organizationId']);
    res.json(
      getMemberCard(db, intParam(req.params['id'], 'id'), organizationId ? { organizationId } : {}),
    );
  });

  /** כל הקבלות שהופקו עבור החבר (סעיף 24). */
  router.get('/:id/receipts', (req, res) => {
    const organizationId = optionalInt(req.query['organizationId']);
    res.json({
      items: listReceipts(db, {
        memberId: intParam(req.params['id'], 'id'),
        ...(organizationId ? { organizationId } : {}),
      }),
    });
  });

  router.post('/', (req, res) => {
    const input = body(req);
    res.status(201).json({
      member: createMember(db, {
        firstName: String(input['firstName'] ?? ''),
        lastName: String(input['lastName'] ?? ''),
        hebrewName: optionalString(input['hebrewName']) ?? null,
        phone: optionalString(input['phone']) ?? null,
        email: optionalString(input['email']) ?? null,
        address: optionalString(input['address']) ?? null,
        preferredChannel:
          (optionalString(input['preferredChannel']) as NotificationChannel) ?? null,
        notes: optionalString(input['notes']) ?? null,
      }),
    });
  });

  router.patch('/:id', (req, res) => {
    const input = body(req);
    const patch: Parameters<typeof updateMember>[2] = {};
    if (input['firstName'] !== undefined) patch.firstName = String(input['firstName']);
    if (input['lastName'] !== undefined) patch.lastName = String(input['lastName']);
    if (input['hebrewName'] !== undefined) patch.hebrewName = optionalString(input['hebrewName']) ?? null;
    if (input['phone'] !== undefined) patch.phone = optionalString(input['phone']) ?? null;
    if (input['email'] !== undefined) patch.email = optionalString(input['email']) ?? null;
    if (input['address'] !== undefined) patch.address = optionalString(input['address']) ?? null;
    if (input['preferredChannel'] !== undefined) {
      patch.preferredChannel = (optionalString(input['preferredChannel']) as NotificationChannel) ?? null;
    }
    if (input['notes'] !== undefined) patch.notes = optionalString(input['notes']) ?? null;
    if (input['active'] !== undefined) patch.active = optionalBool(input['active']) ?? true;
    res.json({ member: updateMember(db, intParam(req.params['id'], 'id'), patch) });
  });

  return router;
}
