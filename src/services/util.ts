import type { Db } from '../db/index.js';
import { NotFoundError } from './errors.js';

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** מספר הימים שחלפו מאז תאריך נתון (YYYY-MM-DD). */
export function daysSince(date: string, reference: string = today()): number {
  const from = Date.parse(`${date}T00:00:00Z`);
  const to = Date.parse(`${reference}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** תחילת החודש הנוכחי, YYYY-MM-01. */
export function startOfMonth(reference: string = today()): string {
  return `${reference.slice(0, 7)}-01`;
}

export function assertRowExists<T>(row: T | undefined, what: string): T {
  if (!row) throw new NotFoundError(what);
  return row;
}

export function boolToInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function intToBool(value: number | null | undefined): boolean {
  return value === 1;
}

/** בונה תנאי WHERE דינמי בצורה בטוחה מפני SQL injection (פרמטרים בלבד). */
export class WhereBuilder {
  private readonly clauses: string[] = [];
  private readonly params: unknown[] = [];

  add(clause: string, ...values: unknown[]): this {
    this.clauses.push(clause);
    this.params.push(...values);
    return this;
  }

  addIf(condition: unknown, clause: string, ...values: unknown[]): this {
    if (condition !== undefined && condition !== null && condition !== '') {
      this.add(clause, ...values);
    }
    return this;
  }

  /** תנאי IN עם מספר משתנה של ערכים. */
  addIn(column: string, values: readonly unknown[] | undefined): this {
    if (values && values.length > 0) {
      this.add(`${column} IN (${values.map(() => '?').join(',')})`, ...values);
    }
    return this;
  }

  get sql(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }

  get values(): unknown[] {
    return this.params;
  }
}

/** בודק שם עמודה מול רשימה מותרת, למיון דינמי. */
export function safeOrderBy(
  requested: string | undefined,
  allowed: Record<string, string>,
  fallback: string,
): string {
  if (!requested) return fallback;
  const [column, direction] = requested.split(':');
  const mapped = column ? allowed[column] : undefined;
  if (!mapped) return fallback;
  return `${mapped} ${direction?.toLowerCase() === 'asc' ? 'ASC' : 'DESC'}`;
}

export function transaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}
