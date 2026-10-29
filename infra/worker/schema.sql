-- Shared gas price reports (src/prices.js, docs/17). Create the database and tables with:
--   npx wrangler d1 create exitatlas-prices
--   npx wrangler d1 execute exitatlas-prices --remote --file schema.sql
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, station TEXT NOT NULL, grade TEXT NOT NULL, price REAL NOT NULL, payment TEXT,
  member INTEGER NOT NULL DEFAULT 0, reported_at INTEGER NOT NULL, reporter TEXT NOT NULL, client TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS reports_station ON reports (station, reported_at);
CREATE INDEX IF NOT EXISTS reports_time ON reports (reported_at);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS counters_day ON counters (day);
