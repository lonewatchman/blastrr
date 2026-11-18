const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const databaseJs = fs.readFileSync('database.js', 'utf8');

test('existing review databases add moderation status before indexing it', () => {
  const migrationPosition = databaseJs.indexOf('db.all("PRAGMA table_info(user_reviews)"');
  const indexPosition = databaseJs.indexOf('CREATE INDEX IF NOT EXISTS idx_user_reviews_moderation_updated');

  assert.notEqual(migrationPosition, -1);
  assert.notEqual(indexPosition, -1);
  assert.ok(indexPosition > migrationPosition);
});

test('trade schema and migrations include all stop-loss mode fields', () => {
  const tradesTable = databaseJs.slice(
    databaseJs.indexOf('CREATE TABLE IF NOT EXISTS trades'),
    databaseJs.indexOf('CREATE TABLE IF NOT EXISTS trade_copy_groups')
  );
  assert.match(tradesTable, /sl_tp_mode TEXT NOT NULL DEFAULT 'price'/);
  assert.match(tradesTable, /sl_amount REAL/);
  assert.match(tradesTable, /tp_amount REAL/);
  assert.match(databaseJs, /\['sl_tp_mode', "TEXT NOT NULL DEFAULT 'price'"\]/);
  assert.match(databaseJs, /\['sl_amount', 'REAL'\]/);
  assert.match(databaseJs, /\['tp_amount', 'REAL'\]/);
});
