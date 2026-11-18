const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const databaseJs = fs.readFileSync('database.js', 'utf8');
const serverJs = fs.readFileSync('server.js', 'utf8');
const appHtml = fs.readFileSync('public/app.html', 'utf8');
const appJs = fs.readFileSync('public/js/app.js', 'utf8');
const landingHtml = fs.readFileSync('public/index.html', 'utf8');

test('admin operations report recorded money flows and protect live reads with the admin wallet session', () => {
  assert.match(databaseJs, /amount_usdt REAL/);
  assert.match(serverJs, /INSERT INTO purchases \(tx_hash, chain_id, wallet_address, account_id, quantity, amount_usdt\)/);
  assert.match(serverJs, /COALESCE\(SUM\(amount_usdt\), 0\) AS sales_usdt/);
  assert.match(serverJs, /COALESCE\(user_amount, ROUND\(amount \* 0\.9, 2\)\)/);
  assert.match(serverJs, /app\.get\('\/api\/admin\/operations\/dashboard', requireWalletSession, requireAdminSession/);
  assert.match(serverJs, /app\.get\('\/api\/admin\/withdrawals', requireWalletSession, requireAdminSession/);
  assert.match(serverJs, /app\.get\('\/api\/admin\/tickets', requireWalletSession, requireAdminSession/);
  assert.match(serverJs, /app\.get\('\/api\/admin\/reviews', requireWalletSession, requireAdminSession/);
  assert.match(serverJs, /last_seen_at > \?/);
  assert.match(serverJs, /pending_withdrawal_usdt/);
  assert.match(serverJs, /paid_withdrawal_usdt/);
  assert.match(serverJs, /user_login_ip_events li/);
  assert.match(serverJs, /target_ips/);
  assert.match(appJs, /setInterval\(\(\) => \{[\s\S]*?loadAdminOperationsDashboard\(\);[\s\S]*?\}, 15000\)/);
  assert.match(appHtml, /id="admin-operations-feed"/);
  assert.match(appHtml, /id="admin-sales-total"/);
  assert.match(appHtml, /id="admin-paid-out-total"/);
});

test('purchase-linked referral provenance is persisted and historical ambiguity is not fabricated', () => {
  assert.match(databaseJs, /purchase_tx_hash TEXT/);
  assert.match(databaseJs, /purchase_chain_id INTEGER/);
  assert.match(serverJs, /purchase_tx_hash, purchase_chain_id\)[\s\S]*?normalizedTxHash,[\s\S]*?purchaseChainId/);
  assert.match(databaseJs, /AND \(SELECT COUNT\(\*\) FROM purchases p[\s\S]*?\) = 1/);
  assert.match(serverJs, /Historical commission has no unambiguous linked purchase transaction/);
  assert.match(serverJs, /getTransactionExplorerUrl\(referral\.purchase_chain_id, referral\.purchase_tx_hash\)/);
});

test('referral withdrawal evidence is allocated exactly for new requests and labels legacy context', () => {
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS referral_withdrawal_allocations/);
  assert.match(serverJs, /ORDER BY created_at, id/);
  assert.match(serverJs, /INSERT INTO referral_withdrawal_allocations \(withdrawal_id, referral_id, amount\)/);
  assert.match(serverJs, /referralsByWithdrawal\.has\(row\.id\)/);
  assert.match(appJs, /referral_transactions_exact/);
  assert.match(appJs, /cannot be attributed exactly to this payout/);
  assert.match(appJs, /Allocated to this withdrawal/);
});

test('support wallets are constrained server-side to the isolated ticket and review workspace', () => {
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS support_staff/);
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS support_staff_events/);
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS review_moderation_actions/);
  assert.match(serverJs, /function guardSupportStaffAccess\(wallet, req, res, next\)/);
  assert.match(serverJs, /SUPPORT_STAFF_ALLOWED_ROUTES\.has\(`\$\{req\.method\} \$\{req\.path\}`\)/);
  assert.match(serverJs, /app\.get\('\/api\/staff\/tickets', requireWalletSession, requireSupportStaff/);
  assert.match(serverJs, /app\.post\('\/api\/staff\/tickets\/action', sensitiveLimiter, requireWalletSession, requireSupportStaff/);
  assert.match(serverJs, /app\.get\('\/api\/staff\/reviews', requireWalletSession, requireSupportStaff/);
  assert.match(serverJs, /app\.post\('\/api\/staff\/reviews\/action', sensitiveLimiter, requireWalletSession, requireSupportStaff/);
  assert.match(serverJs, /author_wallet\)\s*VALUES\s*\(\?, 'ADMIN', 'Support Staff', \?, \?\)/);
  assert.match(serverJs, /INSERT INTO review_moderation_actions/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/support-staff\/action', sensitiveLimiter, requireTradeSignature, requireAdminWallet/);
  assert.match(appHtml, /id="supportStaffView"/);
  assert.match(appHtml, /id="support-staff-tickets-tab"/);
  assert.match(appHtml, /id="support-staff-reviews-tab"/);
  assert.match(appJs, /if \(currentWalletIsSupport && !currentWalletIsAdmin\) viewId = 'supportStaffView'/);
  assert.match(appJs, /body\.classList\.toggle\('support-staff-mode', enabled\)/);
  assert.match(appJs, /walletFetch\('\/api\/staff\/tickets'\)/);
  assert.match(appJs, /walletFetch\('\/api\/staff\/reviews'\)/);
});

test('public activity is privacy-safe and support UI rules hide admin and trading views', () => {
  const publicActivityRoute = serverJs.slice(
    serverJs.indexOf("app.get('/api/public/activity'"),
    serverJs.indexOf("app.get('/api/leaderboard'")
  );
  assert.match(publicActivityRoute, /purchases p/);
  assert.match(publicActivityRoute, /referral_withdrawals rw/);
  assert.match(publicActivityRoute, /Cache-Control/);
  assert.match(publicActivityRoute, /publicActivityLimiter/);
  assert.doesNotMatch(publicActivityRoute, /wallet_address|account_id|ip_address|tx_hash/);
  assert.match(landingHtml, /id="home-activity-list"/);
  assert.match(landingHtml, /fetch\("\/api\/public\/activity"\)/);
  assert.match(landingHtml, /title\.textContent=/);
  assert.match(appJs, /body\.support-staff-mode #nav-menu > :not\(#support-nav-item\)/);
});
