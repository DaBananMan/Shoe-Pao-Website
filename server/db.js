const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'orders.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// Create tables if missing
const schema = `
CREATE TABLE IF NOT EXISTS Orders (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  status TEXT,
  total REAL,
  shipping_fee REAL,
  discount REAL,
  payment_method TEXT,
  created_at TEXT,
  delivery_address TEXT,
  recipient_name TEXT,
  recipient_phone TEXT,
  courier_name TEXT,
  tracking_number TEXT
);
CREATE TABLE IF NOT EXISTS OrderItems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  product_id TEXT,
  name TEXT,
  price REAL,
  qty INTEGER,
  image_url TEXT
);
CREATE TABLE IF NOT EXISTS OrderTracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  status TEXT,
  message TEXT,
  timestamp TEXT,
  location TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON Orders(user_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON OrderItems(order_id);
CREATE INDEX IF NOT EXISTS idx_tracking_order ON OrderTracking(order_id);
CREATE TABLE IF NOT EXISTS ShortLinks (
  id TEXT PRIMARY KEY,
  target TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS PasswordResetTokens (
  token TEXT PRIMARY KEY,
  email TEXT,
  used INTEGER DEFAULT 0,
  created_at TEXT,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS PasswordResetEvents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  created_at TEXT
);
`;

db.exec(schema);

// Ensure legacy DB has the location column (idempotent)
try{
  db.prepare("ALTER TABLE OrderTracking ADD COLUMN location TEXT").run();
}catch(e){ /* ignore if column exists */ }

module.exports = db;
