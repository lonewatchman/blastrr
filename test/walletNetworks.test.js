const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const serverJs = fs.readFileSync('server.js', 'utf8');
const databaseJs = fs.readFileSync('database.js', 'utf8');
const appHtml = fs.readFileSync('public/app.html', 'utf8');
const appJs = fs.readFileSync('public/js/app.js', 'utf8');

test('wallet sessions preserve EVM and Solana identities and require the matching signature', () => {
  assert.match(serverJs, /function getWalletType\(wallet\)[\s\S]*?return decodeBase58\(wallet\)\?\.length === 32 \? 'SOLANA' : null/);
  assert.match(serverJs, /crypto\.verify\(null, Buffer\.from\(message, 'utf8'\), publicKey, signatureBytes\)/);
  assert.match(serverJs, /stored\.walletType !== walletType/);
  assert.match(serverJs, /req\.walletType === 'SOLANA'[\s\S]*?'wallet_address = \?'/);
  assert.match(appJs, /return connectedWalletType === 'SOLANA'[\s\S]*?`solana:\$\{connectedWallet\}`/);
  assert.match(appJs, /async function onWalletSwitched[\s\S]*?getConnectedWalletOwnerKey\(\) !== owner[\s\S]*?await ensureWalletSession\(\)/);
  assert.match(appJs, /async function signedTradeAuthorization\(\)[\s\S]*?connectedWalletType === 'SOLANA'[\s\S]*?provider\.signMessage/);
});

test('purchases enforce matching wallet networks and verify both Solana stablecoins', () => {
  assert.match(serverJs, /if \(req\.walletType !== 'SOLANA'[\s\S]*?normalizeWalletAddress\(paymentWallet, 'SOLANA'\) !== wallet_address/);
  assert.match(serverJs, /if \(req\.walletType !== 'EVM'\)[\s\S]*?EVM payments are available only to the active EVM wallet/);
  assert.match(serverJs, /async function verifySolanaPurchase[\s\S]*?transaction\.meta\?\.err[\s\S]*?SOLANA_TREASURY_WALLET/);
  assert.match(appJs, /if \(connectedWalletType !== 'SOLANA'\)[\s\S]*?completeSolanaPlanPurchase/);
  assert.match(appJs, /if \(connectedWalletType !== 'EVM'\)[\s\S]*?EVM payments are available only to a connected EVM wallet/);
  assert.match(appJs, /payment_wallet_address: payer\.toBase58\(\)/);
  assert.match(appHtml, /id="wallet-login-type"/);
  assert.match(appHtml, /id="wallet-add-type"/);
});

test('withdrawal payout selections are validated and saved for admin review', () => {
  assert.match(serverJs, /function isValidPayoutSelection\(walletType, chainId, assetSymbol\)[\s\S]*?walletType === 'SOLANA'[\s\S]*?chainId === 101[\s\S]*?walletType === 'EVM'[\s\S]*?chainId !== 101/);
  assert.match(serverJs, /isValidPayoutSelection\(req\.walletType, payoutChainId, payoutAsset\)/);
  assert.match(serverJs, /payout_chain_id, payout_asset/);
  assert.match(serverJs, /w\.payout_chain_id, COALESCE\(w\.payout_asset, 'USDT'\) AS payout_asset/);
  assert.match(serverJs, /payout_chain_id, COALESCE\(payout_asset, 'USDT'\) AS payout_asset/);
  assert.match(databaseJs, /payout_chain_id INTEGER/);
  assert.match(databaseJs, /payout_asset TEXT NOT NULL DEFAULT 'USDT'/);
  assert.match(appJs, /function getSelectedPayoutOptions\(prefix\)/);
  assert.match(appJs, /Payout: \$\{payoutLabel\}/);
});

test('wallet-specific payout menus do not mix EVM and Solana networks', () => {
  assert.match(appJs, /const networks = isSolana[\s\S]*?SOLANA_TOKENS[\s\S]*?SUPPORTED_EVM_CHAINS/);
  assert.match(appJs, /networkSelect\.disabled = isSolana/);
  assert.match(appJs, /SUPPORTED_EVM_CHAINS\[payoutChainId\]/);
  assert.match(appJs, /connectedWalletType === 'SOLANA' \? SOLANA_TOKENS : \{\}/);
  assert.match(appJs, /connectedWalletType === 'EVM' \? SUPPORTED_EVM_CHAINS/);
});
