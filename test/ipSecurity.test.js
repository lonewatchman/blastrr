const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sqlite3 = require('sqlite3').verbose();
const {
  clearWalletSecurityLock,
  createRateLimiter,
  getActiveWalletLock,
  getWalletSecurityStatus,
  hashSessionToken,
  markWalletSessionReauthenticated,
  registerWalletSession
} = require('../ipSecurity');

const serverJs = fs.readFileSync('server.js', 'utf8');
const databaseJs = fs.readFileSync('database.js', 'utf8');
const appJs = fs.readFileSync('public/js/app.js', 'utf8');
const appHtml = fs.readFileSync('public/app.html', 'utf8');

function createSecurityDb() {
  const db = new sqlite3.Database(':memory:');
  const statements = [
    `CREATE TABLE wallet_sessions (
      token_hash TEXT PRIMARY KEY, wallet_address TEXT NOT NULL, ip_address TEXT NOT NULL,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      reauthenticated_at INTEGER, revoked_at INTEGER
    )`,
    `CREATE TABLE ip_security_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ip_address TEXT NOT NULL,
      triggering_wallet TEXT NOT NULL, session_count INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE wallet_security_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_address TEXT NOT NULL, incident_id INTEGER NOT NULL,
      locked_at INTEGER NOT NULL, cleared_at INTEGER, cleared_by TEXT
    )`,
    'CREATE UNIQUE INDEX wallet_security_locks_active ON wallet_security_locks(wallet_address) WHERE cleared_at IS NULL',
    `CREATE TABLE wallet_security_lock_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_address TEXT NOT NULL, admin_wallet TEXT NOT NULL,
      action TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE accounts (
      id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL, current_balance REAL, status TEXT DEFAULT 'ACTIVE'
    )`,
    `CREATE TABLE trades (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, size_usd REAL, status TEXT DEFAULT 'OPEN',
      pnl REAL DEFAULT 0, closed_at DATETIME
    )`,
    `CREATE TABLE trade_copy_groups (
      id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      let index = 0;
      const runNext = () => {
        if (index >= statements.length) return resolve(db);
        db.run(statements[index++], err => err ? reject(err) : runNext());
      };
      runNext();
    });
  });
}

function register(db, token, wallet, ip = '203.0.113.8') {
  return new Promise((resolve, reject) => {
    registerWalletSession(db, {
      token,
      walletAddress: wallet,
      ipAddress: ip,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000
    }, (err, result) => err ? reject(err) : resolve(result));
  });
}

function getLock(db, wallet) {
  return new Promise((resolve, reject) => {
    getActiveWalletLock(db, wallet, (err, lock) => err ? reject(err) : resolve(lock));
  });
}

function getStatus(db, wallet, token) {
  return new Promise((resolve, reject) => {
    getWalletSecurityStatus(db, wallet, hashSessionToken(token), (err, status) => err ? reject(err) : resolve(status));
  });
}

function reauthenticate(db, wallet, token) {
  return new Promise((resolve, reject) => {
    markWalletSessionReauthenticated(db, hashSessionToken(token), wallet, (err, status) => err ? reject(err) : resolve(status));
  });
}

function getValue(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

test('the sixth IP session locks only its wallet and supports all-session reauthentication', async t => {
  const db = await createSecurityDb();
  t.after(() => db.close());
  const wallets = ['wallet-a', 'wallet-b', 'wallet-c', 'wallet-d', 'wallet-e'];
  for (let index = 0; index < wallets.length; index++) {
    const result = await register(db, `token-${index}`, wallets[index]);
    assert.equal(result.softLocked, false);
  }
  const triggering = await register(db, 'token-e-second', 'wallet-e');
  assert.equal(triggering.sessionCount, 6);
  assert.equal(triggering.softLocked, true);
  assert.equal(await getLock(db, 'wallet-a'), undefined);
  assert.equal(await getLock(db, 'wallet-e') !== undefined, true);

  const status = await getStatus(db, 'wallet-e', 'token-e-second');
  assert.equal(status.softLocked, true);
  assert.equal(status.reauthenticationRequired, false);
  assert.equal(status.activeSessionCount, 2);
  assert.equal(status.reauthenticatedSessionCount, 1);

  const priorSessionStatus = await reauthenticate(db, 'wallet-e', 'token-4');
  assert.equal(priorSessionStatus.softLocked, true);
  assert.equal(priorSessionStatus.reauthenticatedSessionCount, 2);

  const realNow = Date.now;
  const unlockStatus = await (async () => {
    Date.now = () => realNow() + 16 * 60 * 1000;
    try {
      return await getStatus(db, 'wallet-e', 'token-e-second');
    } finally {
      Date.now = realNow;
    }
  })();
  assert.equal(unlockStatus.softLocked, false);
  assert.equal(await getLock(db, 'wallet-e'), undefined);
  const autoReview = await getValue(db, "SELECT action FROM wallet_security_lock_reviews WHERE wallet_address = 'wallet-e'");
  assert.equal(autoReview.action, 'AUTO_REAUTH');
});

test('soft-locking a wallet cancels pending orders, refunds margin, and pauses copy groups', async t => {
  const db = await createSecurityDb();
  t.after(() => db.close());
  await new Promise((resolve, reject) => db.run(
    'INSERT INTO accounts (id, wallet_address, current_balance) VALUES (?, ?, ?)',
    ['account-a', 'wallet-a', 900],
    err => err ? reject(err) : resolve()
  ));
  await new Promise((resolve, reject) => db.run(
    `INSERT INTO trades (id, account_id, size_usd, status) VALUES
     ('pending-order', 'account-a', 100, 'PENDING'),
     ('open-position', 'account-a', 200, 'OPEN')`,
    err => err ? reject(err) : resolve()
  ));
  await new Promise((resolve, reject) => db.run(
    'INSERT INTO trade_copy_groups (id, wallet_address, name, active) VALUES (?, ?, ?, 1)',
    ['group-a', 'wallet-a', 'Test group'],
    err => err ? reject(err) : resolve()
  ));

  for (let index = 0; index < 6; index++) {
    await register(db, `wallet-a-${index}`, 'wallet-a');
  }

  const account = await getValue(db, 'SELECT current_balance FROM accounts WHERE id = ?', ['account-a']);
  const pendingOrder = await getValue(db, 'SELECT status FROM trades WHERE id = ?', ['pending-order']);
  const openPosition = await getValue(db, 'SELECT status FROM trades WHERE id = ?', ['open-position']);
  const copyGroup = await getValue(db, 'SELECT active FROM trade_copy_groups WHERE id = ?', ['group-a']);
  assert.equal(account.current_balance, 1000);
  assert.equal(pendingOrder.status, 'CLOSED');
  assert.equal(openPosition.status, 'OPEN');
  assert.equal(copyGroup.active, 0);
});

test('concurrent session creation enforces the five-session cap transactionally', async t => {
  const db = await createSecurityDb();
  t.after(() => db.close());
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) => register(db, `concurrent-token-${index}`, `concurrent-wallet-${index}`))
  );
  assert.equal(results.filter(result => result.softLocked).length, 1);
  const incident = await getValue(db, 'SELECT session_count FROM ip_security_incidents');
  assert.equal(incident.session_count, 6);
  const lockCount = await getValue(db, 'SELECT COUNT(*) AS count FROM wallet_security_locks WHERE cleared_at IS NULL');
  assert.equal(lockCount.count, 1);
});

test('IP rate limits are bounded and return Retry-After', () => {
  const limiter = createRateLimiter(1, 60000);
  let nextCalls = 0;
  let statusCode = 0;
  let retryAfter = null;
  const response = {
    set(name, value) { if (name === 'Retry-After') retryAfter = value; return this; },
    status(code) { statusCode = code; return this; },
    json() { return this; }
  };
  const request = { ip: '203.0.113.9' };
  limiter(request, response, () => nextCalls++);
  limiter(request, response, () => nextCalls++);
  assert.equal(nextCalls, 1);
  assert.equal(statusCode, 429);
  assert.ok(Number(retryAfter) > 0);
});

test('trading and charts enforce wallet locks while close, flatten, and support remain available', () => {
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS wallet_sessions/);
  assert.match(databaseJs, /CREATE TABLE IF NOT EXISTS wallet_security_locks/);
  assert.match(serverJs, /app\.post\('\/api\/trades\/execute', sensitiveLimiter, requireWalletSession, walletActionLimiter, requireWalletNotSoftLocked/);
  assert.match(serverJs, /app\.get\('\/api\/forex\/candles', sensitiveLimiter, requireWalletSession, chartLimiter, requireWalletNotSoftLocked/);
  assert.match(serverJs, /app\.get\('\/api\/market-data\/stream', sensitiveLimiter, requireWalletSession, chartLimiter, requireWalletNotSoftLocked/);
  assert.match(serverJs, /app\.post\('\/api\/trades\/close', sensitiveLimiter, requireWalletSession, \(req, res\)/);
  assert.match(serverJs, /app\.post\('\/api\/trade-copy\/flatten', sensitiveLimiter, requireWalletSession, \(req, res\)/);
  assert.match(serverJs, /app\.post\('\/api\/user\/tickets', sensitiveLimiter, requireWalletSession/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/users\/action'.*CLEAR_IP_SOFT_LOCK/);
  assert.match(appJs, /Authorization: `Bearer \$\{token\}`/);
  assert.match(appJs, /reauthorizeWalletSession/);
  assert.match(appHtml, /Re-sign on every active wallet session/);
});
