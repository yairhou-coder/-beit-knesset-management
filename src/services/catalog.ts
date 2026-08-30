/** סוגי התחייבות ואירועים - נתוני עזר לסינון ולטפסים. */

import type { Db } from '../db/index.js';
import { NotFoundError, ValidationError } from './errors.js';
import { EVENT_KINDS, isOneOf, type EventKind, type DocumentType } from '../domain/types.js';

export interface CommitmentTypeRow {
  id: number;
  key: string;
  name: string;
  document_type: string;
  active: number;
  sort_order: number;
}

export interface CommitmentTypeView {
  id: number;
  key: string;
  name: string;
  documentType: DocumentType;
  active: boolean;
}

export function listCommitmentTypes(db: Db, includeInactive = false): CommitmentTypeView[] {
  const rows = db
    .prepare(
      `SELECT * FROM commitment_types ${includeInactive ? '' : 'WHERE active = 1'}
       ORDER BY sort_order, name`,
    )
    .all() as CommitmentTypeRow[];
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    documentType: row.document_type as DocumentType,
    active: row.active === 1,
  }));
}

export function getCommitmentTypeRow(db: Db, id: number): CommitmentTypeRow {
  const row = db.prepare('SELECT * FROM commitment_types WHERE id = ?').get(id) as
    | CommitmentTypeRow
    | undefined;
  if (!row) throw new NotFoundError(`סוג התחייבות ${id}`);
  return row;
}

export function createCommitmentType(
  db: Db,
  input: { key: string; name: string; documentType?: DocumentType; sortOrder?: number },
): CommitmentTypeView {
  if (!input.key?.trim() || !input.name?.trim()) {
    throw new ValidationError('מפתח ושם הם שדות חובה עבור סוג התחייבות');
  }
  const result = db
    .prepare(
      `INSERT INTO commitment_types (key, name, document_type, sort_order)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.key.trim(), input.name.trim(), input.documentType ?? 'receipt', input.sortOrder ?? 100);
  const row = getCommitmentTypeRow(db, Number(result.lastInsertRowid));
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    documentType: row.document_type as DocumentType,
    active: row.active === 1,
  };
}

// --- אירועים / שבתות / חגים -------------------------------------------------

export interface EventRow {
  id: number;
  name: string;
  kind: EventKind;
  hebrew_date: string | null;
  gregorian_date: string | null;
  organization_id: number | null;
  notes: string | null;
  created_at: string;
}

export interface EventView {
  id: number;
  name: string;
  kind: EventKind;
  hebrewDate: string | null;
  gregorianDate: string | null;
  organizationId: number | null;
  notes: string | null;
}

function toEventView(row: EventRow): EventView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    hebrewDate: row.hebrew_date,
    gregorianDate: row.gregorian_date,
    organizationId: row.organization_id,
    notes: row.notes,
  };
}

export function listEvents(db: Db, filters: { organizationId?: number } = {}): EventView[] {
  const rows = filters.organizationId
    ? (db
        .prepare(
          `SELECT * FROM events WHERE organization_id = ? OR organization_id IS NULL
           ORDER BY COALESCE(gregorian_date, '') DESC, name`,
        )
        .all(filters.organizationId) as EventRow[])
    : (db
        .prepare(`SELECT * FROM events ORDER BY COALESCE(gregorian_date, '') DESC, name`)
        .all() as EventRow[]);
  return rows.map(toEventView);
}

export function getEvent(db: Db, id: number): EventView {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  if (!row) throw new NotFoundError(`אירוע ${id}`);
  return toEventView(row);
}

export function createEvent(
  db: Db,
  input: {
    name: string;
    kind?: EventKind;
    hebrewDate?: string | null;
    gregorianDate?: string | null;
    organizationId?: number | null;
    notes?: string | null;
  },
): EventView {
  if (!input.name?.trim()) throw new ValidationError('שם האירוע הוא שדה חובה');
  const kind = input.kind ?? 'event';
  if (!isOneOf(EVENT_KINDS, kind)) throw new ValidationError(`סוג אירוע לא מוכר: ${String(kind)}`);
  const result = db
    .prepare(
      `INSERT INTO events (name, kind, hebrew_date, gregorian_date, organization_id, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name.trim(),
      kind,
      input.hebrewDate ?? null,
      input.gregorianDate ?? null,
      input.organizationId ?? null,
      input.notes ?? null,
    );
  return getEvent(db, Number(result.lastInsertRowid));
}
