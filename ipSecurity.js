const crypto = require('crypto');

const SESSION_LIMIT_PER_IP = 5;
const MAX_ACTIVE_SESSIONS = 5000;
const MAX_RATE_LIMIT_KEYS = 10000;
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const WALLET_LOCK_REAUTH_GRACE_MS = SESSION_IDLE_TIMEOUT_MS;

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createRateLimiter(maxRequests = 40, windowMs = 60000, keySelector = req => req.ip || 'unknown') {
  const buckets = new Map();
  let lastPrunedAt = 0;

  return (req, res, next) => {
    const now = Date.now();
    const key = String(keySelector(req) || 'unknown');

    if (now - lastPrunedAt >= windowMs || buckets.size >= MAX_RATE_LIMIT_KEYS) {
      for (const [bucketKey, bucket] of buckets) {
        if (now - bucket.windowStart >= windowMs) buckets.delete(bucketKey);
      }
      lastPrunedAt = now;
    }

    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      if (!bucket && buckets.size >= MAX_RATE_LIMIT_KEYS) {
        return res.status(503).json({ success: false, error: 'Request protection is temporarily unavailable.' });
      }
      bucket = { count: 0, windowStart: now };
      buckets.set(key, bucket);
    }

    bucket.count++;
    if (bucket.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      console.warn(`[RATE LIMIT] Blocked requests for exceeding ${maxRequests} requests.`);
      return res.status(429).json({ success: false, error: 'Too many requests. Please slow down.' });
    }

    next();
  };
}

function registerWalletSession(db, { token, walletAddress, ipAddress, expiresAt }, callback) {
  const now = Date.now();
  const tokenHash = hashSessionToken(token);
  let completed = false;
  const finish = (err, result) => {
    if (completed) return;
    completed = true;
    callback(err, result);
  };

  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', beginErr => {
      if (beginErr) return finish(beginErr);
      const rollback = err => db.run('ROLLBACK', () => finish(err));
      db.run(
        'DELETE FROM wallet_sessions WHERE expires_at <= ? OR last_seen_at <= ? OR revoked_at IS NOT NULL',
        [now, now - SESSION_IDLE_TIMEOUT_MS],
        cleanupErr => {
          if (cleanupErr) return rollback(cleanupErr);
          db.get('SELECT COUNT(*) AS count FROM wallet_sessions', [], (capacityErr, capacity) => {
            if (capacityErr) return rollback(capacityErr);
            if (Number(capacity?.count) >= MAX_ACTIVE_SESSIONS) {
              return rollback(Object.assign(new Error('Wallet sessions are temporarily unavailable.'), { code: 'SESSION_CAPACITY' }));
            }
            db.get(
              `SELECT COUNT(*) AS count FROM wallet_sessions
               WHERE ip_address = ? AND expires_at > ? AND last_seen_at > ? AND revoked_at IS NULL`,
              [ipAddress, now, now - SESSION_IDLE_TIMEOUT_MS],
              (countErr, row) => {
                if (countErr) return rollback(countErr);
                const sessionCount = Number(row?.count || 0) + 1;
                db.run(
                  `INSERT INTO wallet_sessions
                   (token_hash, wallet_address, ip_address, expires_at, created_at, last_seen_at, reauthenticated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  [tokenHash, walletAddress, ipAddress, expiresAt, now, now, now],
                  insertErr => {
                    if (insertErr) return rollback(insertErr);
                    const commit = softLocked => db.run('COMMIT', commitErr => {
                      if (commitErr) return rollback(commitErr);
                      finish(null, { sessionCount, softLocked });
                    });
                    const maybeCommit = () => db.get(
                      `SELECT 1 AS locked FROM wallet_security_locks
                       WHERE LOWER(wallet_address) = LOWER(?) AND cleared_at IS NULL LIMIT 1`,
                      [walletAddress],
                      (lockErr, lock) => lockErr ? rollback(lockErr) : commit(Boolean(lock))
                    );

                    if (sessionCount <= SESSION_LIMIT_PER_IP) return maybeCommit();
                    db.get(
                      `SELECT 1 AS locked FROM wallet_security_locks
                       WHERE LOWER(wallet_address) = LOWER(?) AND cleared_at IS NULL LIMIT 1`,
                      [walletAddress],
                      (existingLockErr, existingLock) => {
                        if (existingLockErr) return rollback(existingLockErr);
                        db.run(
                          `INSERT INTO ip_security_incidents (ip_address, triggering_wallet, session_count, created_at)
                           VALUES (?, ?, ?, ?)`,
                          [ipAddress, walletAddress, sessionCount, now],
                          function(incidentErr) {
                            if (incidentErr) return rollback(incidentErr);
                            if (existingLock) return maybeCommit();
                            const incidentId = this.lastID;
                            db.run(
                              `INSERT INTO wallet_security_locks (wallet_address, incident_id, locked_at)
                               VALUES (?, ?, ?)`,
                              [walletAddress, incidentId, now],
                              lockInsertErr => {
                                if (lockInsertErr) return rollback(lockInsertErr);
                                db.run(
                                  `UPDATE wallet_sessions SET reauthenticated_at = NULL
                                   WHERE LOWER(wallet_address) = LOWER(?) AND token_hash != ?`,
                                  [walletAddress, tokenHash],
                                  resetErr => {
                                    if (resetErr) return rollback(resetErr);
                                    db.run(
                                      `UPDATE accounts
                                       SET current_balance = COALESCE(current_balance, 0) + (
                                         SELECT COALESCE(SUM(t.size_usd), 0) FROM trades t
                                         WHERE t.account_id = accounts.id AND t.status = 'PENDING'
                                       )
                                       WHERE LOWER(wallet_address) = LOWER(?)`,
                                      [walletAddress],
                                      refundErr => {
                                        if (refundErr) return rollback(refundErr);
                                        db.run(
                                          `UPDATE trades SET status = 'CLOSED', pnl = 0, closed_at = CURRENT_TIMESTAMP
                                           WHERE status = 'PENDING' AND account_id IN (
                                             SELECT id FROM accounts WHERE LOWER(wallet_address) = LOWER(?)
                                           )`,
                                          [walletAddress],
                                          cancelErr => {
                                            if (cancelErr) return rollback(cancelErr);
                                            db.run(
                                              `UPDATE trade_copy_groups SET active = 0, updated_at = CURRENT_TIMESTAMP
                                               WHERE LOWER(wallet_address) = LOWER(?)`,
                                              [walletAddress],
                                              copyGroupErr => copyGroupErr ? rollback(copyGroupErr) : maybeCommit()
                                            );
                                          }
                                        );
                                      }
                                    );
                                  }
                                );
                              }
                            );
                          }
                        );
                      }
                    );
                  }
                );
              }
            );
          });
        }
      );
    });
  });
}

function getActiveWalletLock(db, walletAddress, callback) {
  db.get(
    `SELECT l.id, l.wallet_address, l.locked_at, i.ip_address, i.session_count
     FROM wallet_security_locks l
     JOIN ip_security_incidents i ON i.id = l.incident_id
     WHERE LOWER(l.wallet_address) = LOWER(?) AND l.cleared_at IS NULL
     ORDER BY l.id DESC LIMIT 1`,
    [walletAddress],
    callback
  );
}

function getWalletSecurityStatus(db, walletAddress, tokenHash, callback) {
  const now = Date.now();
  getActiveWalletLock(db, walletAddress, (lockErr, lock) => {
    if (lockErr || !lock) return callback(lockErr, { softLocked: Boolean(lock), reauthenticationRequired: false });
    db.get(
      `SELECT reauthenticated_at FROM wallet_sessions
       WHERE token_hash = ? AND LOWER(wallet_address) = LOWER(?) AND expires_at > ? AND revoked_at IS NULL`,
      [tokenHash, walletAddress, now],
      (sessionErr, session) => {
        if (sessionErr) return callback(sessionErr);
        if (!session) return callback(Object.assign(new Error('Wallet session is no longer active.'), { code: 'SESSION_INVALID' }));
        db.get(
          `SELECT COUNT(*) AS active_count,
                  SUM(CASE WHEN reauthenticated_at >= ? THEN 1 ELSE 0 END) AS reauthenticated_count
           FROM wallet_sessions
           WHERE LOWER(wallet_address) = LOWER(?) AND expires_at > ?
             AND last_seen_at > ? AND revoked_at IS NULL`,
          [lock.locked_at, walletAddress, now, now - SESSION_IDLE_TIMEOUT_MS],
          (countErr, counts) => {
            if (countErr) return callback(countErr);
            const activeCount = Number(counts?.active_count || 0);
            const reauthenticatedCount = Number(counts?.reauthenticated_count || 0);
            const readyToClear = activeCount === reauthenticatedCount &&
              now - Number(lock.locked_at) >= WALLET_LOCK_REAUTH_GRACE_MS;
            if (!readyToClear) {
              return callback(null, {
                softLocked: true,
                lock,
                reauthenticationRequired: Number(session.reauthenticated_at || 0) < Number(lock.locked_at),
                activeSessionCount: activeCount,
                reauthenticatedSessionCount: reauthenticatedCount
              });
            }
            db.serialize(() => {
              db.run('BEGIN IMMEDIATE', beginErr => {
                if (beginErr) return callback(beginErr);
                const rollback = err => db.run('ROLLBACK', () => callback(err));
                db.run(
                  `UPDATE wallet_security_locks
                   SET cleared_at = ?, cleared_by = 'SYSTEM'
                   WHERE id = ? AND cleared_at IS NULL AND locked_at <= ?
                     AND NOT EXISTS (
                       SELECT 1 FROM wallet_sessions s
                       WHERE LOWER(s.wallet_address) = LOWER(wallet_security_locks.wallet_address)
                         AND s.expires_at > ? AND s.last_seen_at > ? AND s.revoked_at IS NULL
                         AND (s.reauthenticated_at IS NULL OR s.reauthenticated_at < wallet_security_locks.locked_at)
                     )`,
                  [now, lock.id, now - WALLET_LOCK_REAUTH_GRACE_MS, now, now - SESSION_IDLE_TIMEOUT_MS],
                  function(clearErr) {
                    if (clearErr) return rollback(clearErr);
                    if (!this.changes) {
                      return db.run('COMMIT', commitErr => commitErr ? rollback(commitErr) : callback(null, {
                        softLocked: true,
                        lock,
                        reauthenticationRequired: Number(session.reauthenticated_at || 0) < Number(lock.locked_at),
                        activeSessionCount: activeCount,
                        reauthenticatedSessionCount: reauthenticatedCount
                      }));
                    }
                    db.run(
                      `INSERT INTO wallet_security_lock_reviews (wallet_address, admin_wallet, action, reason, created_at)
                       VALUES (?, 'SYSTEM', 'AUTO_REAUTH', 'All active wallet sessions reauthenticated.', ?)`,
                      [walletAddress.toLowerCase(), now],
                      reviewErr => {
                        if (reviewErr) return rollback(reviewErr);
                        db.run('COMMIT', commitErr => commitErr ? rollback(commitErr) : callback(null, {
                          softLocked: false,
                          reauthenticationRequired: false,
                          activeSessionCount: activeCount,
                          reauthenticatedSessionCount: reauthenticatedCount
                        }));
                      }
                    );
                  }
                );
              });
            });
          }
        );
      }
    );
  });
}

function markWalletSessionReauthenticated(db, tokenHash, walletAddress, callback) {
  const now = Date.now();
  db.run(
    `UPDATE wallet_sessions
     SET reauthenticated_at = ?, last_seen_at = ?
     WHERE token_hash = ? AND LOWER(wallet_address) = LOWER(?) AND expires_at > ? AND revoked_at IS NULL`,
    [now, now, tokenHash, walletAddress, now],
    function(err) {
      if (err) return callback(err);
      if (this.changes !== 1) return callback(Object.assign(new Error('Wallet session is no longer active.'), { code: 'SESSION_INVALID' }));
      getWalletSecurityStatus(db, walletAddress, tokenHash, callback);
    }
  );
}

function clearWalletSecurityLock(db, walletAddress, adminWallet, reason, callback) {
  const now = Date.now();
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', beginErr => {
      if (beginErr) return callback(beginErr);
      const rollback = err => db.run('ROLLBACK', () => callback(err));
      db.run(
        `UPDATE wallet_security_locks
         SET cleared_at = ?, cleared_by = ?
         WHERE LOWER(wallet_address) = LOWER(?) AND cleared_at IS NULL`,
        [now, adminWallet.toLowerCase(), walletAddress],
        function(updateErr) {
          if (updateErr) return rollback(updateErr);
          const cleared = this.changes;
          if (!cleared) {
            return db.run('COMMIT', commitErr => commitErr ? rollback(commitErr) : callback(null, { cleared: false }));
          }
          db.run(
            `INSERT INTO wallet_security_lock_reviews (wallet_address, admin_wallet, action, reason, created_at)
             VALUES (?, ?, 'CLEAR', ?, ?)`,
            [walletAddress.toLowerCase(), adminWallet.toLowerCase(), reason || null, now],
            insertErr => {
              if (insertErr) return rollback(insertErr);
              db.run('COMMIT', commitErr => commitErr ? rollback(commitErr) : callback(null, { cleared: true }));
            }
          );
        }
      );
    });
  });
}

function cleanupExpiredWalletSessions(db, callback = () => {}) {
  db.run(
    'DELETE FROM wallet_sessions WHERE expires_at <= ? OR last_seen_at <= ? OR revoked_at IS NOT NULL',
    [Date.now(), Date.now() - SESSION_IDLE_TIMEOUT_MS],
    err => callback(err)
  );
}

module.exports = {
  SESSION_LIMIT_PER_IP,
  MAX_ACTIVE_SESSIONS,
  SESSION_IDLE_TIMEOUT_MS,
  hashSessionToken,
  createRateLimiter,
  registerWalletSession,
  getActiveWalletLock,
  getWalletSecurityStatus,
  markWalletSessionReauthenticated,
  clearWalletSecurityLock,
  cleanupExpiredWalletSessions
};
