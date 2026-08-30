/**
 * ניהול עמותות / ישויות משפטיות (סעיף 25).
 * כל רשומה כספית במערכת משויכת לעמותה, ואין ערבוב בין נתוני העמותות.
 */

import type { Db } from '../db/index.js';
import { NotFoundError, ValidationError } from './errors.js';
import { resetProviderCaches } from '../integrations/registry.js';
import {
  DOCUMENT_TYPES,
  RECEIPT_ISSUE_MODES,
  isOneOf,
  type DocumentType,
  type ReceiptIssueMode,
} from '../domain/types.js';

export interface OrganizationRow {
  id: number;
  name: string;
  short_name: string | null;
  legal_number: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  bank_name: string | null;
  bank_branch: string | null;
  bank_account: string | null;
  account_holder: string | null;
  payment_provider: string;
  payment_config: string;
  receipt_provider: string;
  receipt_config: string;
  notification_provider: string;
  notification_config: string;
  allowed_document_types: string;
  default_document_type: string;
  receipt_issue_mode: ReceiptIssueMode;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface OrganizationInput {
  name: string;
  shortName?: string | null;
  legalNumber?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  bankAccount?: string | null;
  accountHolder?: string | null;
  paymentProvider?: string;
  paymentConfig?: Record<string, unknown>;
  receiptProvider?: string;
  receiptConfig?: Record<string, unknown>;
  notificationProvider?: string;
  notificationConfig?: Record<string, unknown>;
  allowedDocumentTypes?: DocumentType[];
  defaultDocumentType?: DocumentType;
  receiptIssueMode?: ReceiptIssueMode;
  active?: boolean;
}

/**
 * תצוגת עמותה כלפי חוץ. פרטי ה-Integration הרגישים (מפתחות API) אינם נחשפים,
 * רק שם הספק והאם הוא מוגדר.
 */
export interface OrganizationView {
  id: number;
  name: string;
  shortName: string | null;
  legalNumber: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  bank: { name: string | null; branch: string | null; account: string | null; holder: string | null };
  integrations: {
    payment: { provider: string; configured: boolean };
    receipt: { provider: string; configured: boolean };
    notification: { provider: string; configured: boolean };
  };
  allowedDocumentTypes: DocumentType[];
  defaultDocumentType: DocumentType;
  receiptIssueMode: ReceiptIssueMode;
  active: boolean;
  createdAt: string;
}

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseDocumentTypes(raw: string): DocumentType[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ['receipt'];
    const valid = parsed.filter((value): value is DocumentType => isOneOf(DOCUMENT_TYPES, value));
    return valid.length > 0 ? valid : ['receipt'];
  } catch {
    return ['receipt'];
  }
}

export function toOrganizationView(row: OrganizationRow): OrganizationView {
  const allowed = parseDocumentTypes(row.allowed_document_types);
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    legalNumber: row.legal_number,
    address: row.address,
    phone: row.phone,
    email: row.email,
    bank: {
      name: row.bank_name,
      branch: row.bank_branch,
      account: row.bank_account,
      holder: row.account_holder,
    },
    integrations: {
      payment: {
        provider: row.payment_provider,
        configured: Object.keys(parseJsonObject(row.payment_config)).length > 0,
      },
      receipt: {
        provider: row.receipt_provider,
        configured: Object.keys(parseJsonObject(row.receipt_config)).length > 0,
      },
      notification: {
        provider: row.notification_provider,
        configured: Object.keys(parseJsonObject(row.notification_config)).length > 0,
      },
    },
    allowedDocumentTypes: allowed,
    defaultDocumentType: isOneOf(DOCUMENT_TYPES, row.default_document_type)
      ? row.default_document_type
      : (allowed[0] ?? 'receipt'),
    receiptIssueMode: row.receipt_issue_mode,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export function listOrganizations(db: Db, options: { includeInactive?: boolean } = {}): OrganizationView[] {
  const rows = db
    .prepare(
      `SELECT * FROM organizations ${options.includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`,
    )
    .all() as OrganizationRow[];
  return rows.map(toOrganizationView);
}

export function getOrganizationRow(db: Db, id: number): OrganizationRow {
  const row = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as
    | OrganizationRow
    | undefined;
  if (!row) throw new NotFoundError(`עמותה ${id}`);
  return row;
}

export function getOrganization(db: Db, id: number): OrganizationView {
  return toOrganizationView(getOrganizationRow(db, id));
}

function validateDocumentTypes(input: OrganizationInput): {
  allowed: DocumentType[];
  defaultType: DocumentType;
} {
  const allowed: DocumentType[] = input.allowedDocumentTypes?.length
    ? input.allowedDocumentTypes
    : ['receipt'];
  for (const type of allowed) {
    if (!isOneOf(DOCUMENT_TYPES, type)) {
      throw new ValidationError(`סוג מסמך לא מוכר: ${String(type)}`);
    }
  }
  const defaultType: DocumentType = input.defaultDocumentType ?? allowed[0]!;
  if (!isOneOf(DOCUMENT_TYPES, defaultType)) {
    throw new ValidationError(`סוג מסמך לא מוכר: ${String(defaultType)}`);
  }
  if (!allowed.includes(defaultType)) {
    throw new ValidationError('סוג מסמך ברירת המחדל אינו נכלל בסוגי המסמכים המותרים לעמותה');
  }
  return { allowed, defaultType };
}

export function createOrganization(db: Db, input: OrganizationInput): OrganizationView {
  if (!input.name?.trim()) throw new ValidationError('שם העמותה הוא שדה חובה');
  const { allowed, defaultType } = validateDocumentTypes(input);
  const mode = input.receiptIssueMode ?? 'automatic';
  if (!isOneOf(RECEIPT_ISSUE_MODES, mode)) {
    throw new ValidationError(`אופן הפקת קבלות לא מוכר: ${String(mode)}`);
  }

  const result = db
    .prepare(
      `INSERT INTO organizations
        (name, short_name, legal_number, address, phone, email,
         bank_name, bank_branch, bank_account, account_holder,
         payment_provider, payment_config, receipt_provider, receipt_config,
         notification_provider, notification_config,
         allowed_document_types, default_document_type, receipt_issue_mode, active)
       VALUES (@name, @short_name, @legal_number, @address, @phone, @email,
               @bank_name, @bank_branch, @bank_account, @account_holder,
               @payment_provider, @payment_config, @receipt_provider, @receipt_config,
               @notification_provider, @notification_config,
               @allowed_document_types, @default_document_type, @receipt_issue_mode, @active)`,
    )
    .run({
      name: input.name.trim(),
      short_name: input.shortName ?? null,
      legal_number: input.legalNumber ?? null,
      address: input.address ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      bank_name: input.bankName ?? null,
      bank_branch: input.bankBranch ?? null,
      bank_account: input.bankAccount ?? null,
      account_holder: input.accountHolder ?? null,
      payment_provider: input.paymentProvider ?? 'mock',
      payment_config: JSON.stringify(input.paymentConfig ?? {}),
      receipt_provider: input.receiptProvider ?? 'mock',
      receipt_config: JSON.stringify(input.receiptConfig ?? {}),
      notification_provider: input.notificationProvider ?? 'mock',
      notification_config: JSON.stringify(input.notificationConfig ?? {}),
      allowed_document_types: JSON.stringify(allowed),
      default_document_type: defaultType,
      receipt_issue_mode: mode,
      active: input.active === false ? 0 : 1,
    });

  return getOrganization(db, Number(result.lastInsertRowid));
}

export function updateOrganization(
  db: Db,
  id: number,
  input: Partial<OrganizationInput>,
): OrganizationView {
  const existing = getOrganizationRow(db, id);

  const allowedTypes = input.allowedDocumentTypes ?? parseDocumentTypes(existing.allowed_document_types);
  // ברירת מחדל שנשלחה במפורש ואינה מורשית היא שגיאה של המשתמש ויש לדווח עליה.
  // לעומת זאת, ברירת מחדל *קיימת* שיצאה מהרשימה בעקבות צמצום הסוגים המותרים
  // מותאמת בשקט לסוג המורשה הראשון, כדי שצמצום הרשימה לא ייכשל.
  const requestedDefault = input.defaultDocumentType;
  const inheritedDefault = existing.default_document_type as DocumentType;
  const defaultType =
    requestedDefault ?? (allowedTypes.includes(inheritedDefault) ? inheritedDefault : allowedTypes[0]);
  const { allowed, defaultType: resolvedDefault } = validateDocumentTypes({
    name: existing.name,
    allowedDocumentTypes: allowedTypes,
    defaultDocumentType: defaultType,
  });

  const mode = input.receiptIssueMode ?? existing.receipt_issue_mode;
  if (!isOneOf(RECEIPT_ISSUE_MODES, mode)) {
    throw new ValidationError(`אופן הפקת קבלות לא מוכר: ${String(mode)}`);
  }

  db.prepare(
    `UPDATE organizations SET
       name = @name, short_name = @short_name, legal_number = @legal_number,
       address = @address, phone = @phone, email = @email,
       bank_name = @bank_name, bank_branch = @bank_branch,
       bank_account = @bank_account, account_holder = @account_holder,
       payment_provider = @payment_provider, payment_config = @payment_config,
       receipt_provider = @receipt_provider, receipt_config = @receipt_config,
       notification_provider = @notification_provider, notification_config = @notification_config,
       allowed_document_types = @allowed_document_types,
       default_document_type = @default_document_type,
       receipt_issue_mode = @receipt_issue_mode, active = @active,
       updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id,
    name: input.name?.trim() ?? existing.name,
    short_name: input.shortName !== undefined ? input.shortName : existing.short_name,
    legal_number: input.legalNumber !== undefined ? input.legalNumber : existing.legal_number,
    address: input.address !== undefined ? input.address : existing.address,
    phone: input.phone !== undefined ? input.phone : existing.phone,
    email: input.email !== undefined ? input.email : existing.email,
    bank_name: input.bankName !== undefined ? input.bankName : existing.bank_name,
    bank_branch: input.bankBranch !== undefined ? input.bankBranch : existing.bank_branch,
    bank_account: input.bankAccount !== undefined ? input.bankAccount : existing.bank_account,
    account_holder: input.accountHolder !== undefined ? input.accountHolder : existing.account_holder,
    payment_provider: input.paymentProvider ?? existing.payment_provider,
    payment_config:
      input.paymentConfig !== undefined ? JSON.stringify(input.paymentConfig) : existing.payment_config,
    receipt_provider: input.receiptProvider ?? existing.receipt_provider,
    receipt_config:
      input.receiptConfig !== undefined ? JSON.stringify(input.receiptConfig) : existing.receipt_config,
    notification_provider: input.notificationProvider ?? existing.notification_provider,
    notification_config:
      input.notificationConfig !== undefined
        ? JSON.stringify(input.notificationConfig)
        : existing.notification_config,
    allowed_document_types: JSON.stringify(allowed),
    default_document_type: resolvedDefault,
    receipt_issue_mode: mode,
    active: input.active === undefined ? existing.active : input.active ? 1 : 0,
  });

  // הגדרות ה-Integration השתנו - יש לבנות מחדש את מופעי הספקים של העמותה.
  resetProviderCaches(id);
  return getOrganization(db, id);
}

/** אופן הפקת הקבלות של העמותה (סעיף 29). */
export function getReceiptIssueMode(db: Db, organizationId: number): ReceiptIssueMode {
  const row = db
    .prepare('SELECT receipt_issue_mode FROM organizations WHERE id = ?')
    .get(organizationId) as { receipt_issue_mode: ReceiptIssueMode } | undefined;
  if (!row) throw new NotFoundError(`עמותה ${organizationId}`);
  return row.receipt_issue_mode;
}
