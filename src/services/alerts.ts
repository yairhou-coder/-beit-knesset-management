/** התראות למנהל (סעיף 28). */

import type { Db } from '../db/index.js';
import type { AlertSeverity } from '../domain/types.js';
import { WhereBuilder } from './util.js';

export interface AlertInput {
  severity?: AlertSeverity;
  kind: string;
  title: string;
  message?: string | null;
  organizationId?: number | null;
  relatedType?: string | null;
  relatedId?: number | null;
}

export interface AlertView {
  id: number;
  severity: AlertSeverity;
  kind: string;
  title: string;
  message: string | null;
  organizationId: number | null;
  relatedType: string | null;
  relatedId: number | null;
  resolved: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

interface AlertRow {
  id: number;
  severity: AlertSeverity;
  kind: string;
  title: string;
  message: string | null;
  organization_id: number | null;
  related_type: string | null;
  related_id: number | null;
  resolved: number;
  resolved_at: string | null;
  created_at: string;
}

function toView(row: AlertRow): AlertView {
  return {
    id: row.id,
    severity: row.severity,
    kind: row.kind,
    title: row.title,
    message: row.message,
    organizationId: row.organization_id,
    relatedType: row.related_type,
    relatedId: row.related_id,
    resolved: row.resolved === 1,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

export function raiseAlert(db: Db, input: AlertInput): AlertView {
  // התראה פתוחה קיימת על אותו נושא מתעדכנת במקום להיווצר מחדש,
  // כדי שניסיונות חוזרים לא יציפו את המנהל.
  const existing = db
    .prepare(
      `SELECT * FROM admin_alerts
       WHERE kind = ? AND related_type IS ? AND related_id IS ? AND resolved = 0
       ORDER BY id DESC LIMIT 1`,
    )
    .get(input.kind, input.relatedType ?? null, input.relatedId ?? null) as AlertRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE admin_alerts SET title = ?, message = ?, severity = ?, created_at = datetime('now')
       WHERE id = ?`,
    ).run(input.title, input.message ?? null, input.severity ?? 'warning', existing.id);
    return getAlert(db, existing.id)!;
  }

  const result = db
    .prepare(
      `INSERT INTO admin_alerts
         (severity, kind, title, message, organization_id, related_type, related_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.severity ?? 'warning',
      input.kind,
      input.title,
      input.message ?? null,
      input.organizationId ?? null,
      input.relatedType ?? null,
      input.relatedId ?? null,
    );
  return getAlert(db, Number(result.lastInsertRowid))!;
}

export function getAlert(db: Db, id: number): AlertView | null {
  const row = db.prepare('SELECT * FROM admin_alerts WHERE id = ?').get(id) as AlertRow | undefined;
  return row ? toView(row) : null;
}

export function listAlerts(
  db: Db,
  filters: { resolved?: boolean; kind?: string; organizationId?: number; limit?: number } = {},
): AlertView[] {
  const where = new WhereBuilder();
  if (filters.resolved !== undefined) where.add('resolved = ?', filters.resolved ? 1 : 0);
  where.addIf(filters.kind, 'kind = ?', filters.kind);
  where.addIf(filters.organizationId, 'organization_id = ?', filters.organizationId);
  const rows = db
    .prepare(`SELECT * FROM admin_alerts ${where.sql} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...where.values, Math.min(filters.limit ?? 100, 500)) as AlertRow[];
  return rows.map(toView);
}

export function resolveAlert(db: Db, id: number): void {
  db.prepare(
    `UPDATE admin_alerts SET resolved = 1, resolved_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

/** סוגר אוטומטית התראות פתוחות על נושא שנפתר (למשל קבלה שהופקה בניסיון חוזר). */
export function resolveAlertsFor(db: Db, relatedType: string, relatedId: number, kind?: string): void {
  const where = new WhereBuilder()
    .add('related_type = ?', relatedType)
    .add('related_id = ?', relatedId)
    .add('resolved = 0');
  where.addIf(kind, 'kind = ?', kind);
  db.prepare(
    `UPDATE admin_alerts SET resolved = 1, resolved_at = datetime('now') ${where.sql}`,
  ).run(...where.values);
}
