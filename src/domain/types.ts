/**
 * טיפוסי הליבה של המערכת.
 *
 * הפרדה עקרונית (סעיף 27 באפיון): Commitment / Payment / Income / Receipt
 * הם ארבע ישויות נפרדות עם משמעות שונה, ואינם מאוחדים לטבלה אחת.
 */

// ---------------------------------------------------------------------------
// התחייבויות
// ---------------------------------------------------------------------------

export const COMMITMENT_STATUSES = ['open', 'partially_paid', 'paid', 'cancelled'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const COMMITMENT_STATUS_LABELS: Record<CommitmentStatus, string> = {
  open: 'פתוח',
  partially_paid: 'שולם חלקית',
  paid: 'שולם במלואו',
  cancelled: 'בוטל',
};

// ---------------------------------------------------------------------------
// אמצעי תשלום
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = [
  'cash',
  'check',
  'bank_transfer',
  'credit_card',
  'standing_order',
  'bit',
  'paybox',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'מזומן',
  check: "צ'ק",
  bank_transfer: 'העברה בנקאית',
  credit_card: 'כרטיס אשראי',
  standing_order: 'הוראת קבע',
  bit: 'ביט',
  paybox: 'פייבוקס',
  other: 'אחר',
};

// ---------------------------------------------------------------------------
// תשלומים בפועל
// ---------------------------------------------------------------------------

export const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'ממתין',
  completed: 'הושלם',
  failed: 'נכשל',
  refunded: 'זוכה',
};

// ---------------------------------------------------------------------------
// קבלות
// ---------------------------------------------------------------------------

/**
 * סטטוס הפקת קבלה.
 * pending  - ממתין להפקה (כולל המקרה שבו ה-API של ספק הקבלות אינו זמין, סעיף 28)
 * awaiting_approval - ממתין לאישור ידני של גזבר/מנהל (סעיף 29)
 * issued   - הופקה בהצלחה
 * failed   - הפקה נכשלה, ניתן לנסות שוב
 * cancelled- הקבלה בוטלה מול הספק
 */
export const RECEIPT_STATUSES = [
  'pending',
  'awaiting_approval',
  'issued',
  'failed',
  'cancelled',
] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const RECEIPT_STATUS_LABELS: Record<ReceiptStatus, string> = {
  pending: 'ממתין להפקה',
  awaiting_approval: 'ממתין לאישור',
  issued: 'הופקה',
  failed: 'הפקה נכשלה',
  cancelled: 'בוטלה',
};

/** סטטוס הקבלה כפי שהוא נשמר על ההכנסה (כולל המקרה שאין צורך בקבלה). */
export const INCOME_RECEIPT_STATUSES = ['not_required', ...RECEIPT_STATUSES] as const;
export type IncomeReceiptStatus = (typeof INCOME_RECEIPT_STATUSES)[number];

export const INCOME_RECEIPT_STATUS_LABELS: Record<IncomeReceiptStatus, string> = {
  not_required: 'לא נדרשת קבלה',
  ...RECEIPT_STATUS_LABELS,
};

/** סוגי מסמכים שעמותה יכולה להיות רשאית להפיק. */
export const DOCUMENT_TYPES = [
  'receipt',
  'donation_receipt',
  'tax_deductible_receipt',
  'invoice',
  'invoice_receipt',
  'credit_note',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  receipt: 'קבלה',
  donation_receipt: 'קבלה על תרומה',
  tax_deductible_receipt: 'קבלה לזיכוי מס (46א)',
  invoice: 'חשבונית',
  invoice_receipt: 'חשבונית מס קבלה',
  credit_note: 'חשבונית זיכוי',
};

/** מתי מופקת קבלה - אוטומטית עם קבלת התשלום או רק לאחר אישור ידני (סעיף 29). */
export const RECEIPT_ISSUE_MODES = ['automatic', 'manual_approval'] as const;
export type ReceiptIssueMode = (typeof RECEIPT_ISSUE_MODES)[number];

export const RECEIPT_ISSUE_MODE_LABELS: Record<ReceiptIssueMode, string> = {
  automatic: 'אוטומטי עם קבלת תשלום',
  manual_approval: 'רק לאחר אישור גזבר/מנהל',
};

// ---------------------------------------------------------------------------
// אירועים
// ---------------------------------------------------------------------------

export const EVENT_KINDS = ['shabbat', 'holiday', 'event', 'other'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  shabbat: 'שבת',
  holiday: 'חג',
  event: 'אירוע',
  other: 'אחר',
};

// ---------------------------------------------------------------------------
// תזכורות / התראות
// ---------------------------------------------------------------------------

export const NOTIFICATION_CHANNELS = ['whatsapp', 'sms', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  whatsapp: 'וואטסאפ',
  sms: 'SMS',
  email: 'אימייל',
};

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed', 'skipped', 'cancelled'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_STATUS_LABELS: Record<NotificationStatus, string> = {
  queued: 'בתור לשליחה',
  sent: 'נשלחה',
  failed: 'נכשלה',
  skipped: 'דולגה',
  cancelled: 'בוטלה',
};

export const ALERT_SEVERITIES = ['info', 'warning', 'error'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

// ---------------------------------------------------------------------------
// הוראות קבע
// ---------------------------------------------------------------------------

export const STANDING_ORDER_STATUSES = [
  'active',
  'paused',
  'cancelled',
  'card_expired',
  'failed',
] as const;
export type StandingOrderStatus = (typeof STANDING_ORDER_STATUSES)[number];

export const STANDING_ORDER_STATUS_LABELS: Record<StandingOrderStatus, string> = {
  active: 'פעילה',
  paused: 'מושהית',
  cancelled: 'בוטלה',
  card_expired: 'כרטיס פג תוקף',
  failed: 'חיוב נכשל',
};

// ---------------------------------------------------------------------------
// עזרי טיפוסים
// ---------------------------------------------------------------------------

export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // YYYY-MM-DDTHH:mm:ss.sssZ

export function isOneOf<T extends readonly string[]>(
  allowed: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
