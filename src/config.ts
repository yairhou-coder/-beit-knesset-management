import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');

function env(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  port: envNumber('PORT', 3000),
  nodeEnv: env('NODE_ENV', 'development'),
  databaseFile: path.resolve(PROJECT_ROOT, env('DATABASE_FILE', './data/beit-knesset.db')),
  receiptStorageDir: path.resolve(PROJECT_ROOT, env('RECEIPT_STORAGE_DIR', './data/receipts')),
  defaultPaymentProvider: env('DEFAULT_PAYMENT_PROVIDER', 'mock'),
  defaultReceiptProvider: env('DEFAULT_RECEIPT_PROVIDER', 'mock'),
  defaultNotificationProvider: env('DEFAULT_NOTIFICATION_PROVIDER', 'mock'),
  mock: {
    receiptFailureRate: envNumber('MOCK_RECEIPT_FAILURE_RATE', 0),
    paymentFailureRate: envNumber('MOCK_PAYMENT_FAILURE_RATE', 0),
  },
  /** ספי גיל חוב לדשבורד הגבייה (סעיף 30). */
  agingBuckets: [30, 60, 90] as const,
} as const;
