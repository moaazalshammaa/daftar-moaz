-- المنتجات
CREATE TABLE products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_norm   TEXT NOT NULL,            -- الاسم بعد توحيد الحروف العربية (للبحث)
  barcode     TEXT UNIQUE,              -- NULL مسموح لأكثر من منتج
  price       REAL NOT NULL CHECK (price >= 0),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_products_name_norm ON products(name_norm);
CREATE INDEX idx_products_updated ON products(updated_at);

-- إعدادات عامة (العملة ...)
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- محاولات الدخول الفاشلة (حماية من التخمين)
CREATE TABLE login_failures (
  ip  TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX idx_login_failures ON login_failures(ip, at);
