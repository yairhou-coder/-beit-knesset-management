/**
 * חילוץ נתונים מחשבונית.
 *
 * הממשק בנוי כמו שאר הספקים במערכת, כדי שניתן יהיה לחבר בעתיד שירות OCR
 * או שירות בינה מלאכותית בלי לשנות את לוגיקת ההוצאות.
 *
 * המימוש שכאן הוא היוריסטי בלבד: הוא מחפש סכום, מספר חשבונית ותאריך בטקסט
 * הגלוי של הקובץ ובשם הקובץ. הוא אינו מבצע OCR ואינו קורא חשבונית סרוקה.
 *
 * חשוב: התוצאה היא *הצעה בלבד*. היא ממלאת מראש את הטופס והמשתמש מאשר -
 * לעולם אין רישום אוטומטי של סכום כספי בלי אישור אנושי.
 */

import type { ExtractedInvoice, InvoiceExtractionProvider, UploadedFile } from '../types.js';
import { shekelsToAgorot } from '../../domain/money.js';

/**
 * מחלץ טקסט קריא מקובץ, ככל שיש בו. אינו מבצע OCR.
 *
 * הקובץ נקרא גם כ-latin1 וגם כ-UTF-8: ב-PDF רבים הטקסט אינו UTF-8, אך
 * כאשר כן - זו הדרך היחידה לקרוא עברית. מכאן גם המגבלה המרכזית של מימוש
 * זה: ברוב קובצי ה-PDF העברית מקודדת לפי הגופן ואינה ניתנת לקריאה בלי
 * OCR, ולכן מילות מפתח בעברית לא תמיד יימצאו. המספרים והתאריכים, שהם
 * ASCII, נקראים בדרך כלל היטב.
 */
function readableText(file: UploadedFile): string {
  if (file.mimeType.startsWith('image/')) return '';

  const extractStreams = (raw: string): string => {
    // ב-PDF הטקסט הגלוי מופיע בין סוגריים בתוך פקודות הציור
    const chunks = raw.match(/\(([^()\\]{2,200})\)/g);
    return chunks ? chunks.map((chunk) => chunk.slice(1, -1)).join(' ') : '';
  };

  const latin = file.data.toString('latin1');
  const utf8 = file.data.toString('utf8');
  const isPdf = latin.startsWith('%PDF');

  return [
    extractStreams(latin),
    extractStreams(utf8),
    isPdf ? '' : utf8.slice(0, 20_000),
  ].join(' ');
}

/**
 * מאתר את סכום החשבונית.
 *
 * "המספר הגדול ביותר" הוא כלל גרוע: מספר החשבונית לרוב גדול מהסכום.
 * לכן הסכום מזוהה רק כשהוא *מעוגן* - סמוך למילה כמו "סה\"כ" או "לתשלום",
 * צמוד לסימן ₪, או כתוב עם שתי ספרות אחרי הנקודה. סכום שאינו מעוגן אינו
 * מוחזר כלל: בנתונים כספיים, מספר שגוי גרוע ממספר חסר.
 */
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?`;

function parseAmount(whole: string, decimals?: string): number {
  return Number(`${whole.replace(/,/g, '')}.${decimals ?? '0'}`);
}

function findAmount(text: string): number | undefined {
  const anchored: number[] = [];

  // 1. סמוך למילת סיכום
  const keywords =
    /(?:סה["״']?\s*כ|סך\s*הכל|לתשלום|סכום\s*כולל|total|amount\s*due|grand\s*total)/gi;
  for (const match of text.matchAll(keywords)) {
    const window = text.slice(match.index, match.index + 60);
    const found = window.match(new RegExp(AMOUNT));
    if (found) anchored.push(parseAmount(found[1]!, found[2]));
  }

  // 2. צמוד לסימן מטבע
  for (const match of text.matchAll(new RegExp(String.raw`(?:₪|ש["״']?ח|ILS)\s*${AMOUNT}`, 'gi'))) {
    anchored.push(parseAmount(match[1]!, match[2]));
  }
  for (const match of text.matchAll(new RegExp(`${AMOUNT}\\s*(?:₪|ש["״']?ח|ILS)`, 'gi'))) {
    anchored.push(parseAmount(match[1]!, match[2]));
  }

  const valid = anchored.filter((value) => value >= 1 && value <= 5_000_000);
  if (valid.length > 0) return Math.max(...valid);

  // 3. מפלט אחרון: מספר יחיד עם שתי ספרות עשרוניות, שהוא כמעט תמיד סכום
  const decimals = [...text.matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?!\d)/g)]
    .map((match) => parseAmount(match[1]!, match[2]))
    .filter((value) => value >= 1 && value <= 5_000_000);
  return decimals.length > 0 ? Math.max(...decimals) : undefined;
}

function findDate(text: string): string | undefined {
  const match = text.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (!match) return undefined;
  const [, d, m, y] = match;
  const year = y!.length === 2 ? `20${y}` : y!;
  const month = m!.padStart(2, '0');
  const day = d!.padStart(2, '0');
  if (Number(month) > 12 || Number(day) > 31) return undefined;
  return `${year}-${month}-${day}`;
}

/**
 * מספר חשבונית - רק כשהוא מופיע אחרי מילה מפורשת.
 * הגבול \b מונע התאמה לתוך מילה, כמו "invoice.pdf" שהתפרש בעבר כמספר.
 */
function findInvoiceNumber(text: string): string | undefined {
  const match =
    text.match(/(?:חשבונית\s*מס|חשבונית|קבלה|אסמכתא|מספר)\s*[:#]?\s*(\d{3,12})\b/) ??
    text.match(/\b(?:invoice|receipt|inv\.?)\s*(?:no\.?|number|#|:)\s*(\d{3,12})\b/i);
  return match?.[1];
}

export class HeuristicInvoiceProvider implements InvoiceExtractionProvider {
  readonly key = 'heuristic';
  readonly displayName = 'חילוץ בסיסי מטקסט (ללא OCR)';
  readonly supportsScannedImages = false;

  async extract(file: UploadedFile): Promise<ExtractedInvoice> {
    const text = `${file.filename} ${readableText(file)}`;
    const amount = findAmount(text);
    const date = findDate(text);
    const invoiceNumber = findInvoiceNumber(text);
    const found = [amount, date, invoiceNumber].filter((value) => value !== undefined).length;

    return {
      provider: this.key,
      amountAgorot: amount === undefined ? null : shekelsToAgorot(amount),
      invoiceNumber: invoiceNumber ?? null,
      supplier: null, // זיהוי ספק מהימן מצריך OCR או מאגר ספקים
      date: date ?? null,
      confidence: found === 0 ? 'none' : found >= 3 ? 'medium' : 'low',
      note: file.mimeType.startsWith('image/')
        ? 'קובץ תמונה - נדרש OCR כדי לקרוא ממנו נתונים. יש למלא ידנית.'
        : found === 0
          ? 'לא נמצאו נתונים בטקסט הקובץ. יש למלא ידנית.'
          : 'הנתונים הם הצעה בלבד ויש לאמת אותם מול החשבונית.',
    };
  }
}
