-- حسابات الموظفين (كل شخص يشوف حسابه فقط)
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,     -- أحرف إنجليزية صغيرة وأرقام
  display_name  TEXT NOT NULL,
  pass_hash     TEXT NOT NULL,            -- PBKDF2-SHA256
  salt          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- جلسات الموظفين: نخزّن بصمة التوكن فقط، مش التوكن نفسه
CREATE TABLE user_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

-- كل حركة مالية سطر واحد:
--   total = قيمة المشتريات (0 لو كانت دفعة فقط)
--   paid  = المبلغ المدفوع
--   الدين على الشخص = مجموع (total - paid)
--   الكاش المتوقع بالصندوق لليوم = مجموع paid للحركات اللي in_box = 1
CREATE TABLE entries (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  day         TEXT NOT NULL,              -- YYYY-MM-DD حسب توقيت المحل
  created_at  INTEGER NOT NULL,
  total       REAL NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid        REAL NOT NULL DEFAULT 0 CHECK (paid >= 0),
  in_box      INTEGER NOT NULL DEFAULT 1, -- المبلغ المدفوع انحط بالصندوق؟
  by_admin    INTEGER NOT NULL DEFAULT 0, -- سجّلها المدير
  note        TEXT,
  voided_at   INTEGER                     -- ملغاة (ما تنحسب)
);
CREATE INDEX idx_entries_user ON entries(user_id, created_at);
CREATE INDEX idx_entries_day ON entries(day);

-- تفاصيل المشتريات (نحفظ الاسم والسعر وقت الشراء)
CREATE TABLE entry_items (
  entry_id    TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  product_id  TEXT,
  name        TEXT NOT NULL,
  price       REAL NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX idx_entry_items_entry ON entry_items(entry_id);

-- جرد الصندوق اليومي (المبلغ الفعلي اللي عدّه المدير)
CREATE TABLE cash_counts (
  day         TEXT PRIMARY KEY,
  counted     REAL NOT NULL CHECK (counted >= 0),
  note        TEXT,
  updated_at  INTEGER NOT NULL
);
