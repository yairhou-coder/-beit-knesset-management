/** תשתית משותפת לטסטים: בסיס נתונים בזיכרון + גישה לספקי ה-Mock. */

import { openInMemoryDatabase, type Db } from '../src/db/index.js';
import { shekelsToAgorot } from '../src/domain/money.js';
import type { ReceiptIssueMode } from '../src/domain/types.js';
import { createOrganization, getOrganizationRow } from '../src/services/organizations.js';
import { createMember } from '../src/services/members.js';
import { createCommitment } from '../src/services/commitments.js';
import { listCommitmentTypes } from '../src/services/catalog.js';
import {
  resetProviderCaches,
  resolveNotificationProvider,
  resolvePaymentProvider,
  resolveReceiptProvider,
} from '../src/integrations/registry.js';
import type { MockReceiptProvider } from '../src/integrations/receipts/mock.js';
import type { MockPaymentProvider } from '../src/integrations/payments/mock.js';
import type { MockNotificationProvider } from '../src/integrations/notifications/mock.js';

export function createTestDb(): Db {
  // מופעי הספקים נשמרים במטמון לפי מזהה עמותה. איפוס בין טסטים מונע דליפת מצב.
  resetProviderCaches();
  return openInMemoryDatabase();
}

export function makeOrganization(
  db: Db,
  overrides: { name?: string; receiptIssueMode?: ReceiptIssueMode } = {},
) {
  return createOrganization(db, {
    name: overrides.name ?? 'בית הכנסת',
    legalNumber: '580000000',
    allowedDocumentTypes: ['receipt', 'donation_receipt'],
    defaultDocumentType: 'receipt',
    receiptIssueMode: overrides.receiptIssueMode ?? 'automatic',
  });
}

export function makeMember(db: Db, overrides: Partial<{ firstName: string; lastName: string; email: string; phone: string }> = {}) {
  return createMember(db, {
    firstName: overrides.firstName ?? 'יעקב',
    lastName: overrides.lastName ?? 'כהן',
    email: overrides.email ?? 'yaakov@example.com',
    phone: overrides.phone ?? '050-1112233',
  });
}

export function typeId(db: Db, key: string): number {
  const type = listCommitmentTypes(db).find((item) => item.key === key);
  if (!type) throw new Error(`סוג התחייבות ${key} לא נמצא`);
  return type.id;
}

export function makeCommitment(
  db: Db,
  options: {
    memberId: number;
    organizationId: number;
    amountShekels: number;
    typeKey?: string;
    commitmentDate?: string;
    dueDate?: string | null;
  },
) {
  return createCommitment(db, {
    memberId: options.memberId,
    organizationId: options.organizationId,
    commitmentTypeId: typeId(db, options.typeKey ?? 'aliyah'),
    amountAgorot: shekelsToAgorot(options.amountShekels),
    ...(options.commitmentDate ? { commitmentDate: options.commitmentDate } : {}),
    dueDate: options.dueDate ?? null,
  });
}

export function receiptProviderFor(db: Db, organizationId: number): MockReceiptProvider {
  return resolveReceiptProvider(getOrganizationRow(db, organizationId)) as MockReceiptProvider;
}

export function paymentProviderFor(db: Db, organizationId: number): MockPaymentProvider {
  return resolvePaymentProvider(getOrganizationRow(db, organizationId)) as MockPaymentProvider;
}

export function notificationProviderFor(db: Db, organizationId: number): MockNotificationProvider {
  return resolveNotificationProvider(getOrganizationRow(db, organizationId)) as MockNotificationProvider;
}

/** תאריך ביחס להיום, בפורמט YYYY-MM-DD. */
export function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
