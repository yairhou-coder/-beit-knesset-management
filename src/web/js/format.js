/** פורמט תצוגה. כל הסכומים מגיעים מהשרת באגורות. */

const currency = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 2,
});

export function money(agorot) {
  if (agorot === undefined || agorot === null) return '—';
  const shekels = agorot / 100;
  return currency.format(shekels).replace(/‏/g, '');
}

/** סכום ללא סימן מטבע, לשדות טופס. */
export function shekels(agorot) {
  if (agorot === undefined || agorot === null) return '';
  return String(agorot / 100);
}

export function date(value) {
  if (!value) return '—';
  const iso = String(value).slice(0, 10);
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) return String(value);
  return `${day}/${month}/${year}`;
}

export function dateTime(value) {
  if (!value) return '—';
  const parsed = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
}

export function number(value) {
  return value === undefined || value === null ? '—' : new Intl.NumberFormat('he-IL').format(value);
}

export function days(count) {
  if (!count) return '—';
  return count === 1 ? 'יום אחד' : `${number(count)} ימים`;
}

/** בריחה מ-HTML, לכל טקסט שמקורו בנתוני משתמש. */
export function esc(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COMMITMENT_TONES = {
  open: 'warning',
  partially_paid: 'warning',
  paid: 'positive',
  cancelled: 'neutral',
};

const RECEIPT_TONES = {
  issued: 'positive',
  pending: 'warning',
  awaiting_approval: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
  not_required: 'neutral',
};

const PAYMENT_TONES = {
  completed: 'positive',
  pending: 'warning',
  failed: 'danger',
  refunded: 'neutral',
};

const STANDING_ORDER_TONES = {
  active: 'positive',
  paused: 'warning',
  cancelled: 'neutral',
  card_expired: 'danger',
  failed: 'danger',
};

const NOTIFICATION_TONES = {
  sent: 'positive',
  queued: 'warning',
  failed: 'danger',
  skipped: 'neutral',
  cancelled: 'neutral',
};

export function toneFor(kind, status) {
  const maps = {
    commitment: COMMITMENT_TONES,
    receipt: RECEIPT_TONES,
    payment: PAYMENT_TONES,
    standingOrder: STANDING_ORDER_TONES,
    notification: NOTIFICATION_TONES,
  };
  return maps[kind]?.[status] ?? 'neutral';
}

export function badge(label, tone = 'neutral') {
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}
