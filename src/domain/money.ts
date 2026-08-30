/**
 * כל הסכומים במערכת נשמרים כמספרים שלמים באגורות (agorot).
 * שימוש ב-float עבור כסף גורם לשגיאות עיגול, ולכן כל שדה כספי בבסיס הנתונים
 * ובשכבת ה-API הוא INTEGER באגורות. המרה לשקלים נעשית רק בשכבת התצוגה.
 */

export type Agorot = number;

export class MoneyError extends Error {}

/** ממיר שקלים (מספר או מחרוזת מהטופס) לאגורות שלמות. */
export function shekelsToAgorot(shekels: number | string): Agorot {
  const value = typeof shekels === 'string' ? Number(shekels.replace(/[,\s₪]/g, '')) : shekels;
  if (!Number.isFinite(value)) throw new MoneyError(`סכום לא תקין: ${shekels}`);
  return Math.round(value * 100);
}

/** ממיר אגורות לשקלים (לתצוגה בלבד). */
export function agorotToShekels(agorot: Agorot): number {
  assertAgorot(agorot);
  return agorot / 100;
}

/** אימות שהערך הוא סכום תקין באגורות. */
export function assertAgorot(value: unknown, field = 'amount'): asserts value is Agorot {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MoneyError(`${field}: סכום חייב להיות מספר שלם באגורות (התקבל ${String(value)})`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${field}: הסכום חורג מהטווח הנתמך`);
  }
}

/** אימות שהסכום חיובי ממש (למשל סכום התחייבות או תשלום). */
export function assertPositiveAgorot(value: unknown, field = 'amount'): asserts value is Agorot {
  assertAgorot(value, field);
  if (value <= 0) throw new MoneyError(`${field}: הסכום חייב להיות גדול מאפס`);
}

/** פורמט תצוגה בעברית, למשל 1800 ₪. */
export function formatAgorot(agorot: Agorot): string {
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    minimumFractionDigits: agorot % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(agorotToShekels(agorot));
}

export function sumAgorot(values: readonly Agorot[]): Agorot {
  return values.reduce<Agorot>((total, value) => {
    assertAgorot(value);
    return total + value;
  }, 0);
}
