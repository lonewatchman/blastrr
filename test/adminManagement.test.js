const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const databaseJs = fs.readFileSync('database.js', 'utf8');
const serverJs = fs.readFileSync('server.js', 'utf8');
const appHtml = fs.readFileSync('public/app.html', 'utf8');
const appJs = fs.readFileSync('public/js/app.js', 'utf8');

test('admin plan management validates all plan fields and protects database edits from startup seeding', () => {
  assert.match(serverJs, /app\.post\('\/api\/admin\/plans\/list', sensitiveLimiter, requireTradeSignature, requireAdminWallet/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/plans\/save', sensitiveLimiter, requireTradeSignature, requireAdminWallet/);
  assert.match(serverJs, /max_single_day_profit_pct: Number\(body\.max_single_day_profit_pct\)/);
  assert.match(serverJs, /fields\.max_drawdown_pct < 0 \|\| fields\.max_drawdown_pct > 100/);
  assert.match(serverJs, /fields\.daily_loss_pct < 0 \|\| fields\.daily_loss_pct > 100/);
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS plan_seed_state/);
  assert.match(serverJs, /SELECT seeded FROM plan_seed_state/);
  assert.match(serverJs, /UPDATE plan_seed_state SET seeded = 1/);
  const seedPlans = serverJs.slice(serverJs.indexOf('function seedPlans()'), serverJs.indexOf('setTimeout(seedPlans'));
  assert.match(seedPlans, /SELECT id FROM plans/);
  assert.match(seedPlans, /INSERT INTO plans/);
  assert.doesNotMatch(seedPlans, /UPDATE plans SET/);
  assert.doesNotMatch(seedPlans, /UPDATE plans SET active = 0/);
  assert.match(appHtml, /id="admin-plan-create-form"/);
  assert.match(appHtml, /name="max_drawdown_pct"/);
  assert.match(appHtml, /name="daily_loss_pct"/);
  assert.match(appHtml, /name="max_single_day_profit_pct"/);
  assert.match(appJs, /\/api\/admin\/plans\/save/);
  assert.match(appJs, /\/api\/admin\/plans\/list/);
  assert.match(appJs, /loadAdminPromoPlans\(\)/);
});

test('admin user search loads accounts on demand and separates live from archived statuses', () => {
  assert.match(serverJs, /app\.post\('\/api\/admin\/users\/search', sensitiveLimiter, requireTradeSignature, requireAdminWallet/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/users\/accounts', sensitiveLimiter, requireTradeSignature, requireAdminWallet/);
  assert.match(serverJs, /instr\(LOWER\(COALESCE\(u\.username, ''\)\), LOWER\(\?\)\)/);
  assert.match(serverJs, /LIMIT 25/);
  assert.match(appHtml, /id="admin-user-search-form"/);
  assert.match(appHtml, /id="admin-user-search-results"/);
  assert.match(appJs, /\/api\/admin\/users\/search/);
  assert.match(appJs, /\/api\/admin\/users\/accounts/);
  assert.match(appJs, /account\.status === 'ACTIVE'/);
  assert.match(appJs, /renderGroup\('Archived accounts', archived\)/);
  assert.doesNotMatch(appJs, /\/api\/admin\/accounts'/);
  assert.match(databaseJs, /status TEXT DEFAULT 'ACTIVE'/);
});

test('admin can suspend users and review retained login IP warnings without blocking read access or trade closes', () => {
  assert.match(databaseJs, /admin_suspended INTEGER NOT NULL DEFAULT 0/);
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS user_login_ip_events/);
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS user_admin_actions/);
  assert.match(serverJs, /function recordWalletLogin\(wallet, ipAddress, callback\)/);
  assert.match(serverJs, /DELETE FROM user_login_ip_events/);
  assert.match(serverJs, /const LOGIN_IP_RETENTION_DAYS = 180/);
  assert.match(serverJs, /is_new_ip/);
  assert.match(serverJs, /recordWalletLogin\(wallet, ipAddress/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/users\/action', sensitiveLimiter, requireTradeSignature, requireAdminWallet/);
  assert.match(serverJs, /const \{ user_wallet: wallet, action \} = req\.body/);
  assert.match(serverJs, /const wallet = req\.body\?\.user_wallet/);
  assert.match(appJs, /user_wallet: wallet, action, reason/);
  assert.match(appJs, /user_wallet: wallet \}\)/);
  assert.match(serverJs, /app\.post\('\/api\/accounts\/purchase', sensitiveLimiter, requireWalletSession, requireUserNotSuspended/);
  assert.match(serverJs, /app\.post\('\/api\/trades\/execute', sensitiveLimiter, requireWalletSession, walletActionLimiter, requireWalletNotSoftLocked, requireUserNotSuspended/);
  assert.match(serverJs, /app\.post\('\/api\/withdrawals\/request', sensitiveLimiter, requireTradeSignature, requireUserNotSuspended/);
  assert.match(serverJs, /app\.post\('\/api\/trades\/close', sensitiveLimiter, requireWalletSession, \(req, res\)/);
  assert.match(serverJs, /created_at >= datetime\('now', '-180 days'\)/);
  assert.match(serverJs, /AS new_ip_count/);
  assert.match(appJs, /New IP detected:/);
  assert.match(appJs, /adminUserAction\(userButton\.dataset\.adminUserWallet/);
  assert.match(appHtml, /retained for 180 days/);
});
