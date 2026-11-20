const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const serverJs = fs.readFileSync('server.js', 'utf8');
const appHtml = fs.readFileSync('public/app.html', 'utf8');
const appJs = fs.readFileSync('public/js/app.js', 'utf8');

test('account finance endpoints are wallet-session scoped and use withdrawal rules', () => {
  const availabilityStart = serverJs.indexOf("app.get('/api/withdrawals/availability'");
  const availabilityEnd = serverJs.indexOf("app.get('/api/user/account-withdrawals'", availabilityStart);
  const availabilityRoute = serverJs.slice(availabilityStart, availabilityEnd);
  assert.match(availabilityRoute, /requireWalletSession/);
  assert.match(availabilityRoute, /getProtectedPayoutBalance/);
  assert.match(availabilityRoute, /getAvailableGrossWithdrawal/);
  assert.match(availabilityRoute, /pending_withdrawal_count/);
  assert.match(availabilityRoute, /can_withdraw: !unavailableReason/);

  const withdrawalStart = serverJs.indexOf("app.get('/api/user/account-withdrawals'");
  const withdrawalEnd = serverJs.indexOf("app.get('/api/user/account-purchases'", withdrawalStart);
  const withdrawalRoute = serverJs.slice(withdrawalStart, withdrawalEnd);
  assert.match(withdrawalRoute, /requireWalletSession/);
  assert.match(withdrawalRoute, /w\.account_id IS NOT NULL/);
  assert.match(withdrawalRoute, /payout_tx_hash/);
  assert.match(withdrawalRoute, /statement_owner: \{ name: owner\?\.username \|\| '', wallet_address: req\.walletAddress \}/);
});

test('account payment history contains verified purchases and excludes trading activity', () => {
  const purchaseStart = serverJs.indexOf("app.get('/api/user/account-purchases'");
  const purchaseEnd = serverJs.indexOf("app.get('/api/accounts/performance'", purchaseStart);
  const purchaseRoute = serverJs.slice(purchaseStart, purchaseEnd);
  assert.match(purchaseRoute, /requireWalletSession/);
  assert.match(purchaseRoute, /FROM purchases p/);
  assert.match(purchaseRoute, /p\.chain_id > 0/);
  assert.match(purchaseRoute, /p\.tx_hash/);
  assert.match(purchaseRoute, /statement_owner: \{ name: owner\?\.username \|\| '', wallet_address: req\.walletAddress \}/);
  assert.doesNotMatch(purchaseRoute, /FROM trades|JOIN trades/);
});

test('accounts page provides finance tabs and a signed withdrawal modal', () => {
  assert.match(appHtml, /data-accounts-section-tab="withdrawals"/);
  assert.match(appHtml, /data-accounts-section-tab="payments"/);
  assert.match(appHtml, /id="account-payout-network"/);
  assert.match(appHtml, /id="account-withdrawals-list"/);
  assert.match(appHtml, /id="account-purchases-list"/);
  assert.match(appHtml, /id="download-account-purchase-statement"/);
  assert.match(appHtml, /id="download-account-withdrawal-statement"/);
  assert.match(appHtml, /id="withdrawal-request-modal"/);
  assert.match(appJs, /async function loadAccountWithdrawalHistory\(\)[\s\S]*?\/api\/user\/account-withdrawals/);
  assert.match(appJs, /async function loadAccountPurchaseHistory\(\)[\s\S]*?\/api\/user\/account-purchases/);
  assert.match(appJs, /function downloadAccountPurchaseStatement\(\)[\s\S]*?\['Day', 'Date', 'Time \(UTC\)', 'Amount \(USDT\)'\]/);
  assert.match(appJs, /link\.download = filename/);
  assert.match(appJs, /function downloadAccountWithdrawalStatement\(\)/);
  assert.match(appJs, /'Amount \(USDT\)', 'Status'/);
  assert.match(appJs, /Name \/ username<\/dt>[\s\S]*Wallet<\/dt>[\s\S]*BLASTRR[\s\S]*https:\/\/blastrr\.com/);
  assert.match(appJs, /<dt>Period<\/dt><dd>All time<\/dd>/);
  assert.match(appJs, /fetch\('\/favicon\.png'\)/);
  assert.match(appJs, /Print \/ Save as PDF/);
  assert.match(appJs, /async function submitWithdrawalRequest\(event\)[\s\S]*?signedTradeAuthorization\(\)[\s\S]*?\/api\/withdrawals\/request/);
  assert.match(appJs, /max_withdrawable/);
  assert.match(appJs, /withdrawal-progress-track/);
  assert.match(appJs, /No trading accounts are available yet/);
});
