import { Router } from 'express';
import type { Db } from '../db/index.js';
import type { NotificationChannel, NotificationStatus } from '../domain/types.js';
import {
  listNotifications,
  queueNotification,
  sendDebtReminder,
  sendDebtRemindersBulk,
  sendNotification,
} from '../services/notifications.js';
import { asyncHandler, body, intParam, optionalInt, optionalString } from './helpers.js';

/** תזכורות לחברים על יתרות פתוחות (סעיף 23). */
export function createNotificationsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({
      items: listNotifications(db, {
        ...(optionalInt(req.query['memberId'])
          ? { memberId: optionalInt(req.query['memberId'])! }
          : {}),
        ...(optionalString(req.query['status'])
          ? { status: optionalString(req.query['status']) as NotificationStatus }
          : {}),
        ...(optionalString(req.query['channel'])
          ? { channel: optionalString(req.query['channel']) as NotificationChannel }
          : {}),
      }),
    });
  });

  /** תזכורת לחבר בודד על יתרתו הפתוחה. */
  router.post(
    '/debt-reminder',
    asyncHandler(async (req, res) => {
      const input = body(req);
      res.status(201).json({
        notification: await sendDebtReminder(db, {
          memberId: intParam(input['memberId'], 'memberId'),
          organizationId: intParam(input['organizationId'], 'organizationId'),
          ...(optionalString(input['channel'])
            ? { channel: optionalString(input['channel']) as NotificationChannel }
            : {}),
        }),
      });
    }),
  );

  /** תזכורות לכל החייבים בעמותה. */
  router.post(
    '/debt-reminders/bulk',
    asyncHandler(async (req, res) => {
      const input = body(req);
      res.json(
        await sendDebtRemindersBulk(db, {
          organizationId: intParam(input['organizationId'], 'organizationId'),
          ...(optionalInt(input['minAgeDays']) !== undefined
            ? { minAgeDays: optionalInt(input['minAgeDays'])! }
            : {}),
          ...(optionalInt(input['minBalanceAgorot']) !== undefined
            ? { minBalanceAgorot: optionalInt(input['minBalanceAgorot'])! }
            : {}),
          ...(optionalString(input['channel'])
            ? { channel: optionalString(input['channel']) as NotificationChannel }
            : {}),
        }),
      );
    }),
  );

  router.post('/', (req, res) => {
    const input = body(req);
    res.status(201).json({
      notification: queueNotification(db, {
        memberId: intParam(input['memberId'], 'memberId'),
        organizationId: optionalInt(input['organizationId']) ?? null,
        ...(optionalString(input['channel'])
          ? { channel: optionalString(input['channel']) as NotificationChannel }
          : {}),
        templateKey: optionalString(input['templateKey']) ?? 'custom',
        subject: optionalString(input['subject']) ?? null,
        body: String(input['body'] ?? ''),
      }),
    });
  });

  router.post(
    '/:id/send',
    asyncHandler(async (req, res) => {
      res.json({ notification: await sendNotification(db, intParam(req.params['id'], 'id')) });
    }),
  );

  return router;
}
