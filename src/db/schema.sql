-- ---------------------------------------------------------------------------
-- מערכת ניהול בית כנסת - סכמת בסיס הנתונים
--
-- עקרונות:
--  1. כל סכום כספי נשמר כ-INTEGER באגורות. אין שימוש ב-REAL עבור כסף.
--  2. Commitment / Payment / Income / Receipt הן ארבע טבלאות נפרדות (סעיף 27).
--  3. לכל רשומה כספית יש organization_id - אין ערבוב בין העמותות (סעיף 25).
-- ---------------------------------------------------------------------------

-- עמותות / ישויות משפטיות (סעיף 25)
CREATE TABLE IF NOT EXISTS organizations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL UNIQUE,
  short_name             TEXT,
  legal_number           TEXT,             -- מספר עמותה / ח.פ.
  address                TEXT,
  phone                  TEXT,
  email                  TEXT,

  -- פרטי חשבון בנק
  bank_name              TEXT,
  bank_branch            TEXT,
  bank_account           TEXT,
  account_holder         TEXT,

  -- Integration נפרד לכל עמותה (סעיף 25 + 26)
  payment_provider       TEXT    NOT NULL DEFAULT 'mock',
  payment_config         TEXT    NOT NULL DEFAULT '{}',   -- JSON
  receipt_provider       TEXT    NOT NULL DEFAULT 'mock',
  receipt_config         TEXT    NOT NULL DEFAULT '{}',   -- JSON
  notification_provider  TEXT    NOT NULL DEFAULT 'mock',
  notification_config    TEXT    NOT NULL DEFAULT '{}',   -- JSON

  -- סוגי מסמכים שהעמותה רשאית להפיק, JSON array של DocumentType
  allowed_document_types TEXT    NOT NULL DEFAULT '["receipt"]',
  default_document_type  TEXT    NOT NULL DEFAULT 'receipt',

  -- סעיף 29: אוטומטי / רק לאחר אישור ידני. ניתן להגדרה שונה לכל עמותה.
  receipt_issue_mode     TEXT    NOT NULL DEFAULT 'automatic'
                                 CHECK (receipt_issue_mode IN ('automatic','manual_approval')),

  active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- חברי קהילה
CREATE TABLE IF NOT EXISTS members (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name     TEXT    NOT NULL,
  last_name      TEXT    NOT NULL,
  hebrew_name    TEXT,                     -- שם לעליות, למשל "יעקב בן יצחק"
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  preferred_channel TEXT CHECK (preferred_channel IN ('whatsapp','sms','email')),
  notes          TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- אירועים / שבתות / חגים
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  kind            TEXT    NOT NULL DEFAULT 'event'
                          CHECK (kind IN ('shabbat','holiday','event','other')),
  hebrew_date     TEXT,                    -- למשל "כ"ג באלול תשפ"ו"
  gregorian_date  TEXT,                    -- YYYY-MM-DD
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- סוגי התחייבות (עליות, תרומות, אירועים, חברות וכו')
CREATE TABLE IF NOT EXISTS commitment_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  -- סוג המסמך המועדף שיופק עבור תשלומים מסוג זה
  document_type TEXT  NOT NULL DEFAULT 'receipt',
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 1. התחייבויות (Commitment / Pledge) - סעיף 23
--    התחייבות אינה הכנסה. היא מייצגת חוב שנוצר.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commitments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id             INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  commitment_type_id    INTEGER NOT NULL REFERENCES commitment_types(id) ON DELETE RESTRICT,
  event_id              INTEGER REFERENCES events(id) ON DELETE SET NULL,

  commitment_date       TEXT    NOT NULL,          -- תאריך ההתחייבות YYYY-MM-DD
  due_date              TEXT,                      -- מועד אחרון לתשלום (אופציונלי)

  amount_agorot         INTEGER NOT NULL CHECK (amount_agorot > 0),
  -- סכום ששולם בפועל. מתוחזק על ידי השירות מתוך סכום התשלומים שהושלמו.
  paid_agorot           INTEGER NOT NULL DEFAULT 0 CHECK (paid_agorot >= 0),
  -- יתרה לתשלום. עמודה מחושבת כדי שלא תוכל לצאת מסנכרון.
  balance_agorot        INTEGER GENERATED ALWAYS AS (amount_agorot - paid_agorot) VIRTUAL,

  status                TEXT    NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open','partially_paid','paid','cancelled')),
  planned_payment_method TEXT   CHECK (planned_payment_method IN
                                ('cash','check','bank_transfer','credit_card',
                                 'standing_order','bit','paybox','other')),

  -- פריסת תשלומים. רלוונטי בעיקר להתחייבות מקום/ריהוט: כמה תשלומים
  -- סוכמו, ומתי נגבה (או ייגבה) התשלום הראשון. שני השדות אינם חובה -
  -- מי ששילם הכל מראש פשוט לא ממלא אותם.
  instalments_count     INTEGER CHECK (instalments_count IS NULL OR instalments_count > 0),
  first_payment_date    TEXT,

  notes                 TEXT,
  cancelled_at          TEXT,
  cancel_reason         TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),

  CHECK (paid_agorot <= amount_agorot)
);

CREATE INDEX IF NOT EXISTS idx_commitments_member  ON commitments(member_id);
CREATE INDEX IF NOT EXISTS idx_commitments_org     ON commitments(organization_id);
CREATE INDEX IF NOT EXISTS idx_commitments_status  ON commitments(status);
CREATE INDEX IF NOT EXISTS idx_commitments_event   ON commitments(event_id);
CREATE INDEX IF NOT EXISTS idx_commitments_type    ON commitments(commitment_type_id);
CREATE INDEX IF NOT EXISTS idx_commitments_date    ON commitments(commitment_date);
CREATE INDEX IF NOT EXISTS idx_commitments_due     ON commitments(due_date);

-- ---------------------------------------------------------------------------
-- 2. תשלומים (Payment) - כסף שהתקבל בפועל
--    תשלום יכול להיות משויך להתחייבות, או להיות תשלום עצמאי (למשל תרומה ישירה).
--    member_id יכול להיות NULL - "תשלום שלא שויך לחבר" (סעיף 30).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  member_id         INTEGER REFERENCES members(id) ON DELETE SET NULL,
  commitment_id     INTEGER REFERENCES commitments(id) ON DELETE SET NULL,
  standing_order_id INTEGER REFERENCES standing_orders(id) ON DELETE SET NULL,

  amount_agorot     INTEGER NOT NULL CHECK (amount_agorot > 0),
  payment_date      TEXT    NOT NULL,
  method            TEXT    NOT NULL CHECK (method IN
                            ('cash','check','bank_transfer','credit_card',
                             'standing_order','bit','paybox','other')),
  status            TEXT    NOT NULL DEFAULT 'completed'
                            CHECK (status IN ('pending','completed','failed','refunded')),

  -- מניעת רישום כפול של אותו תשלום (סעיף 28)
  idempotency_key   TEXT    NOT NULL UNIQUE,

  provider          TEXT,                   -- ספק הסליקה, אם התשלום נסלק
  provider_reference TEXT,                  -- מזהה העסקה אצל הספק
  provider_payload  TEXT,                   -- JSON גולמי מהספק, לצורכי ביקורת
  failure_reason    TEXT,
  notes             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payments_member     ON payments(member_id);
CREATE INDEX IF NOT EXISTS idx_payments_org        ON payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_payments_commitment ON payments(commitment_id);
CREATE INDEX IF NOT EXISTS idx_payments_date       ON payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_status     ON payments(status);
-- לאיתור מהיר של תשלומים שלא שויכו לחבר
CREATE INDEX IF NOT EXISTS idx_payments_unassigned ON payments(member_id) WHERE member_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. הכנסות (Income) - נרשמות רק כאשר התקבל תשלום בפועל (סעיף 23)
--    יחס 1:1 עם תשלום שהושלם.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incomes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id      INTEGER NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  member_id       INTEGER REFERENCES members(id) ON DELETE SET NULL,
  commitment_id   INTEGER REFERENCES commitments(id) ON DELETE SET NULL,
  event_id        INTEGER REFERENCES events(id) ON DELETE SET NULL,
  commitment_type_id INTEGER REFERENCES commitment_types(id) ON DELETE SET NULL,

  amount_agorot   INTEGER NOT NULL CHECK (amount_agorot > 0),
  income_date     TEXT    NOT NULL,
  description     TEXT,

  -- הכנסה אינה נמחקת לעולם. זיכוי תשלום מסמן אותה כ-reversed,
  -- וכל הדוחות סופרים רק הכנסות בסטטוס recorded.
  status          TEXT    NOT NULL DEFAULT 'recorded'
                          CHECK (status IN ('recorded','reversed')),
  reversed_at     TEXT,
  reversal_reason TEXT,

  -- שדות הקבלה על ההכנסה (סעיף 24). משקפים את הקבלה הפעילה של ההכנסה.
  receipt_required   INTEGER NOT NULL DEFAULT 1 CHECK (receipt_required IN (0,1)),
  receipt_issued     INTEGER NOT NULL DEFAULT 0 CHECK (receipt_issued IN (0,1)),
  receipt_id         INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
  receipt_number     TEXT,
  receipt_issued_at  TEXT,
  receipt_provider   TEXT,
  receipt_url        TEXT,
  receipt_status     TEXT NOT NULL DEFAULT 'pending'
                     CHECK (receipt_status IN
                       ('not_required','pending','awaiting_approval','issued','failed','cancelled')),
  receipt_error      TEXT,

  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_incomes_member ON incomes(member_id);
CREATE INDEX IF NOT EXISTS idx_incomes_org    ON incomes(organization_id);
CREATE INDEX IF NOT EXISTS idx_incomes_date   ON incomes(income_date);
CREATE INDEX IF NOT EXISTS idx_incomes_receipt_status ON incomes(receipt_status);
CREATE INDEX IF NOT EXISTS idx_incomes_commitment ON incomes(commitment_id);
CREATE INDEX IF NOT EXISTS idx_incomes_status ON incomes(status);

-- ---------------------------------------------------------------------------
-- 4. קבלות (Receipt) - סעיף 24
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_id          INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  income_id           INTEGER NOT NULL REFERENCES incomes(id) ON DELETE RESTRICT,
  member_id           INTEGER REFERENCES members(id) ON DELETE SET NULL,

  -- Idempotency: מפתח ייחודי שנשלח לספק כדי שניסיון חוזר לא ייצור קבלה שנייה (סעיף 28)
  idempotency_key     TEXT    NOT NULL UNIQUE,

  document_type       TEXT    NOT NULL DEFAULT 'receipt',
  amount_agorot       INTEGER NOT NULL CHECK (amount_agorot > 0),

  status              TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN
                                ('pending','awaiting_approval','issued','failed','cancelled')),
  provider            TEXT    NOT NULL,
  provider_receipt_id TEXT,                 -- המזהה הפנימי אצל ספק הקבלות
  receipt_number      TEXT,                 -- מספר הקבלה כפי שהופק
  issued_at           TEXT,
  url                 TEXT,
  pdf_path            TEXT,                 -- קובץ PDF שהורד ונשמר מקומית

  attempts            INTEGER NOT NULL DEFAULT 0,
  last_attempt_at     TEXT,
  error_message       TEXT,
  cancelled_at        TEXT,
  cancel_reason       TEXT,

  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- מונע יצירת שתי קבלות פעילות לאותו תשלום (סעיף 28).
-- קבלה שבוטלה אינה חוסמת הפקת קבלה חדשה במקומה.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_receipt_active_per_payment
  ON receipts(payment_id) WHERE status != 'cancelled';

CREATE INDEX IF NOT EXISTS idx_receipts_member ON receipts(member_id);
CREATE INDEX IF NOT EXISTS idx_receipts_org    ON receipts(organization_id);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
CREATE INDEX IF NOT EXISTS idx_receipts_number ON receipts(receipt_number);
CREATE INDEX IF NOT EXISTS idx_receipts_issued ON receipts(issued_at);

-- ---------------------------------------------------------------------------
-- הוראות קבע (סעיף 25 - משויכות לעמותה)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS standing_orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id         INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  commitment_type_id INTEGER REFERENCES commitment_types(id) ON DELETE SET NULL,
  -- הוראת קבע שמשלמת התחייבות בתשלומים (למשל מקום/ריהוט). כל חיוב מקטין
  -- את יתרת ההתחייבות, וההוראה מסתיימת כאשר ההתחייבות שולמה במלואה.
  -- הוראת קבע שוטפת, כמו דמי חבר, אינה מקושרת להתחייבות והשדה נשאר ריק.
  commitment_id     INTEGER REFERENCES commitments(id) ON DELETE SET NULL,

  amount_agorot     INTEGER NOT NULL CHECK (amount_agorot > 0),
  day_of_month      INTEGER NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
  method            TEXT    NOT NULL DEFAULT 'credit_card',
  status            TEXT    NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','paused','cancelled','card_expired','failed','completed')),
  start_date        TEXT    NOT NULL,
  end_date          TEXT,

  provider          TEXT,
  provider_subscription_id TEXT,
  card_last4        TEXT,
  card_expiry       TEXT,                   -- MM/YY
  last_charge_at    TEXT,
  last_failure_reason TEXT,
  notes             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_standing_orders_member ON standing_orders(member_id);
CREATE INDEX IF NOT EXISTS idx_standing_orders_org    ON standing_orders(organization_id);
CREATE INDEX IF NOT EXISTS idx_standing_orders_status ON standing_orders(status);

-- ---------------------------------------------------------------------------
-- הוצאות (סעיף 25 - משויכות לעמותה, כדי שדוח מאוחד יוכל להציג תמונה מלאה)
-- ---------------------------------------------------------------------------

-- קטגוריות הוצאה, מקובצות לפי אופי: משכורות, הוצאות שוטפות,
-- חגים ואירועים, ואחר. הקיבוץ מאפשר לראות לאן הכסף יוצא ברמת-על.
CREATE TABLE IF NOT EXISTS expense_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'ongoing'
                     CHECK (kind IN ('salary','ongoing','events','maintenance','other')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- תקציב מתוכנן לקטגוריה: אומדן ההוצאה ותדירותה. משמש למסך התקציב,
  -- שמשווה את האומדן להוצאה בפועל. אינו חובה - קטגוריה ללא אומדן
  -- פשוט לא מופיעה בתחזית.
  planned_amount_agorot INTEGER CHECK (planned_amount_agorot IS NULL OR planned_amount_agorot >= 0),
  planned_period        TEXT    CHECK (planned_period IS NULL OR
                                       planned_period IN ('monthly','yearly','occasional')),
  planned_note          TEXT
);

CREATE TABLE IF NOT EXISTS expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  category_id     INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
  category        TEXT    NOT NULL,          -- שם הקטגוריה, נשמר גם כטקסט לצורכי היסטוריה
  -- שיוך לאירוע, כדי לראות כמה עלה חג או אירוע מסוים
  event_id        INTEGER REFERENCES events(id) ON DELETE SET NULL,
  supplier        TEXT,
  amount_agorot   INTEGER NOT NULL CHECK (amount_agorot > 0),
  expense_date    TEXT    NOT NULL,
  method          TEXT,
  invoice_number  TEXT,
  description     TEXT,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expenses_org      ON expenses(organization_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date     ON expenses(expense_date);
-- אינדקסים על עמודות שנוספו לאחר מכן נוצרים ב-migrate(), אחרי הוספת העמודות.

-- חשבוניות וקבצים מצורפים להוצאה
CREATE TABLE IF NOT EXISTS expense_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id    INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  filename      TEXT    NOT NULL,            -- שם הקובץ המקורי כפי שהועלה
  stored_path   TEXT    NOT NULL,
  mime_type     TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  uploaded_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expense_attachments ON expense_attachments(expense_id);

-- ---------------------------------------------------------------------------
-- תזכורות לחברים (תשתית ל-WhatsApp / SMS / Email, סעיף 23)
-- בשלב זה ההודעות נרשמות בתור ואינן נשלחות בפועל ללא Integration אמיתי.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  channel         TEXT    NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  template_key    TEXT    NOT NULL,
  recipient       TEXT,                     -- טלפון או אימייל בפועל
  subject         TEXT,
  body            TEXT    NOT NULL,

  related_type    TEXT,                     -- 'commitment' | 'receipt' | ...
  related_id      INTEGER,

  status          TEXT    NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','sent','failed','skipped','cancelled')),
  provider        TEXT,
  provider_message_id TEXT,
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  scheduled_at    TEXT,
  sent_at         TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications(member_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);

-- ---------------------------------------------------------------------------
-- התראות למנהל (סעיף 28)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  severity        TEXT    NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','error')),
  kind            TEXT    NOT NULL,          -- 'receipt_failed' | 'payment_failed' | ...
  title           TEXT    NOT NULL,
  message         TEXT,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  related_type    TEXT,
  related_id      INTEGER,
  resolved        INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  resolved_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON admin_alerts(resolved);
CREATE INDEX IF NOT EXISTS idx_alerts_kind     ON admin_alerts(kind);

-- ---------------------------------------------------------------------------
-- אירועי Webhook מספקי סליקה (סעיף 26) - נשמרים לצורכי ביקורת ו-idempotency
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT    NOT NULL,
  provider_event_id TEXT  NOT NULL,
  event_type      TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  processed       INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0,1)),
  processing_error TEXT,
  received_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  processed_at    TEXT,
  UNIQUE (provider, provider_event_id)
);

-- ---------------------------------------------------------------------------
-- הגדרות מערכת גלובליות
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
