/** טיפול בכסף: אגורות שלמות, ללא שגיאות עיגול. */

import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  agorotToShekels,
  assertPositiveAgorot,
  formatAgorot,
  shekelsToAgorot,
  sumAgorot,
} from '../src/domain/money.js';

describe('המרות כסף', () => {
  it('ממיר שקלים לאגורות שלמות', () => {
    expect(shekelsToAgorot(1800)).toBe(180_000);
    expect(shekelsToAgorot(0.01)).toBe(1);
    expect(shekelsToAgorot('1,800')).toBe(180_000);
    expect(shekelsToAgorot('1800 ₪')).toBe(180_000);
    expect(shekelsToAgorot(12.34)).toBe(1234);
  });

  it('מונע שגיאות עיגול של נקודה צפה', () => {
    // 0.1 + 0.2 !== 0.3 בנקודה צפה. באגורות שלמות אין בעיה כזו.
    expect(sumAgorot([shekelsToAgorot(0.1), shekelsToAgorot(0.2)])).toBe(shekelsToAgorot(0.3));

    // חלוקת 1,800 ל-3 תשלומים חוזרת בדיוק לסכום המקורי.
    const parts = [60_000, 60_000, 60_000];
    expect(sumAgorot(parts)).toBe(shekelsToAgorot(1800));
  });

  it('דוחה סכומים לא תקינים', () => {
    expect(() => assertPositiveAgorot(0)).toThrow(MoneyError);
    expect(() => assertPositiveAgorot(-100)).toThrow(MoneyError);
    expect(() => assertPositiveAgorot(10.5)).toThrow(/מספר שלם באגורות/);
    expect(() => shekelsToAgorot('לא מספר')).toThrow(MoneyError);
  });

  it('מפרמט סכומים בעברית', () => {
    expect(formatAgorot(180_000)).toContain('1,800');
    expect(formatAgorot(180_050)).toContain('1,800.5');
    expect(agorotToShekels(180_000)).toBe(1800);
  });
});
