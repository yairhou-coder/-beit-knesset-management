/** ניהול חברי קהילה. */

import type { Db } from '../db/index.js';
import { NotFoundError, ValidationError } from './errors.js';
import { NOTIFICATION_CHANNELS, isOneOf, type NotificationChannel } from '../domain/types.js';
import { WhereBuilder } from './util.js';

export interface MemberRow {
  id: number;
  first_name: string;
  last_name: string;
  hebrew_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  preferred_channel: NotificationChannel | null;
  notes: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface MemberView {
  id: number;
  firstName: string;
  lastName: string;
  fullName: string;
  hebrewName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  preferredChannel: NotificationChannel | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
}

export interface MemberInput {
  firstName: string;
  lastName: string;
  hebrewName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  preferredChannel?: NotificationChannel | null;
  notes?: string | null;
  active?: boolean;
}

export function toMemberView(row: MemberRow): MemberView {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`.trim(),
    hebrewName: row.hebrew_name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    preferredChannel: row.preferred_channel,
    notes: row.notes,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export function listMembers(
  db: Db,
  filters: { search?: string; includeInactive?: boolean } = {},
): MemberView[] {
  const where = new WhereBuilder();
  if (!filters.includeInactive) where.add('active = 1');
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    where.add(
      '(first_name LIKE ? OR last_name LIKE ? OR (first_name || " " || last_name) LIKE ? OR hebrew_name LIKE ? OR phone LIKE ? OR email LIKE ?)',
      term,
      term,
      term,
      term,
      term,
      term,
    );
  }
  const rows = db
    .prepare(`SELECT * FROM members ${where.sql} ORDER BY last_name, first_name`)
    .all(...where.values) as MemberRow[];
  return rows.map(toMemberView);
}

export function getMemberRow(db: Db, id: number): MemberRow {
  const row = db.prepare('SELECT * FROM members WHERE id = ?').get(id) as MemberRow | undefined;
  if (!row) throw new NotFoundError(`חבר ${id}`);
  return row;
}

export function getMember(db: Db, id: number): MemberView {
  return toMemberView(getMemberRow(db, id));
}

function validateChannel(value: unknown): NotificationChannel | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isOneOf(NOTIFICATION_CHANNELS, value)) {
    throw new ValidationError(`ערוץ תקשורת לא מוכר: ${String(value)}`);
  }
  return value;
}

export function createMember(db: Db, input: MemberInput): MemberView {
  if (!input.firstName?.trim() || !input.lastName?.trim()) {
    throw new ValidationError('שם פרטי ושם משפחה הם שדות חובה');
  }
  const result = db
    .prepare(
      `INSERT INTO members
        (first_name, last_name, hebrew_name, phone, email, address, preferred_channel, notes, active)
       VALUES (@first_name, @last_name, @hebrew_name, @phone, @email, @address, @preferred_channel, @notes, @active)`,
    )
    .run({
      first_name: input.firstName.trim(),
      last_name: input.lastName.trim(),
      hebrew_name: input.hebrewName ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      preferred_channel: validateChannel(input.preferredChannel),
      notes: input.notes ?? null,
      active: input.active === false ? 0 : 1,
    });
  return getMember(db, Number(result.lastInsertRowid));
}

export function updateMember(db: Db, id: number, input: Partial<MemberInput>): MemberView {
  const existing = getMemberRow(db, id);
  db.prepare(
    `UPDATE members SET
       first_name = @first_name, last_name = @last_name, hebrew_name = @hebrew_name,
       phone = @phone, email = @email, address = @address,
       preferred_channel = @preferred_channel, notes = @notes, active = @active,
       updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id,
    first_name: input.firstName?.trim() ?? existing.first_name,
    last_name: input.lastName?.trim() ?? existing.last_name,
    hebrew_name: input.hebrewName !== undefined ? input.hebrewName : existing.hebrew_name,
    phone: input.phone !== undefined ? input.phone : existing.phone,
    email: input.email !== undefined ? input.email : existing.email,
    address: input.address !== undefined ? input.address : existing.address,
    preferred_channel:
      input.preferredChannel !== undefined
        ? validateChannel(input.preferredChannel)
        : existing.preferred_channel,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    active: input.active === undefined ? existing.active : input.active ? 1 : 0,
  });
  return getMember(db, id);
}
