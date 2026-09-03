import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { config, PROJECT_ROOT } from './config.js';
import type { Db } from './db/index.js';
import { MoneyError } from './domain/money.js';
import { ProviderError } from './integrations/types.js';
import { createApiRouter } from './routes/index.js';
import { AppError } from './services/errors.js';

export function createApp(db: Db): Express {
  const app = express();

  // הגוף הגולמי של Webhooks נשמר לצורך אימות חתימה.
  app.use(
    '/api/organizations/:id/webhooks',
    express.text({ type: ['application/json', 'text/plain'], limit: '256kb' }),
  );
  app.use(express.json({ limit: '25mb' })); // חשבוניות מועלות כ-base64
  app.use(express.urlencoded({ extended: false }));

  app.use('/api', createApiRouter(db));

  // ה-UI הוא אפליקציית עמוד יחיד עם ניתוב מבוסס hash, ולכן קבצים סטטיים מספיקים.
  const webDir = path.join(PROJECT_ROOT, 'src', 'web');
  app.use(express.static(webDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDir, 'index.html'));
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      });
      return;
    }
    if (error instanceof MoneyError) {
      res.status(422).json({ error: { code: 'invalid_amount', message: error.message } });
      return;
    }
    if (error instanceof ProviderError) {
      res.status(502).json({
        error: { code: error.code ?? 'provider_error', message: error.message, provider: error.provider },
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    // הפרות אילוצים בבסיס הנתונים הן בדרך כלל ניסיון ליצור רשומה כפולה.
    if (/UNIQUE constraint failed/i.test(message)) {
      res.status(409).json({
        error: { code: 'conflict', message: 'הרשומה כבר קיימת במערכת', details: message },
      });
      return;
    }
    if (config.nodeEnv !== 'test') {
      // eslint-disable-next-line no-console
      console.error('[error]', error);
    }
    res.status(500).json({ error: { code: 'internal_error', message: 'שגיאה פנימית בשרת' } });
  });

  return app;
}
