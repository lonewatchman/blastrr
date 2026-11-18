const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const serverJs = fs.readFileSync('server.js', 'utf8');
const appHtml = fs.readFileSync('public/app.html', 'utf8');
const appJs = fs.readFileSync('public/js/app.js', 'utf8');
const appCss = fs.readFileSync('public/css/app.css', 'utf8');

test('users can only retrieve their own approved withdrawal certificates', () => {
  const routeStart = serverJs.indexOf("app.get('/api/user/withdrawal-certificates'");
  const routeEnd = serverJs.indexOf("app.post('/api/user/profile'", routeStart);
  const route = serverJs.slice(routeStart, routeEnd);
  assert.match(route, /requireWalletSession/);
  assert.match(route, /FROM withdrawals[\s\S]*?status = 'PAID'/);
  assert.match(route, /COALESCE\(user_amount, ROUND\(amount \* 0\.9, 2\)\)/);
  assert.match(route, /FROM referral_withdrawals[\s\S]*?status = 'PAID'/);
  assert.match(route, /WHERE LOWER\(wallet_address\) = LOWER\(\?\)/);
  assert.match(route, /SELECT username FROM users WHERE LOWER\(wallet_address\) = LOWER\(\?\)/);
  assert.doesNotMatch(route, /'ACCOUNT' AS type|'COMMISSION' AS type|plan_name/);
});

test('profile achievements list approved certificates and download branded JPGs', () => {
  assert.match(appHtml, /src="\/js\/app\.js\?v=20261119-wallet-types" defer/);
  assert.match(appHtml, /id="profile-achievements-tab"[^>]*>Achievements<\/button>/);
  assert.match(appHtml, /id="profile-achievements-panel"[^>]*role="tabpanel"/);
  assert.match(appHtml, /id="withdrawal-certificates-list"/);
  assert.match(appJs, /\['profile-achievements-panel', 'profile-achievements-tab'\]/);
  assert.match(appJs, /if \(panelId === 'profile-achievements-panel' && connectedWallet\) loadWithdrawalCertificates\(\)/);
  assert.match(appJs, /walletFetch\('\/api\/user\/withdrawal-certificates'\)/);
  assert.match(appJs, /Your certificate will appear here after a withdrawal is marked paid/);
  assert.match(appJs, /data-withdrawal-certificate/);
  assert.match(appJs, /data-share-withdrawal-certificate/);
  assert.match(appJs, /https:\/\/x\.com\/intent\/post\?text=/);
  assert.match(appJs, /Attach the JPG to your X post/);
  assert.match(appJs, /class="withdrawal-certificate-preview" width="480" height="300"/);
  assert.match(appJs, /async function renderWithdrawalCertificate\(canvas, certificate\)/);
  assert.match(appJs, /return renderWithdrawalCertificate\(canvas,/);
  assert.match(appJs, /await renderWithdrawalCertificate\(canvas,/);
  assert.match(appJs, /canvas\.toBlob\(resolve, 'image\/jpeg', 0\.94\)/);
  assert.match(appJs, /blastrr-performance-bonus-certificate-\$\{card\.dataset\.certificateId\}\.jpg/);
  assert.match(appJs, /context\.drawImage\(logo, 105, 104, 68, 68\)/);
  assert.match(appJs, /'PERFORMANCE BONUS'/);
  assert.match(appJs, /'Certificate of Achievement'/);
  assert.match(appJs, /'Approved performance bonus'/);
  assert.match(appJs, /<div><strong>Performance bonus<\/strong>/);
  assert.doesNotMatch(appJs, /certificate\.type|data-certificate-type/);
  assert.match(appCss, /\.withdrawal-certificate-card/);
  assert.match(appCss, /\.withdrawal-certificate-preview/);
});

test('leaderboard exclusion checkbox keeps native dimensions and styling', () => {
  assert.match(appHtml, /href="\/css\/app\.css\?v=20261118-wallet-selects"/);
  assert.match(appCss, /\.leaderboard-toolbar input:not\(\[type="checkbox"\]\)/);
  assert.match(appCss, /\.leaderboard-toolbar \.leaderboard-exclude-control input\[type="checkbox"\]/);
  assert.match(appCss, /\.leaderboard-toolbar input:not\(\[type="checkbox"\]\) \{/);
  assert.match(appCss, /\.withdrawal-certificate-list \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(appCss, /@media \(max-width: 900px\).*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(appCss, /@media \(max-width: 600px\).*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(appCss, /\.withdrawal-certificate-card > \.withdrawal-certificate-actions/);
});
