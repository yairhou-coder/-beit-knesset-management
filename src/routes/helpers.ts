import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { shekelsToAgorot } from '../domain/money.js';
import { ValidationError } from '../services/errors.js';

/** עוטף handler אסינכרוני כך ששגיאות יגיעו ל-error middleware. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function intParam(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${field}: מזהה לא תקין`);
  }
  return parsed;
}

export function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function optionalBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return undefined;
}

/**
 * מקבל סכום מהבקשה. מקבל `amountAgorot` (מספר שלם) או `amountShekels`.
 * העדפה לאגורות - זהו הפורמט הפנימי של המערכת.
 */
export function readAmountAgorot(body: Record<string, unknown>, field = 'סכום'): number {
  if (body['amountAgorot'] !== undefined) {
    const value = Number(body['amountAgorot']);
    if (!Number.isInteger(value)) throw new ValidationError(`${field}: יש לציין אגורות שלמות`);
    return value;
  }
  if (body['amountShekels'] !== undefined) {
    return shekelsToAgorot(body['amountShekels'] as number | string);
  }
  throw new ValidationError(`${field}: שדה חובה (amountAgorot או amountShekels)`);
}

export function optionalAmountAgorot(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/** מוציא את גוף הבקשה כאובייקט. */
export function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/** בונה רשימת ערכים מפרמטר שיכול להופיע פעם אחת או כמה פעמים. */
export function asArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
