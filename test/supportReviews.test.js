const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const databaseJs = fs.readFileSync('database.js', 'utf8');
const serverJs = fs.readFileSync('server.js', 'utf8');
const appHtml = fs.readFileSync('public/app.html', 'utf8');
const appJs = fs.readFileSync('public/js/app.js', 'utf8');
const appCss = fs.readFileSync('public/css/app.css', 'utf8');
const landingHtml = fs.readFileSync('public/index.html', 'utf8');

test('support ticket and review schema is text-only and constrained', () => {
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS support_tickets/);
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS support_ticket_messages/);
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS support_ticket_admin_reads/);
  assert.match(databaseJs, /assigned_staff_wallet TEXT/);
  assert.match(databaseJs, /CHECK\(author_role IN \('USER', 'ADMIN'\)\)/);
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS user_reviews/);
  assert.match(databaseJs, /account_id TEXT PRIMARY KEY,[\s\S]*?FOREIGN KEY\(account_id\) REFERENCES accounts\(id\)/);
  assert.match(databaseJs, /ALTER TABLE user_reviews RENAME TO user_reviews_legacy/);
  assert.match(databaseJs, /JOIN purchases p ON p\.account_id = a\.id/);
  assert.match(databaseJs, /FROM user_reviews_legacy old[\s\S]*?JOIN purchases p ON p\.account_id = a\.id/);
  assert.match(databaseJs, /rating INTEGER NOT NULL CHECK\(rating BETWEEN 1 AND 5\)/);
  assert.match(databaseJs, /published INTEGER NOT NULL DEFAULT 0/);
  assert.match(appHtml, /id="ticket-message"[^>]*maxlength="5000"/);
  assert.doesNotMatch(appHtml, /<input\b[^>]*type=["']file["']/i);
});

test('ticket endpoints enforce wallet ownership, account ownership, and admin authorization', () => {
  assert.match(serverJs, /app\.get\('\/api\/user\/tickets', requireWalletSession/);
  assert.match(serverJs, /LOWER\(t\.wallet_address\) = LOWER\(\?\)/);
  assert.match(serverJs, /accounts WHERE id = \? AND LOWER\(wallet_address\) = LOWER\(\?\)/);
  assert.match(serverJs, /app\.post\('\/api\/user\/tickets\/:ticketId\/reply', sensitiveLimiter, requireWalletSession/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/tickets', sensitiveLimiter, requireTradeSignature, requireAdminWallet/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/tickets\/action', sensitiveLimiter, requireTradeSignature, requireAdminWallet/);
  assert.match(serverJs, /INSERT INTO support_ticket_messages[\s\S]*?'ADMIN', 'Blastrr Support'/);
  assert.match(serverJs, /app\.get\('\/api\/user\/tickets'[\s\S]*?attachTicketMessages\(tickets \|\| \[\]/);
  assert.match(serverJs, /ticket\.status === 'CLOSED'/);
  assert.match(serverJs, /SET status = 'OPEN'/);
  assert.match(serverJs, /'NEEDS_INFO'/);
  assert.match(appJs, /if \(panelId === 'profile-support-panel' && connectedWallet\) loadUserTickets\(connectedWallet\)/);
  assert.match(appHtml, /id="refresh-user-tickets"/);
  assert.match(appJs, /refresh-user-tickets'\)\?\.addEventListener\('click'/);
});

test('review submission and moderation are wallet-bound and admin-protected', () => {
  assert.match(serverJs, /app\.post\('\/api\/user\/reviews', sensitiveLimiter, requireWalletSession/);
  assert.match(serverJs, /app\.get\('\/api\/user\/review', requireWalletSession[\s\S]*?FROM accounts a[\s\S]*?WHERE LOWER\(a\.wallet_address\) = LOWER\(\?\)[\s\S]*?ORDER BY a\.created_at, a\.id/);
  assert.match(serverJs, /WHERE a\.id = \? AND LOWER\(a\.wallet_address\) = LOWER\(\?\)/);
  assert.doesNotMatch(serverJs.slice(serverJs.indexOf("app.get('/api/user/review'"), serverJs.indexOf("app.get('/api/reviews'")), /EXISTS \(SELECT 1 FROM purchases purchase/);
  assert.match(serverJs, /Reviews are available only for accounts assigned to this wallet/);
  assert.match(serverJs, /WHERE a\.id = \? AND LOWER\(a\.wallet_address\) = LOWER\(\?\)/);
  assert.match(serverJs, /INSERT INTO user_reviews \(account_id, wallet_address, username, rating, comment, published, moderation_status\)/);
  assert.match(serverJs, /ON CONFLICT\(account_id\) DO UPDATE/);
  assert.match(serverJs, /WHERE LOWER\(user_reviews\.wallet_address\) = LOWER\(excluded\.wallet_address\)/);
  assert.match(serverJs, /rating < 1 \|\| rating > 5/);
  assert.match(serverJs, /published = 0/);
  assert.match(serverJs, /app\.get\('\/api\/reviews'/);
  assert.match(serverJs, /FROM user_reviews WHERE published = 1/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/reviews', sensitiveLimiter, requireTradeSignature, requireAdminWallet/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/reviews\/action', sensitiveLimiter, requireTradeSignature, requireAdminWallet/);
});

test('support and moderation views render action controls and visual ticket statuses', () => {
  assert.match(appHtml, /id="user-ticket-list"/);
  assert.match(appHtml, /id="admin-ticket-list"/);
  assert.match(appHtml, /id="admin-support-inbox-panel"/);
  assert.match(appHtml, /data-admin-ticket-filter="UNREAD"/);
  assert.match(appHtml, /id="admin-review-list"/);
  assert.match(appHtml, /id="review-account" required disabled/);
  assert.match(appHtml, /Any account assigned to your wallet is eligible, including free promo accounts/);
  assert.match(appHtml, /one review per account/i);
  assert.match(appJs, /data-review-account="\$\{escapeHTML\(review\.account_id\)\}"/);
  assert.match(appJs, /review_account_id: accountId/);
  assert.match(appJs, /account_id: document\.getElementById\('review-account'\)\.value/);
  assert.match(appJs, /data-admin-ticket-action="REPLY"/);
  assert.match(appJs, /data-admin-ticket-action="CLOSE"/);
  assert.match(appJs, /\/api\/admin\/tickets\/read/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/tickets\/read', requireWalletSession, requireAdminSession/);
  assert.match(serverJs, /CASE WHEN COALESCE\(last_message\.id, 0\) > COALESCE\(read_state\.last_read_message_id, 0\)/);
  assert.match(serverJs, /app\.post\('\/api\/staff\/tickets\/accept', sensitiveLimiter, requireWalletSession, requireSupportStaff/);
  assert.match(serverJs, /assigned_staff_wallet IS NULL/);
  assert.match(serverJs, /t\.assigned_staff_wallet IS NULL OR \$\{staffWalletPredicate\}/);
  assert.match(serverJs, /Accept this ticket before replying or closing it/);
  assert.match(serverJs, /Unable to release tickets assigned to the removed support wallet/);
  assert.match(appJs, /data-staff-ticket-action="ACCEPT"/);
  assert.match(appJs, /data-review-action="\$\{Number\(review\.published\) \? 'HIDE' : 'PUBLISH'\}"/);
  assert.match(appCss, /\.support-status-open/);
  assert.match(appCss, /\.support-status-needs-info/);
  assert.match(appCss, /\.support-status-closed/);
});

test('public reviews use text nodes for user-provided content', () => {
  assert.match(landingHtml, /loadPublishedReviews/);
  assert.match(landingHtml, /username\.textContent=.*review\.username/);
  assert.match(landingHtml, /comment\.textContent=review\.comment/);
  assert.match(landingHtml, /stars\.textContent=.*review\.rating/);
  assert.doesNotMatch(landingHtml, /innerHTML\s*=\s*review\.(?:username|comment)/);
});
