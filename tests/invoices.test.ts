/**
 * חילוץ נתונים מחשבונית.
 * העיקרון הנבדק: עדיף להחזיר "לא ידוע" מאשר סכום שגוי.
 */

import { describe, expect, it } from 'vitest';
import { HeuristicInvoiceProvider } from '../src/integrations/invoices/heuristic.js';

const provider = new HeuristicInvoiceProvider();

// עברית נשמרת ב-UTF-8. קידוד latin1 היה משבש אותה, ואז מילות המפתח
// בעברית לעולם לא היו נמצאות - וזה בדיוק מה שהטסט אמור לוודא.
function pdf(...lines: string[]) {
  const body = lines.map((line) => `BT (${line}) Tj ET`).join('\n');
  return {
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
    data: Buffer.from(`%PDF-1.4\nstream\n${body}\nendstream\n%%EOF`, 'utf8'),
  };
}

describe('חילוץ מחשבונית', () => {
  it('אינו מבלבל בין מספר החשבונית לסכום', async () => {
    const result = await provider.extract(
      pdf('חשבונית מס 458812', 'סה"כ לתשלום 1,250.00', 'תאריך 15/08/2026'),
    );
    expect(result.amountAgorot).toBe(125_000); // 1,250 ולא 458,812
    expect(result.invoiceNumber).toBe('458812');
    expect(result.date).toBe('2026-08-15');
  });

  it('מזהה סכום שצמוד לסימן מטבע', async () => {
    const result = await provider.extract(pdf('עבור ניקיון', '640.00 ₪'));
    expect(result.amountAgorot).toBe(64_000);
  });

  it('אינו מחזיר סכום כשאין לו עוגן', async () => {
    // מספרים ללא הקשר - מספר לקוח, טלפון, ת"ז
    const result = await provider.extract(pdf('לקוח 88231', 'טלפון 0501234567'));
    expect(result.amountAgorot).toBeNull();
    expect(result.confidence).not.toBe('medium');
  });

  it('אינו קורא את שם הקובץ כמספר חשבונית', async () => {
    const result = await provider.extract({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      data: Buffer.from('%PDF-1.4\n%%EOF', 'latin1'),
    });
    expect(result.invoiceNumber).toBeNull();
  });

  it('קובץ תמונה מוחזר בלי נתונים ועם הסבר', async () => {
    const result = await provider.extract({
      filename: 'scan.jpg',
      mimeType: 'image/jpeg',
      data: Buffer.from([0xff, 0xd8, 0xff]),
    });
    expect(result.amountAgorot).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.note).toContain('OCR');
  });

  it('בוחר את הסכום הכולל כשיש כמה סכומים', async () => {
    const result = await provider.extract(
      pdf('פריט א 300.00', 'פריט ב 450.00', 'סה"כ לתשלום 750.00'),
    );
    expect(result.amountAgorot).toBe(75_000);
  });
});
