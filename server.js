const express = require('express');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { ethers } = require('ethers');
const db = require('./database');
const defaultPlans = require('./config/plans.json');
const markets = require('./public/config/markets.json');
const forexMarkets = require('./public/config/forexMarkets.json');
const {
  USD_CONVERSION_SYMBOLS,
  calculateForexMargin,
  getQuoteToUsdRate,
  parseForexChartHistory,
  resolveForexStopTargetPrices
} = require('./forexRules');
const supportedMarkets = [...markets, ...forexMarkets];
const { CHAT_COOLDOWN_MS, moderateChatMessage } = require('./chatRules');
const {
  advanceRiskBaselines,
  calculateUnrealizedPnl,
  getActiveLock,
  getLiveRiskBalance,
  getMllFloor,
  getRiskBalance,
  getRiskBreach,
  getTradeMargin
} = require('./riskRules');
const { getProtectedPayoutBalance, getAvailableGrossWithdrawal, splitWithdrawal } = require('./payoutRules');
const { getTriggeredExitPrice, resolveStopTargetPrices } = require('./tradeRules');
const { isLimitOrderTriggered } = require('./limitOrderRules');
const { calculateTradePerformance } = require('./performanceRules');
const { MarketDataService } = require('./marketDataService');
const { createMarketDataProviders } = require('./marketDataProviders');
const {
  SESSION_LIMIT_PER_IP,
  SESSION_IDLE_TIMEOUT_MS,
  hashSessionToken,
  createRateLimiter,
  registerWalletSession,
  getWalletSecurityStatus,
  markWalletSessionReauthenticated,
  clearWalletSecurityLock,
  cleanupExpiredWalletSessions
} = require('./ipSecurity');

const app = express();
const PORT = process.env.PORT || 4480;

const TREASURY_WALLET = '0xFBD3B9bA404f590b9A7b35B72104bEff9DEa5503';
const DISCLAIMER_VERSION = '2026-11-17-v2';
const MAINTENANCE_PAGE_IDS = ['home', 'trade', 'accounts', 'copytrading', 'leaderboard', 'blastrrpass', 'profile', 'plans', 'faq', 'docs'];

// --- SUPPORTED EVM CHAINS CONFIGURATION ---
const SUPPORTED_EVM_CHAINS = {
    1: {
        name: "Ethereum Mainnet",
        chainIdHex: "0x1",
        rpcUrl: process.env.ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com",
        usdtAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        decimals: 6
    },
    8453: {
        name: "Base",
        chainIdHex: "0x2105",
        rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
        usdtAddress: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
        decimals: 6
    },
    137: {
        name: "Polygon PoS",
        chainIdHex: "0x89",
        rpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com",
        usdtAddress: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
        decimals: 6
    },
    43114: {
        name: "Avalanche C-Chain",
        chainIdHex: "0xa86a",
        rpcUrl: process.env.AVALANCHE_RPC_URL || "https://avalanche-c-chain-rpc.publicnode.com",
        usdtAddress: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7",
        decimals: 6
    },
    56: {
        name: "BNB Smart Chain",
        chainIdHex: "0x38",
        rpcUrl: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
        usdtAddress: "0x55d398326f99059fF775485246999027B3197955",
        decimals: 18
    },
    448000: {
        name: "NullNet Private EVM",
        chainIdHex: "0x6d600",
        rpcUrl: "https://rpc.lunul.org",
        usdtAddress: "0x7ec3659A8225ED474D7c662126616aE08545C29b", // Your deployed contract address
        decimals: 18
    }
};

// --- 1. PROXY TRUST CONFIGURATION ---
app.set('trust proxy', 'loopback');

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- 2. IP-BASED RATE LIMITER & BINANCE CACHE ---
const copyFlatteningWallets = new Set();
const inFlightTradeExecutions = new Map();
const tradeExecutionWaiters = new Map();
const inFlightAccountTradeRequests = new Set();

function trackTradeExecution(walletAddress, response) {
  inFlightTradeExecutions.set(walletAddress, (inFlightTradeExecutions.get(walletAddress) || 0) + 1);
  let completed = false;
  const release = () => {
    if (completed) return;
    completed = true;
    const remaining = Math.max(0, (inFlightTradeExecutions.get(walletAddress) || 1) - 1);
    if (remaining > 0) {
      inFlightTradeExecutions.set(walletAddress, remaining);
      return;
    }
    inFlightTradeExecutions.delete(walletAddress);
    const waiters = tradeExecutionWaiters.get(walletAddress) || [];
    tradeExecutionWaiters.delete(walletAddress);
    waiters.forEach(resolve => resolve());
  };
  response.once('finish', release);
  return release;
}

function waitForTradeExecutions(walletAddress, callback) {
  if (!inFlightTradeExecutions.has(walletAddress)) return callback();
  const waiters = tradeExecutionWaiters.get(walletAddress) || [];
  waiters.push(callback);
  tradeExecutionWaiters.set(walletAddress, waiters);
}

const sensitiveLimiter = createRateLimiter(30, 60000);
const challengeLimiter = createRateLimiter(10, 60000);
const walletSessionLimiter = createRateLimiter(10, 60000, req => `${req.ip || 'unknown'}:${req.walletAddress || 'unknown'}`);
const walletActionLimiter = createRateLimiter(30, 60000, req => req.walletAddress || 'unknown');
const chartLimiter = createRateLimiter(120, 60000, req => `${req.ip || 'unknown'}:${req.walletAddress || 'unknown'}`);

function seedPlans() {
  const initializeRewards = () => db.run(
    `INSERT OR IGNORE INTO battlepass_plan_rewards (plan_id, xp_reward, points_reward)
     SELECT id, 1000, 100 FROM plans WHERE active = 1`,
    rewardErr => {
      if (rewardErr) return console.error('Unable to initialize battle pass plan rewards:', rewardErr.message);
      console.log(`Initialized missing plans from config/plans.json.`);
    }
  );
  const correctUntouchedWhaleAccounts = () => {
    const defaultWhalePlan = defaultPlans.find(plan => plan.name === 'Whale $250k');
    if (!defaultWhalePlan || defaultWhalePlan.simulated_capital !== 250000) {
      console.error('Unable to correct untouched Whale accounts because the configured capital is unexpected.');
      return initializeRewards();
    }
    db.get('SELECT id, simulated_capital FROM plans WHERE name = ? ORDER BY id LIMIT 1', [defaultWhalePlan.name], (lookupErr, whalePlan) => {
      if (lookupErr) {
        console.error('Unable to look up the Whale plan:', lookupErr.message);
        return;
      }
      if (!whalePlan || Number(whalePlan.simulated_capital) !== defaultWhalePlan.simulated_capital) {
        return initializeRewards();
      }
      db.run(
        `UPDATE accounts
         SET initial_balance = ?, current_balance = ?, current_equity = ?,
             high_water_mark = ?, daily_starting_balance = ?
         WHERE plan_id = ?
           AND status = 'ACTIVE' AND COALESCE(permanent_lock, 0) = 0
           AND lock_reason IS NULL AND COALESCE(admin_frozen, 0) = 0
           AND initial_balance = 250050 AND current_balance = 250050
           AND current_equity = 250050 AND high_water_mark = 250050
           AND daily_starting_balance = 250050
           AND NOT EXISTS (SELECT 1 FROM trades WHERE trades.account_id = accounts.id)
           AND NOT EXISTS (SELECT 1 FROM withdrawals WHERE withdrawals.account_id = accounts.id)`,
        [
          defaultWhalePlan.simulated_capital,
          defaultWhalePlan.simulated_capital,
          defaultWhalePlan.simulated_capital,
          defaultWhalePlan.simulated_capital,
          defaultWhalePlan.simulated_capital,
          whalePlan.id
        ],
        function(migrationErr) {
          if (migrationErr) return console.error('Unable to correct untouched Whale account balances:', migrationErr.message);
          if (this.changes) console.log(`Corrected ${this.changes} untouched Whale account balance(s) to $${defaultWhalePlan.simulated_capital}.`);
          initializeRewards();
        }
      );
    });
  };
  const finishPlanSeed = () => db.run(
    'UPDATE plan_seed_state SET seeded = 1 WHERE id = 1',
    seedErr => {
      if (seedErr) return console.error('Unable to mark the initial plan seed complete:', seedErr.message);
      correctUntouchedWhaleAccounts();
    }
  );
  const addMissingPlan = index => {
    if (index >= defaultPlans.length) return finishPlanSeed();
    const plan = defaultPlans[index];
    db.get('SELECT id FROM plans WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1', [plan.name], (lookupErr, existing) => {
      if (lookupErr) return console.error('Unable to look up configured plan', lookupErr.message);
      if (existing) return addMissingPlan(index + 1);
      db.run(
        `INSERT INTO plans (name, base_price_usdt, price_usdt, simulated_capital, profit_target,
         max_drawdown_pct, daily_loss_pct, max_single_day_profit_pct, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          plan.name,
          plan.base_price_usdt,
          plan.price_usdt,
          plan.simulated_capital,
          plan.profit_target,
          plan.max_drawdown_pct,
          plan.daily_loss_pct,
          plan.max_single_day_profit_pct
        ],
        insertErr => {
          if (insertErr) return console.error(`Unable to seed plan ${plan.name}`, insertErr.message);
          addMissingPlan(index + 1);
        }
      );
    });
  };
  db.get('SELECT seeded FROM plan_seed_state WHERE id = 1', [], (stateErr, state) => {
    if (stateErr || !state) {
      console.error('Unable to load initial plan seed state:', stateErr?.message || 'Seed state is unavailable.');
      return;
    }
    if (Number(state.seeded) === 1) return correctUntouchedWhaleAccounts();
    addMissingPlan(0);
  });
}

setTimeout(seedPlans, 1000);

const tradeChallenges = new Map();
const WALLET_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const LOGIN_IP_RETENTION_DAYS = 180;
setTimeout(cleanupExpiredLoginIpEvents, 5000);
setInterval(cleanupExpiredLoginIpEvents, 24 * 60 * 60 * 1000);
setTimeout(() => cleanupExpiredWalletSessions(db, err => {
  if (err) console.error('Unable to expire wallet sessions:', err.message);
}), 5000);
setInterval(() => cleanupExpiredWalletSessions(db, err => {
  if (err) console.error('Unable to expire wallet sessions:', err.message);
}), 60 * 1000);
const forexChartHistoryCache = new Map();
const marketPriceStreamClients = new Set();
const forexChartTimeframes = Object.freeze({
  '1m': { interval: '1m', range: '5d', barSeconds: 60 },
  '5m': { interval: '5m', range: '5d', barSeconds: 300 },
  '15m': { interval: '15m', range: '1mo', barSeconds: 900 },
  '1h': { interval: '1h', range: '1mo', barSeconds: 3600 },
  '4h': { interval: '1h', range: '3mo', barSeconds: 14400 },
  '1d': { interval: '1h', range: '1y', barSeconds: 86400 }
});
// Resolve retired symbols only for existing open trades; new orders use markets from markets.json.
const legacyTradeMarkets = new Map([
  ['BINANCE:BTCUSDT', { source: 'BINANCE_SPOT', pair: 'BTCUSDT' }],
  ['BINANCE:ETHUSDT', { source: 'BINANCE_SPOT', pair: 'ETHUSDT' }],
  ['BINANCE:SOLUSDT', { source: 'BINANCE_SPOT', pair: 'SOLUSDT' }],
  ['BINANCE:BTCUSDT.P', { source: 'BINANCE_PERP', pair: 'BTCUSDT' }],
  ['BINANCE:ETHUSDT.P', { source: 'BINANCE_PERP', pair: 'ETHUSDT' }],
  ['BINANCE:SOLUSDT.P', { source: 'BINANCE_PERP', pair: 'SOLUSDT' }],
  ['BYBIT:XAUUSDT.P', { source: 'BITGET_PERP', pair: 'XAUUSDT' }],
  ['BYBIT:XAGUSDT.P', { source: 'BITGET_PERP', pair: 'XAGUSDT' }],
  ['CAPITALCOM:US100', { source: 'BITGET_PERP', pair: 'NDX100USDT' }],
  ['TVC:USOIL', { source: 'SIMULATED', pair: 'CL', base: 72, amplitude: 0.8 }]
]);

const marketDataMarkets = [
  ...Array.from(legacyTradeMarkets, ([symbol, market]) => ({
    ...market,
    symbol,
    type: market.source === 'SIMULATED' ? 'CFD' : 'FUTURE'
  })),
  ...supportedMarkets
];
const marketDataService = new MarketDataService({
  markets: marketDataMarkets,
  providers: createMarketDataProviders(),
  onProviderError: ({ source, symbol, error }) => {
    console.warn(`Market data provider ${source}${symbol ? ` (${symbol})` : ''}:`, error.message);
  }
});

function broadcastMarketDataQuote(quote) {
  const message = `data: ${JSON.stringify(quote)}\n\n`;
  for (const client of marketPriceStreamClients) {
    if (client.res.destroyed || client.res.writableEnded) {
      clearInterval(client.heartbeat);
      marketPriceStreamClients.delete(client);
    } else if (client.filter(quote)) {
      client.res.write(message);
    }
  }
}

marketDataService.on('quote', broadcastMarketDataQuote);
marketDataService.start();

function getTradeMarket(symbol) {
  return supportedMarkets.find(item => item.symbol === symbol) || legacyTradeMarkets.get(symbol);
}

function getForexChartHistory(market, timeframe) {
  const config = forexChartTimeframes[timeframe];
  if (!config) return Promise.reject(new Error('Choose a supported Forex chart timeframe.'));
  const cacheKey = `${market.symbol}:${timeframe}`;
  const cached = forexChartHistoryCache.get(cacheKey);
  if (cached?.data && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
  if (cached?.promise) return cached.promise;

  const yahooSymbol = market.history_symbol || `${market.base_currency}${market.quote_currency}=X`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${config.range}&interval=${config.interval}`;
  const historyPromise = new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Yahoo Finance returned HTTP ${response.statusCode}.`));
        try {
          const payload = JSON.parse(body);
          if (payload.chart?.error) {
            return reject(new Error(payload.chart.error.description || 'Yahoo Finance returned a chart error.'));
          }
          const history = parseForexChartHistory(payload, config.barSeconds);
          if (!market.history_symbol) return resolve(history);
          getAuthoritativeQuote(market, 72 * 60 * 60 * 1000).then(quote => {
            const latestClose = history.candles[history.candles.length - 1].close;
            const offset = quote.price - latestClose;
            const shiftPrice = value => value == null ? null : value + offset;
            resolve({
              candles: history.candles.map(candle => ({
                ...candle,
                open: shiftPrice(candle.open),
                high: shiftPrice(candle.high),
                low: shiftPrice(candle.low),
                close: shiftPrice(candle.close)
              })),
              stats: {
                ...history.stats,
                referencePrice: shiftPrice(history.stats.referencePrice),
                highPrice: shiftPrice(history.stats.highPrice),
                lowPrice: shiftPrice(history.stats.lowPrice)
              }
            });
          }).catch(reject);
        } catch (error) {
          reject(new Error(`Unable to parse Yahoo Finance Forex history: ${error.message}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Yahoo Finance chart request timed out.')));
    request.on('error', reject);
  });
  forexChartHistoryCache.set(cacheKey, { promise: historyPromise });
  historyPromise.then(data => {
    forexChartHistoryCache.set(cacheKey, { data, expiresAt: Date.now() + 60000 });
  }).catch(() => forexChartHistoryCache.delete(cacheKey));
  return historyPromise;
}

const FOREX_MAX_QUOTE_AGE_MS = 30000;
const CRYPTO_MAX_QUOTE_AGE_MS = 5000;

function getMarketQuoteMaxAgeMs(market) {
  return market?.asset_class === 'FOREX' ? FOREX_MAX_QUOTE_AGE_MS : CRYPTO_MAX_QUOTE_AGE_MS;
}

function getAuthoritativeQuote(market, maxAgeMs = getMarketQuoteMaxAgeMs(market)) {
  return Promise.resolve().then(() => marketDataService.getQuote(market.symbol, maxAgeMs));
}

function getAuthoritativePrice(market, maxAgeMs = getMarketQuoteMaxAgeMs(market)) {
  return getAuthoritativeQuote(market, maxAgeMs).then(quote => quote.price);
}

function getForexQuoteToUsdRate(market, pricesBySymbol) {
  if (market.asset_class !== 'FOREX') return 1;
  return getQuoteToUsdRate(market.quote_currency, pricesBySymbol);
}

function getLiveForexQuoteToUsdRate(market, maxAgeMs = getMarketQuoteMaxAgeMs(market)) {
  if (market.asset_class !== 'FOREX' || market.quote_currency === 'USD') return Promise.resolve(1);
  const symbol = USD_CONVERSION_SYMBOLS[market.quote_currency];
  const conversionMarket = getTradeMarket(symbol);
  if (!conversionMarket) return Promise.reject(new Error(`Forex conversion market is not configured for ${market.quote_currency}.`));
  return getAuthoritativePrice(conversionMarket, maxAgeMs)
    .then(price => getQuoteToUsdRate(market.quote_currency, new Map([[symbol, price]])));
}

function loadTradePrices(trades) {
  const requiredMarkets = new Map();
  for (const trade of trades) {
    const market = getTradeMarket(trade.symbol);
    if (!market) throw new Error(`Trade market is not configured: ${trade.symbol}`);
    requiredMarkets.set(market.symbol, market);
    if (market.asset_class === 'FOREX') {
      const conversionSymbol = USD_CONVERSION_SYMBOLS[market.quote_currency];
      if (conversionSymbol) {
        const conversionMarket = getTradeMarket(conversionSymbol);
        if (!conversionMarket) throw new Error(`Forex conversion market is not configured: ${conversionSymbol}`);
        requiredMarkets.set(conversionSymbol, conversionMarket);
      }
    }
  }
  return Promise.all([...requiredMarkets].map(async ([symbol, market]) => [symbol, await getAuthoritativePrice(market)]))
    .then(prices => new Map(prices));
}

function loadAccountWithLiveRisk(accountId, callback) {
  db.get(
    `SELECT a.*, p.name AS plan_name, p.profit_target, p.simulated_capital,
     p.max_drawdown_pct, p.daily_loss_pct,
     COALESCE((SELECT SUM(w.amount) FROM withdrawals w
       WHERE w.account_id = a.id AND w.status = 'PENDING'), 0) AS pending_withdrawal_amount
     FROM accounts a JOIN plans p ON a.plan_id = p.id WHERE a.id = ?`,
    [accountId],
    (accountErr, account) => {
      if (accountErr) return callback(accountErr);
      if (!account) return callback(new Error('Account not found.'));
      db.all(
        `SELECT * FROM trades WHERE account_id = ? AND status IN ('OPEN', 'PENDING')`,
        [accountId],
        (tradesErr, trades) => {
          if (tradesErr) return callback(tradesErr);
          const allTrades = trades || [];
          const openTrades = allTrades.filter(trade => trade.status === 'OPEN');
          const pendingOrders = allTrades.filter(trade => trade.status === 'PENDING');
          let pricesPromise;
          try {
            pricesPromise = loadTradePrices(allTrades);
          } catch (priceError) {
            return callback(priceError);
          }
          pricesPromise.then(pricesBySymbol => {
              const quoteRatesBySymbol = new Map();
              for (const trade of allTrades) {
                const market = getTradeMarket(trade.symbol);
                if (market.asset_class === 'FOREX') {
                  quoteRatesBySymbol.set(trade.symbol, getForexQuoteToUsdRate(market, pricesBySymbol));
                }
              }
              account.risk_balance = getLiveRiskBalance(account, allTrades, pricesBySymbol, quoteRatesBySymbol);
              account.open_trades = [...openTrades, ...pendingOrders].map(trade => {
                const currentPrice = pricesBySymbol.get(trade.symbol);
                const livePnl = trade.status === 'PENDING'
                  ? 0
                  : calculateUnrealizedPnl(trade, currentPrice, quoteRatesBySymbol.get(trade.symbol) ?? 1);
                return {
                  ...trade,
                  current_price: currentPrice,
                  live_pnl: livePnl
                };
              });
              callback(null, account);
            })
            .catch(callback);
        }
      );
    }
  );
}

function requireTradeSignature(req, res, next) {
  const { wallet_address: wallet, signature, challenge } = req.body;
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet) ||
      typeof signature !== 'string' || typeof challenge !== 'string') {
    return res.status(401).json({ error: 'A signed wallet challenge is required.' });
  }

  const key = wallet.toLowerCase();
  const stored = tradeChallenges.get(challenge);
  tradeChallenges.delete(challenge);
  if (!stored || stored.walletAddress !== key || stored.expiresAt <= Date.now()) {
    return res.status(401).json({ error: 'Wallet challenge expired or already used.' });
  }

  try {
    if (ethers.verifyMessage(stored.message, signature).toLowerCase() !== key) {
      return res.status(401).json({ error: 'Wallet signature does not match.' });
    }
  } catch {
    return res.status(401).json({ error: 'Wallet signature is invalid.' });
  }
  req.walletAddress = key;
  next();
}

function requireWalletSession(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
  if (!match) {
    return res.status(401).json({ error: 'A valid wallet session is required.' });
  }
  const tokenHash = hashSessionToken(match[1]);
  db.get(
    `SELECT wallet_address, ip_address, reauthenticated_at, last_seen_at FROM wallet_sessions
     WHERE token_hash = ? AND expires_at > ? AND last_seen_at > ? AND revoked_at IS NULL`,
    [tokenHash, Date.now(), Date.now() - SESSION_IDLE_TIMEOUT_MS],
    (err, session) => {
      if (err) return res.status(500).json({ error: 'Unable to verify wallet session.' });
      if (!session) return res.status(401).json({ error: 'A valid wallet session is required.' });
      const requestedWallet = req.body?.wallet_address || req.query.wallet;
      if (requestedWallet && (
        typeof requestedWallet !== 'string' ||
        !ethers.isAddress(requestedWallet) ||
        requestedWallet.toLowerCase() !== session.wallet_address.toLowerCase()
      )) {
        return res.status(403).json({ error: 'Wallet session does not match the requested wallet.' });
      }
      db.run('UPDATE wallet_sessions SET last_seen_at = ? WHERE token_hash = ?', [Date.now(), tokenHash], touchErr => {
        if (touchErr) return res.status(500).json({ error: 'Unable to refresh wallet session.' });
        req.walletAddress = session.wallet_address.toLowerCase();
        req.walletSessionIp = session.ip_address;
        req.walletSessionTokenHash = tokenHash;
        req.walletSessionReauthenticatedAt = session.reauthenticated_at;
        req.walletSessionIdleMs = Math.max(0, Date.now() - Number(session.last_seen_at));
        next();
      });
    }
  );
}

function requireWalletNotSoftLocked(req, res, next) {
  getWalletSecurityStatus(db, req.walletAddress, req.walletSessionTokenHash, (err, status) => {
    if (err) return res.status(500).json({ error: 'Unable to verify wallet security status.' });
    if (!status.softLocked) return next();
    req.walletSecurityLock = status.lock;
    res.set('X-Wallet-Soft-Locked', 'true');
    if (status.reauthenticationRequired) res.set('X-Wallet-Reauthentication-Required', 'true');
    res.status(423).json({
      error: 'Trading and chart access are temporarily disabled for this wallet. Create a support ticket for review.',
      wallet_soft_locked: true,
      locked_at: status.lock.locked_at,
      reauthentication_required: status.reauthenticationRequired
    });
  });
}

function requireWalletNotSoftLockedForNewCopyActions(req, res, next) {
  if (req.body?.active !== true) return next();
  requireWalletNotSoftLocked(req, res, next);
}

function requireSameWalletReauthentication(req, res, next) {
  const sessionWallet = req.walletAddress;
  requireTradeSignature(req, res, () => {
    const signedWallet = req.walletAddress;
    req.walletAddress = sessionWallet;
    if (signedWallet !== sessionWallet) {
      return res.status(403).json({ error: 'The signed wallet does not match this wallet session.' });
    }
    next();
  });
}

function requireUserNotSuspended(req, res, next) {
  const wallet = req.walletAddress || req.body?.wallet_address;
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet)) {
    return res.status(401).json({ error: 'A valid wallet session is required.' });
  }
  db.get(
    'SELECT admin_suspended, admin_suspend_reason FROM users WHERE LOWER(wallet_address) = LOWER(?)',
    [wallet],
    (err, user) => {
      if (err) return res.status(500).json({ error: 'Unable to verify user account access.' });
      if (Number(user?.admin_suspended) === 1) {
        return res.status(403).json({
          error: `This user account is suspended by an administrator${user.admin_suspend_reason ? `: ${user.admin_suspend_reason}` : '.'}`,
          user_suspended: true
        });
      }
      next();
    }
  );
}

function recordWalletLogin(wallet, ipAddress, callback) {
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', beginErr => {
      if (beginErr) return callback(beginErr);
      const rollback = err => db.run('ROLLBACK', () => callback(err));
      db.run(
        `DELETE FROM user_login_ip_events
         WHERE created_at < datetime('now', ?)`,
        [`-${LOGIN_IP_RETENTION_DAYS} days`],
        cleanupErr => {
          if (cleanupErr) return rollback(cleanupErr);
          db.get(
            `SELECT 1 FROM user_login_ip_events
             WHERE LOWER(wallet_address) = LOWER(?) AND ip_address = ? LIMIT 1`,
            [wallet, ipAddress],
            (lookupErr, previousLogin) => {
              if (lookupErr) return rollback(lookupErr);
              const isNewIp = previousLogin ? 0 : 1;
              db.run(
                `INSERT INTO user_login_ip_events (wallet_address, ip_address, is_new_ip)
                 VALUES (?, ?, ?)`,
                [wallet, ipAddress, isNewIp],
                insertErr => {
                  if (insertErr) return rollback(insertErr);
                  db.run('COMMIT', commitErr => commitErr ? rollback(commitErr) : callback(null, { isNewIp }));
                }
              );
            }
          );
        }
      );
    });
  });
}

function cleanupExpiredLoginIpEvents() {
  db.run(
    `DELETE FROM user_login_ip_events WHERE created_at < datetime('now', ?)`,
    [`-${LOGIN_IP_RETENTION_DAYS} days`],
    err => {
      if (err) console.error('Unable to expire old login IP records:', err.message);
    }
  );
}

function lockAccount(accountId, breach, callback) {
  const status = breach.permanent ? 'PERMANENTLY_LOCKED' : 'LOCKED';
  const finish = lock => {
    if (!lock.permanent) return callback(null, lock);
    db.run(
      `UPDATE trade_copy_groups SET active = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id IN (
         SELECT group_id FROM trade_copy_group_members
         WHERE account_id = ? AND role = 'LEADER'
       )`,
      [accountId],
      deactivateErr => {
        if (deactivateErr) return callback(deactivateErr);
        db.run(
          'DELETE FROM trade_copy_group_members WHERE account_id = ?',
          [accountId],
          removeErr => removeErr ? callback(removeErr) : callback(null, lock)
        );
      }
    );
  };
  db.run(
    `UPDATE accounts SET status = ?, lock_reason = ?, locked_until = ?, permanent_lock = ?
     WHERE id = ? AND NOT (COALESCE(permanent_lock, 0) = 1 AND ? = 0)`,
    [status, breach.reason, breach.lockedUntil, breach.permanent ? 1 : 0, accountId, breach.permanent ? 1 : 0],
    function(updateErr) {
      if (updateErr) return callback(updateErr);
      if (this.changes > 0) return finish(breach);
      db.get(
        `SELECT lock_reason, locked_until, permanent_lock FROM accounts WHERE id = ?`,
        [accountId],
        (selectErr, row) => {
          if (selectErr) return callback(selectErr);
          if (!row) return callback(new Error('Account not found while applying risk lock.'));
          finish(getActiveLock(row) || breach);
        }
      );
    }
  );
}

function settleBreachWithinTransaction(account, breach, callback) {
  const openTrades = account.open_trades || [];
  const settleNext = (index) => {
    if (index >= openTrades.length) {
      return lockAccount(account.id, breach, (lockErr, appliedLock) => {
        if (lockErr) return callback(lockErr);
        account.status = appliedLock.permanent ? 'PERMANENTLY_LOCKED' : 'LOCKED';
        account.lock_reason = appliedLock.reason;
        account.locked_until = appliedLock.lockedUntil;
        account.permanent_lock = appliedLock.permanent ? 1 : 0;
        callback(null, appliedLock);
      });
    }

    const trade = openTrades[index];
    const isPending = trade.status === 'PENDING';
    if ((!isPending && (trade.current_price == null || !Number.isFinite(Number(trade.current_price)) ||
        Number(trade.current_price) <= 0)) || trade.live_pnl == null ||
        !Number.isFinite(Number(trade.live_pnl))) {
      return callback(new Error(`Cannot close breached account trade ${trade.id} without its live price.`));
    }
    const tradePnl = isPending ? 0 : Number(trade.live_pnl);
    const returnedMargin = getTradeMargin(trade) + tradePnl;
    db.run(
      `UPDATE trades SET status = 'CLOSED', pnl = ?, closed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = ?`,
      [tradePnl, trade.id, trade.status],
      function(updateErr) {
        if (updateErr) return callback(updateErr);
        if (this.changes === 0) return settleNext(index + 1);
        db.run(
          `UPDATE accounts
           SET current_balance = COALESCE(current_balance, 0) + ?,
               current_equity = COALESCE(current_equity, 0) + ?
           WHERE id = ?`,
          [returnedMargin, tradePnl, account.id],
          (balanceErr) => {
            if (balanceErr) return callback(balanceErr);
            settleNext(index + 1);
          }
        );
      }
    );
  };
  settleNext(0);
}

function applyRiskBreach(account, breach, callback) {
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', (beginErr) => {
      if (beginErr) return callback(beginErr);
      settleBreachWithinTransaction(account, breach, (settleErr) => {
        if (settleErr) return db.run('ROLLBACK', () => callback(settleErr));
        db.run('COMMIT', (commitErr) => {
          if (commitErr) return db.run('ROLLBACK', () => callback(commitErr));
          const appliedLock = account.lock_reason === 'MLL'
            ? { reason: 'MLL', permanent: true, lockedUntil: null }
            : breach;
          closeOutstandingCopyTrades(account.wallet_address, (copyErr, copyResults) => {
            if (copyErr) console.error('Unable to close copied positions after a risk lock:', copyErr.message);
            else {
              const failures = copyResults.filter(result => !result.success);
              if (failures.length) console.error('Some copied positions remained open after a leader risk lock:', failures);
            }
            callback(null, appliedLock);
          });
        });
      });
    });
  });
}

function refreshRiskBaselines(accountId, callback) {
  const today = new Date().toISOString().slice(0, 10);
  const selectAccount = (done) => loadAccountWithLiveRisk(accountId, done);
  selectAccount((initialErr, initialAccount) => {
    if (initialErr) return callback(initialErr);
    if (!initialAccount) return callback(new Error('Account not found.'));
    if (initialAccount.risk_day === today) return callback(null, initialAccount);

    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', (beginErr) => {
        if (beginErr) return callback(beginErr);
        const rollback = (err) => db.run('ROLLBACK', () => callback(err));
        selectAccount((accountErr, account) => {
          if (accountErr) return rollback(accountErr);
          if (!account) return rollback(new Error('Account not found.'));
          if (account.risk_day === today) {
            return db.run('COMMIT', (commitErr) => commitErr ? callback(commitErr) : callback(null, account));
          }

          const baselines = advanceRiskBaselines(account, account, today);
          const updateAccount = () => db.run(
            `UPDATE accounts SET risk_day = ?, daily_starting_balance = ?, high_water_mark = ?
             WHERE id = ?`,
            [baselines.risk_day, baselines.daily_starting_balance, baselines.high_water_mark, accountId],
            function(updateErr) {
              if (updateErr) return rollback(updateErr);
              Object.assign(account, baselines);
              const breach = getRiskBreach(account, account);
              const commit = () => db.run('COMMIT', (commitErr) => {
                if (commitErr) return callback(commitErr);
                if (!breach) return callback(null, account);
                closeOutstandingCopyTrades(account.wallet_address, (copyErr, copyResults) => {
                  if (copyErr) console.error('Unable to close copied positions after risk rollover:', copyErr.message);
                  else {
                    const failures = copyResults.filter(result => !result.success);
                    if (failures.length) console.error('Some copied positions remained open after risk rollover:', failures);
                  }
                  callback(null, account);
                });
              });
              if (!breach) return commit();
              settleBreachWithinTransaction(account, breach, (lockErr) => {
                if (lockErr) return rollback(lockErr);
                commit();
              });
            }
          );

          if (!account.risk_day) return updateAccount();
          db.run(
            `INSERT OR REPLACE INTO daily_account_summaries
             (account_id, day, opening_balance, closing_balance, profit)
             VALUES (?, ?, ?, ?, ?)`,
            [
              accountId,
              account.risk_day,
              account.daily_starting_balance,
              getRiskBalance(account),
              getRiskBalance(account) - account.daily_starting_balance
            ],
            (summaryErr) => {
              if (summaryErr) return rollback(summaryErr);
              updateAccount();
            }
          );
        });
      });
    });
  });
}

let riskRolloverInProgress = false;
function rolloverAccountsAtUtcDay() {
  if (riskRolloverInProgress) return;
  riskRolloverInProgress = true;
  const today = new Date().toISOString().slice(0, 10);
  db.all(
    'SELECT id FROM accounts WHERE risk_day IS NULL OR risk_day < ? ORDER BY id',
    [today],
    (err, accounts) => {
      if (err) {
        riskRolloverInProgress = false;
        return console.error('Unable to find accounts for daily risk rollover:', err.message);
      }
      const processNext = (index) => {
        if (index >= accounts.length) {
          riskRolloverInProgress = false;
          return;
        }
        refreshRiskBaselines(accounts[index].id, (rolloverErr) => {
          if (rolloverErr) console.error(`Unable to roll risk baselines for account ${accounts[index].id}:`, rolloverErr.message);
          processNext(index + 1);
        });
      };
      processNext(0);
    }
  );
}

setTimeout(rolloverAccountsAtUtcDay, 5000);
setInterval(rolloverAccountsAtUtcDay, 60 * 1000);

let liveRiskCheckInProgress = false;
function checkLiveRiskLimits() {
  if (liveRiskCheckInProgress) return;
  liveRiskCheckInProgress = true;
  db.all(
    `SELECT DISTINCT a.id FROM accounts a
     JOIN trades t ON t.account_id = a.id AND t.status = 'OPEN'
     WHERE (a.status = 'ACTIVE' AND a.permanent_lock = 0)
        OR a.lock_reason IN ('DLL', 'MLL')
     ORDER BY a.id`,
    [],
    (err, accounts) => {
      if (err) {
        liveRiskCheckInProgress = false;
        return console.error('Unable to find accounts with open trades for live risk checks:', err.message);
      }
      const processNext = (index) => {
        if (index >= accounts.length) {
          liveRiskCheckInProgress = false;
          return;
        }
        const accountId = accounts[index].id;
        refreshRiskBaselines(accountId, (baselineErr, account) => {
          if (baselineErr) {
            console.error(`Unable to calculate live risk for account ${accountId}:`, baselineErr.message);
            return processNext(index + 1);
          }
          refreshAccountLock(account, (lockErr) => {
            if (lockErr) console.error(`Unable to apply live risk lock for account ${accountId}:`, lockErr.message);
            processNext(index + 1);
          });
        });
      };
      processNext(0);
    }
  );
}

setTimeout(checkLiveRiskLimits, 2000);
setInterval(checkLiveRiskLimits, 5000);

let pendingLimitOrdersCheckInProgress = false;
function settlePendingLimitOrder(tradeId, marketPrice, quoteToUsdRate, callback) {
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', beginErr => {
      if (beginErr) return callback(beginErr);
      const rollback = error => db.run('ROLLBACK', () => callback(error));
      db.get(
        `SELECT t.*, a.wallet_address, a.current_balance, a.status AS account_status,
         a.admin_frozen,
         COALESCE((SELECT SUM(w.amount) FROM withdrawals w
           WHERE w.account_id = a.id AND w.status = 'PENDING'), 0) AS pending_withdrawal_amount,
         COALESCE((SELECT u.admin_suspended FROM users u
           WHERE LOWER(u.wallet_address) = LOWER(a.wallet_address)), 0) AS admin_suspended
         FROM trades t JOIN accounts a ON a.id = t.account_id
         WHERE t.id = ? AND t.status = 'PENDING'`,
        [tradeId],
        (lookupErr, trade) => {
          if (lookupErr) return rollback(lookupErr);
          if (!trade) return db.run('COMMIT', callback);

          let reservedMargin;
          try {
            reservedMargin = getTradeMargin(trade);
          } catch (marginError) {
            return rollback(marginError);
          }
          const cancel = reason => {
            console.warn(`Canceling pending limit order ${trade.id}: ${reason}`);
            db.run(
              `UPDATE trades SET status = 'CLOSED', pnl = 0, closed_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'PENDING'`,
              [trade.id],
              function(cancelErr) {
                if (cancelErr) return rollback(cancelErr);
                if (this.changes !== 1) return db.run('COMMIT', callback);
                db.run(
                  `UPDATE accounts SET current_balance = COALESCE(current_balance, 0) + ?
                   WHERE id = ?`,
                  [reservedMargin, trade.account_id],
                  refundErr => {
                    if (refundErr) return rollback(refundErr);
                    db.run('COMMIT', callback);
                  }
                );
              }
            );
          };

          const market = getTradeMarket(trade.symbol);
          if (!market || market.enabled === false) return cancel('market is unavailable');
          if (!isLimitOrderTriggered(trade.side, trade.trigger_price, marketPrice)) {
            return db.run('COMMIT', callback);
          }
          if (trade.account_status !== 'ACTIVE' || Number(trade.admin_frozen) === 1 ||
              Number(trade.pending_withdrawal_amount) > 0 || Number(trade.admin_suspended) === 1) {
            return cancel('the account is not eligible to open new positions');
          }

          const executionPrice = Number(marketPrice);
          const leverage = Number(trade.leverage) || 1;
          let margin = reservedMargin;
          let units = Number(trade.units);
          try {
            if (market.asset_class === 'FOREX') {
              const forexSize = calculateForexMargin(
                Number(trade.lot_size),
                executionPrice,
                leverage,
                quoteToUsdRate,
                market.lot_units
              );
              margin = forexSize.marginUsd;
              units = forexSize.units;
            }
            resolveStopTargetPrices({
              executionPrice,
              units,
              side: trade.side,
              mode: 'price',
              sl: trade.sl,
              tp: trade.tp
            });
          } catch (fillError) {
            return cancel(`the market price moved past the order's protective levels (${fillError.message})`);
          }
          if (!Number.isFinite(margin) || margin <= 0 ||
              !Number.isFinite(units) || units <= 0) {
            return cancel('the filled position size is invalid');
          }

          const marginDelta = margin - reservedMargin;
          db.run(
            `UPDATE accounts SET current_balance = current_balance - ?
             WHERE id = ? AND current_balance >= ? AND status = 'ACTIVE' AND admin_frozen = 0
               AND NOT EXISTS (SELECT 1 FROM withdrawals WHERE account_id = ? AND status = 'PENDING')
               AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.wallet_address) = LOWER(accounts.wallet_address)
                               AND COALESCE(u.admin_suspended, 0) = 1)`,
            [marginDelta, trade.account_id, Math.max(0, marginDelta), trade.account_id],
            function(balanceErr) {
              if (balanceErr) return rollback(balanceErr);
              if (this.changes !== 1) return cancel('the account cannot cover the required margin at the trigger price');
              db.run(
                `UPDATE trades SET status = 'OPEN', entry_price = ?, size_usd = ?, units = ?
                 WHERE id = ? AND status = 'PENDING'`,
                [executionPrice, margin, units, trade.id],
                function(fillErr) {
                  if (fillErr) return rollback(fillErr);
                  if (this.changes !== 1) return rollback(new Error('Pending order changed before activation.'));
                  db.run('COMMIT', callback);
                }
              );
            }
          );
        }
      );
    });
  });
}

function checkPendingLimitOrders() {
  if (pendingLimitOrdersCheckInProgress) return;
  pendingLimitOrdersCheckInProgress = true;
  db.all(
    `SELECT id, symbol, side, trigger_price FROM trades
     WHERE status = 'PENDING' AND order_type = 'LIMIT'
     ORDER BY created_at, id`,
    [],
    (err, orders) => {
      if (err) {
        pendingLimitOrdersCheckInProgress = false;
        return console.error('Unable to load pending limit orders:', err.message);
      }
      const marketsBySymbol = new Map();
      for (const order of orders || []) {
        const market = getTradeMarket(order.symbol);
        if (market) marketsBySymbol.set(order.symbol, market);
      }
      Promise.all([...marketsBySymbol].map(async ([symbol, market]) => {
        try {
          const maxQuoteAgeMs = getMarketQuoteMaxAgeMs(market);
          return [symbol, await getAuthoritativePrice(market, maxQuoteAgeMs)];
        } catch (priceError) {
          console.warn(`Unable to check pending ${symbol} limit orders:`, priceError.message);
          return [symbol, null];
        }
      })).then(async priceEntries => {
        const pricesBySymbol = new Map(priceEntries);
        for (const order of orders || []) {
          const market = marketsBySymbol.get(order.symbol);
          const marketPrice = pricesBySymbol.get(order.symbol);
          if (!market || !Number.isFinite(marketPrice) ||
              !isLimitOrderTriggered(order.side, order.trigger_price, marketPrice)) continue;
          try {
            const quoteToUsdRate = await getLiveForexQuoteToUsdRate(
              market,
              market.asset_class === 'FOREX' ? 30000 : 72 * 60 * 60 * 1000
            );
            await new Promise((resolve, reject) => {
              settlePendingLimitOrder(order.id, marketPrice, quoteToUsdRate, error => error ? reject(error) : resolve());
            });
          } catch (activationError) {
            console.error(`Unable to activate pending limit order ${order.id}:`, activationError.message);
          }
        }
      }).catch(processingError => {
        console.error('Unable to process pending limit orders:', processingError.message);
      }).finally(() => {
        pendingLimitOrdersCheckInProgress = false;
      });
    }
  );
}

setTimeout(checkPendingLimitOrders, 2000);
setInterval(checkPendingLimitOrders, 1000);

let dllUnlockSweepInProgress = false;
function unlockExpiredDllAccounts() {
  if (dllUnlockSweepInProgress) return;
  dllUnlockSweepInProgress = true;
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  db.all(
    `SELECT id FROM accounts
     WHERE lock_reason = 'DLL' AND permanent_lock = 0
       AND (locked_until <= ? OR risk_day < ? OR risk_day IS NULL)
     ORDER BY id`,
    [now, today],
    (err, accounts) => {
      if (err) {
        dllUnlockSweepInProgress = false;
        return console.error('Unable to find expired DLL account locks:', err.message);
      }
      const processNext = (index) => {
        if (index >= accounts.length) {
          dllUnlockSweepInProgress = false;
          return;
        }
        const accountId = accounts[index].id;
        refreshRiskBaselines(accountId, (baselineErr, account) => {
          if (baselineErr) {
            console.error(`Unable to refresh expired DLL account ${accountId}:`, baselineErr.message);
            return processNext(index + 1);
          }
          unlockExpiredAccount(account, (unlockErr, activeLock) => {
            if (unlockErr) console.error(`Unable to unlock expired DLL account ${accountId}:`, unlockErr.message);
            if (activeLock) {
              if (account.open_trades?.length) {
                return applyRiskBreach(account, activeLock, (closeErr) => {
                  if (closeErr) console.error(`Unable to close trades for locked account ${accountId}:`, closeErr.message);
                  processNext(index + 1);
                });
              }
              return processNext(index + 1);
            }
            refreshAccountLock(account, (riskErr) => {
              if (riskErr) console.error(`Unable to recheck account ${accountId} after DLL unlock:`, riskErr.message);
              processNext(index + 1);
            });
          });
        });
      };
      processNext(0);
    }
  );
}

setTimeout(unlockExpiredDllAccounts, 2000);
setInterval(unlockExpiredDllAccounts, 5000);

function unlockExpiredAccount(account, callback) {
  const lock = getActiveLock(account);
  if (lock) return callback(null, lock);
  if (account.lock_reason === 'DLL') {
    return db.run(
      `UPDATE accounts SET status = 'ACTIVE', daily_starting_balance = ?,
       lock_reason = NULL, locked_until = NULL
       WHERE id = ? AND permanent_lock = 0`,
      [getRiskBalance(account), account.id],
      (err) => {
        if (!err) {
          account.status = 'ACTIVE';
          account.daily_starting_balance = getRiskBalance(account);
          account.lock_reason = null;
          account.locked_until = null;
        }
        callback(err, null);
      }
    );
  }
  callback(null, null);
}

function refreshAccountLock(account, callback) {
  unlockExpiredAccount(account, (unlockErr, activeLock) => {
    if (unlockErr) return callback(unlockErr);
    if (activeLock) {
      if (!account.open_trades?.length) return callback(null, activeLock);
      return applyRiskBreach(account, activeLock, callback);
    }
    const breach = getRiskBreach(account, account);
    if (!breach) return callback(null, null);
    applyRiskBreach(account, breach, callback);
  });
}

function requireAdminWallet(req, res, next) {
  const wallet = req.body?.wallet_address;
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet)) {
    return res.status(401).json({ error: 'Administrator wallet is required.' });
  }
  db.get(
    "SELECT role FROM admins WHERE LOWER(wallet_address) = LOWER(?)",
    [wallet],
    (err, admin) => {
      if (err) return res.status(500).json({ error: 'Unable to verify administrator role.' });
      if (!admin || !['SUPER_ADMIN', 'ADMIN'].includes(admin.role)) {
        return res.status(403).json({ error: 'Administrator access required.' });
      }
      next();
    }
  );
}

function loadAdminUserSecurity(wallet, callback) {
  db.get(
    `SELECT wallet_address, username, admin_suspended, admin_suspend_reason,
            admin_suspended_by, admin_suspended_at
     FROM users WHERE LOWER(wallet_address) = LOWER(?)`,
    [wallet],
    (userErr, user) => {
      if (userErr) return callback(userErr);
      if (!user) return callback(new Error('User not found.'));
      db.all(
        `SELECT ip_address, is_new_ip, created_at
         FROM user_login_ip_events
         WHERE LOWER(wallet_address) = LOWER(?) AND created_at >= datetime('now', '-180 days')
         ORDER BY created_at DESC LIMIT 20`,
        [wallet],
        (loginErr, loginIps) => {
          if (loginErr) return callback(loginErr);
          db.all(
            `SELECT admin_wallet, action, reason, created_at
             FROM user_admin_actions WHERE LOWER(wallet_address) = LOWER(?)
             ORDER BY created_at DESC LIMIT 20`,
            [wallet],
            (actionErr, adminActions) => {
              if (actionErr) return callback(actionErr);
              callback(null, { user, login_ips: loginIps || [], admin_actions: adminActions || [] });
            }
          );
        }
      );
    }
  );
}

function getBattlePassLevel(xp) {
  return Math.min(12, Math.floor(Math.max(0, Number(xp) || 0) / 10000));
}

function getBattlePassPeriodKey(cadence, date = new Date()) {
  if (cadence === 'ONCE') return 'ONCE';
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  if (cadence === 'DAILY') return `${year}-${month}-${day}`;
  if (cadence === 'MONTHLY') return `${year}-${month}`;
  const monday = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
}

function getBattlePassPeriodEnd(cadence, periodKey) {
  const [year, month, day] = periodKey.split('-').map(Number);
  const end = cadence === 'MONTHLY'
    ? new Date(Date.UTC(year, month, 1))
    : new Date(Date.UTC(year, month - 1, day + (cadence === 'WEEKLY' ? 7 : 1)));
  return end.toISOString().slice(0, 10);
}

function getBattlePassTaskPeriod(task, date = new Date()) {
  const claimPeriodKey = getBattlePassPeriodKey(task.cadence, date);
  if (task.task_type !== 'GREEN_DAY' && task.task_type !== 'GREEN_WEEK') {
    return { claimPeriodKey, activityPeriodKey: claimPeriodKey };
  }
  const activityStart = new Date(`${claimPeriodKey}T00:00:00.000Z`);
  activityStart.setUTCDate(activityStart.getUTCDate() - (task.task_type === 'GREEN_DAY' ? 1 : 7));
  const activityPeriodKey = activityStart.toISOString().slice(0, 10);
  return { claimPeriodKey, activityPeriodKey };
}

function getBattlePassTaskEligibility(task, wallet, periodKey, callback) {
  if (task.task_type === 'SOCIAL_CLICK') return callback(null, true);
  const periodEnd = getBattlePassPeriodEnd(task.cadence, periodKey);
  if (task.task_type === 'JOURNAL_DAY' || task.task_type === 'JOURNAL_WEEK') {
    if ((task.task_type === 'JOURNAL_DAY' && task.cadence !== 'DAILY') ||
        (task.task_type === 'JOURNAL_WEEK' && task.cadence !== 'WEEKLY')) {
      return callback(new Error('This journal task has an invalid completion schedule.'));
    }
    const target = task.task_type === 'JOURNAL_DAY' ? 1 : 5;
    return db.get(
      `SELECT COUNT(DISTINCT j.day) AS completed
       FROM account_trade_journals j
       JOIN accounts a ON a.id = j.account_id
       WHERE LOWER(a.wallet_address) = LOWER(?)
         AND j.day >= ? AND j.day < ?`,
      [wallet, periodKey, periodEnd],
      (err, row) => {
        if (err) return callback(new Error('Unable to verify journal activity for this task.'));
        const completed = Math.min(target, Number(row?.completed || 0));
        task.progress = completed;
        task.progress_target = target;
        callback(null, completed >= target);
      }
    );
  }
  if (task.task_type === 'GREEN_DAY' || task.task_type === 'GREEN_WEEK') {
    const startComparison = task.task_type === 'GREEN_DAY' ? '= ?' : '>= ? AND d.day < ?';
    const params = task.task_type === 'GREEN_DAY'
      ? [wallet, periodKey]
      : [wallet, periodKey, periodEnd];
    return db.get(
      `SELECT COALESCE(SUM(d.profit), 0) AS profit
       FROM daily_account_summaries d
       JOIN accounts a ON a.id = d.account_id
       WHERE LOWER(a.wallet_address) = LOWER(?) AND d.day ${startComparison}`,
      params,
      (err, row) => err
        ? callback(new Error('Unable to verify trading activity for this task.'))
        : callback(null, Number(row?.profit || 0) > 0)
    );
  }
  if (task.task_type === 'WITHDRAWAL') {
    return db.get(
      `SELECT EXISTS(
         SELECT 1 FROM withdrawals w
         WHERE LOWER(w.wallet_address) = LOWER(?) AND w.status = 'PAID'
           AND date(COALESCE(w.paid_at, w.created_at)) >= date(?) AND date(COALESCE(w.paid_at, w.created_at)) < date(?)
         UNION ALL
         SELECT 1 FROM referral_withdrawals rw
         WHERE LOWER(rw.wallet_address) = LOWER(?) AND rw.status = 'PAID'
           AND date(COALESCE(rw.paid_at, rw.created_at)) >= date(?) AND date(COALESCE(rw.paid_at, rw.created_at)) < date(?)
       ) AS eligible`,
      [wallet, periodKey, periodEnd, wallet, periodKey, periodEnd],
      (err, row) => err
        ? callback(new Error('Unable to verify withdrawal activity for this task.'))
        : callback(null, Number(row?.eligible) === 1)
    );
  }
  if (task.task_type === 'TRADE_DAY') {
    return db.get(
      `SELECT EXISTS(
         SELECT 1 FROM trades t
         JOIN accounts a ON a.id = t.account_id
         WHERE LOWER(a.wallet_address) = LOWER(?) AND t.status = 'CLOSED'
           AND date(t.closed_at) >= date(?) AND date(t.closed_at) < date(?)
       ) AS eligible`,
      [wallet, periodKey, periodEnd],
      (err, row) => err
        ? callback(new Error('Unable to verify trading activity for this task.'))
        : callback(null, Number(row?.eligible) === 1)
    );
  }
  callback(new Error('This battle pass task has an unsupported task type.'));
}

// --- ON-CHAIN SECURE VERIFICATION FUNCTION ---
async function verifyMultiChainPurchase(txHash, chainId, expectedBuyerWallet, expectedAmountUsdt, treasuryWallet) {
    const chainConfig = SUPPORTED_EVM_CHAINS[chainId];
    if (!chainConfig) {
        return { success: false, error: "Unsupported blockchain network." };
    }

    try {
        const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
        const tx = await provider.getTransaction(txHash);
        const receipt = await provider.getTransactionReceipt(txHash);

        if (!tx || !receipt || receipt.status !== 1) {
            return { success: false, error: "Transaction not found or failed on-chain." };
        }

        // SECURITY CHECK: Mempool Snipe Protection (tx.from must match buyer)
        if (tx.from.toLowerCase() !== expectedBuyerWallet.toLowerCase()) {
            return { success: false, error: "Security Alert: Transaction sender does not match connected wallet." };
        }

        // Verify ERC-20 Transfer Event logs
        const transferTopic = ethers.id("Transfer(address,address,uint256)");
        let validTransfer = false;

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === chainConfig.usdtAddress.toLowerCase() && log.topics[0] === transferTopic) {
                const recipient = ethers.getAddress('0x' + log.topics[2].slice(26));
                const rawValue = BigInt(log.data);
                const expectedRawValue = ethers.parseUnits(Number(expectedAmountUsdt).toFixed(2), chainConfig.decimals);

                if (recipient.toLowerCase() === treasuryWallet.toLowerCase() && rawValue >= expectedRawValue) {
                    validTransfer = true;
                    break;
                }
            }
        }

        if (!validTransfer) {
            return { success: false, error: "Transaction logs do not show a valid USDT transfer to the treasury." };
        }

        return { success: true };
    } catch (err) {
        console.error("Multi-chain verification error:", err);
        return { success: false, error: "On-chain verification lookup failed." };
    }
}

// --- API ROUTES ---

app.post('/api/auth/trade-challenge', sensitiveLimiter, challengeLimiter, (req, res) => {
  const wallet = req.body?.wallet_address;
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: 'A valid wallet address is required.' });
  }

  const key = wallet.toLowerCase();
  const now = Date.now();
  for (const [challengeWallet, challenge] of tradeChallenges) {
    if (challenge.expiresAt <= now) tradeChallenges.delete(challengeWallet);
  }
  if (tradeChallenges.size >= 5000) {
    return res.status(503).json({ error: 'Wallet authorization is temporarily unavailable.' });
  }

  const nonce = crypto.randomBytes(24).toString('hex');
  const expiresAt = now + 2 * 60 * 1000;
  const message = `Blastrr trade authorization\nWallet: ${key}\nNonce: ${nonce}\nExpires: ${expiresAt}`;
  tradeChallenges.set(message, { message, walletAddress: key, expiresAt });
  res.json({ challenge: message });
});

app.post('/api/auth/wallet-session', sensitiveLimiter, requireTradeSignature, walletSessionLimiter, (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + WALLET_SESSION_DURATION_MS;
  const wallet = req.body.wallet_address.toLowerCase();
  const ipAddress = req.ip || 'unknown';
  recordWalletLogin(wallet, ipAddress, (loginErr, login) => {
    if (loginErr) {
      console.error('Unable to record wallet login IP:', loginErr.message);
      return res.status(500).json({ error: 'Unable to record login security details.' });
    }
    registerWalletSession(db, { token, walletAddress: wallet, ipAddress, expiresAt }, (sessionErr, session) => {
      if (sessionErr) {
        if (sessionErr.code === 'SESSION_CAPACITY') {
          return res.status(503).json({ error: 'Wallet sessions are temporarily unavailable.' });
        }
        console.error('Unable to persist wallet session:', sessionErr.message);
        return res.status(500).json({ error: 'Unable to establish a wallet session.' });
      }
      if (session.softLocked) disconnectMarketDataStreams(wallet);
      res.json({
        token,
        expires_at: expiresAt,
        new_ip: login.isNewIp,
        wallet_soft_locked: session.softLocked
      });
    });
  });
});

app.post('/api/auth/wallet-session/reauthorize', sensitiveLimiter, requireWalletSession, requireSameWalletReauthentication, walletSessionLimiter, (req, res) => {
  markWalletSessionReauthenticated(db, req.walletSessionTokenHash, req.walletAddress, (err, status) => {
    if (err?.code === 'SESSION_INVALID') return res.status(401).json({ error: 'A valid wallet session is required.' });
    if (err) {
      console.error('Unable to reauthorize wallet session:', err.message);
      return res.status(500).json({ error: 'Unable to reauthorize wallet session.' });
    }
    if (status.softLocked) disconnectMarketDataStreams(req.walletAddress);
    res.json({
      wallet_soft_locked: status.softLocked,
      reauthentication_required: status.reauthenticationRequired,
      active_session_count: status.activeSessionCount || 0,
      reauthenticated_session_count: status.reauthenticatedSessionCount || 0
    });
  });
});

app.get('/api/user/security-status', requireWalletSession, (req, res) => {
  getWalletSecurityStatus(db, req.walletAddress, req.walletSessionTokenHash, (err, status) => {
    if (err) return res.status(500).json({ error: 'Unable to load wallet security status.' });
    if (status.softLocked) res.set('X-Wallet-Soft-Locked', 'true');
    res.json({
      wallet_soft_locked: status.softLocked,
      locked_at: status.lock?.locked_at || null,
      reauthentication_required: status.reauthenticationRequired,
      active_session_count: status.activeSessionCount || 0,
      reauthenticated_session_count: status.reauthenticatedSessionCount || 0
    });
  });
});

app.get('/api/user/disclaimer-consent', requireWalletSession, (req, res) => {
  db.get(
    'SELECT version FROM wallet_disclaimer_acceptances WHERE LOWER(wallet_address) = LOWER(?) AND version = ?',
    [req.walletAddress, DISCLAIMER_VERSION],
    (err, acceptance) => {
      if (err) return res.status(500).json({ error: 'Unable to load disclaimer acceptance.' });
      res.json({ accepted: Boolean(acceptance), version: DISCLAIMER_VERSION });
    }
  );
});

app.post('/api/user/disclaimer-consent', sensitiveLimiter, requireWalletSession, (req, res) => {
  if (req.body?.version !== DISCLAIMER_VERSION ||
      req.body?.accepted_terms !== true ||
      req.body?.simulated_funds !== true) {
    return res.status(400).json({ error: 'Confirm both required acknowledgements to continue.' });
  }
  db.run(
    `INSERT INTO wallet_disclaimer_acceptances (wallet_address, version)
     VALUES (?, ?)
     ON CONFLICT(wallet_address, version) DO UPDATE SET accepted_at = CURRENT_TIMESTAMP`,
    [req.walletAddress.toLowerCase(), DISCLAIMER_VERSION],
    (err) => {
      if (err) return res.status(500).json({ error: 'Unable to remember disclaimer acceptance.' });
      res.json({ success: true, version: DISCLAIMER_VERSION });
    }
  );
});

app.get('/api/plans', (req, res) => {
  db.get('SELECT standard_discount_pct FROM battlepass_settings WHERE id = 1', [], (settingsErr, settings) => {
    if (settingsErr) return res.status(500).json({ error: 'Unable to load current purchase discounts.' });
    const discountPct = Number(settings?.standard_discount_pct ?? 90);
    db.all("SELECT * FROM plans WHERE active = 1 ORDER BY id", [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        plans: rows,
        standard_discount_pct: discountPct
      });
    });
  });
});

app.post('/api/admin/plans/list', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.get('SELECT standard_discount_pct FROM battlepass_settings WHERE id = 1', [], (settingsErr, settings) => {
    if (settingsErr) return res.status(500).json({ error: 'Unable to load the standard discount.' });
    const discountPct = Number(settings?.standard_discount_pct ?? 90);
    db.all('SELECT * FROM plans ORDER BY active DESC, id', [], (err, plans) => {
      if (err) return res.status(500).json({ error: 'Unable to load account plans.' });
      res.json({ plans: plans || [], standard_discount_pct: discountPct });
    });
  });
});

app.post('/api/admin/plans/save', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const planId = body.plan_id == null ? null : Number(body.plan_id);
  const active = body.active === true || body.active === 1 ? 1
    : body.active === false || body.active === 0 ? 0 : null;
  const fields = {
    base_price_usdt: Number(body.base_price_usdt),
    simulated_capital: Number(body.simulated_capital),
    profit_target: Number(body.profit_target),
    max_drawdown_pct: Number(body.max_drawdown_pct),
    daily_loss_pct: Number(body.daily_loss_pct),
    max_single_day_profit_pct: Number(body.max_single_day_profit_pct)
  };
  const values = Object.values(fields);
  if (name.length < 3 || name.length > 100 ||
      (planId !== null && (!Number.isInteger(planId) || planId < 1)) ||
      active === null ||
      values.some(value => !Number.isFinite(value)) ||
      fields.base_price_usdt <= 0 ||
      fields.simulated_capital <= 0 ||
      fields.profit_target < 0 ||
      fields.max_drawdown_pct < 0 || fields.max_drawdown_pct > 100 ||
      fields.daily_loss_pct < 0 || fields.daily_loss_pct > 100 ||
      fields.max_single_day_profit_pct < 0 || fields.max_single_day_profit_pct > 100) {
    return res.status(400).json({ error: 'Enter a plan name, valid prices and capital, and valid risk percentages from 0 to 100.' });
  }
  db.get('SELECT standard_discount_pct FROM battlepass_settings WHERE id = 1', [], (settingsErr, settings) => {
    if (settingsErr) return res.status(500).json({ error: 'Unable to load the standard discount.' });
    const discountPct = Math.max(0, Math.min(100, Number(settings?.standard_discount_pct ?? 90)));
    const salePrice = Math.round(fields.base_price_usdt * (100 - discountPct)) / 100;
    db.get(
      `SELECT id FROM plans WHERE name = ? COLLATE NOCASE AND (? IS NULL OR id != ?) LIMIT 1`,
      [name, planId, planId],
      (duplicateErr, duplicate) => {
        if (duplicateErr) return res.status(500).json({ error: 'Unable to check for duplicate plan names.' });
        if (duplicate) return res.status(409).json({ error: 'A plan with that name already exists.' });
        const valuesWithSalePrice = [
          fields.base_price_usdt,
          salePrice,
          fields.simulated_capital,
          fields.profit_target,
          fields.max_drawdown_pct,
          fields.daily_loss_pct,
          fields.max_single_day_profit_pct
        ];
        if (planId === null) {
          return db.run(
            `INSERT INTO plans (name, base_price_usdt, price_usdt, simulated_capital, profit_target,
             max_drawdown_pct, daily_loss_pct, max_single_day_profit_pct, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, ...valuesWithSalePrice, active],
            function(insertErr) {
              if (insertErr) return res.status(500).json({ error: 'Unable to create the account plan.' });
              const insertedPlanId = this.lastID;
              db.run(
                'INSERT OR IGNORE INTO battlepass_plan_rewards (plan_id, xp_reward, points_reward) VALUES (?, 1000, 100)',
                [insertedPlanId],
                rewardErr => {
                  if (rewardErr) return res.status(500).json({ error: 'Plan was created but its battle pass rewards could not be initialized.' });
                  res.status(201).json({ success: true, plan_id: insertedPlanId });
                }
              );
            }
          );
        }
        db.run(
          `UPDATE plans SET name = ?, base_price_usdt = ?, price_usdt = ?, simulated_capital = ?,
           profit_target = ?, max_drawdown_pct = ?, daily_loss_pct = ?, max_single_day_profit_pct = ?, active = ?
           WHERE id = ?`,
          [name, ...valuesWithSalePrice, active, planId],
          function(updateErr) {
            if (updateErr) return res.status(500).json({ error: 'Unable to update the account plan.' });
            if (this.changes !== 1) return res.status(404).json({ error: 'Account plan not found.' });
            res.json({ success: true, plan_id: planId });
          }
        );
      }
    );
  });
});

app.post('/api/admin/battlepass/load', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.get('SELECT standard_discount_pct FROM battlepass_settings WHERE id = 1', [], (settingsErr, settings) => {
    if (settingsErr || !settings) return res.status(500).json({ error: 'Unable to load battle pass settings.' });
    db.all('SELECT level, xp_required, discount_bonus_pct, points_cost FROM battlepass_levels ORDER BY level', [], (levelsErr, levels) => {
      if (levelsErr) return res.status(500).json({ error: 'Unable to load battle pass levels.' });
      db.all(
        `SELECT p.id AS plan_id, p.name, p.simulated_capital,
                COALESCE(r.xp_reward, 1000) AS xp_reward,
                COALESCE(r.points_reward, 100) AS points_reward
         FROM plans p LEFT JOIN battlepass_plan_rewards r ON r.plan_id = p.id
         WHERE p.active = 1 ORDER BY p.id`,
        [],
        (plansErr, plans) => {
          if (plansErr) return res.status(500).json({ error: 'Unable to load plan battle pass rewards.' });
          db.all('SELECT * FROM battlepass_tasks ORDER BY active DESC, cadence, id', [], (tasksErr, tasks) => {
            if (tasksErr) return res.status(500).json({ error: 'Unable to load battle pass tasks.' });
            res.json({ settings, levels: levels || [], plans: plans || [], tasks: tasks || [] });
          });
        }
      );
    });
  });
});

app.get('/api/battlepass', requireWalletSession, (req, res) => {
  const wallet = req.query.wallet;
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet) || wallet.toLowerCase() !== req.walletAddress) {
    return res.status(403).json({ error: 'Wallet session does not match the requested battle pass.' });
  }
  db.run(
    'INSERT OR IGNORE INTO battlepass_users (wallet_address) VALUES (?)',
    [req.walletAddress],
    (insertErr) => {
      if (insertErr) return res.status(500).json({ error: 'Unable to prepare your battle pass profile.' });
      db.get(
        `SELECT b.wallet_address, b.xp, b.points, b.profile_image_url, u.username
         FROM battlepass_users b LEFT JOIN users u ON LOWER(u.wallet_address) = LOWER(b.wallet_address)
         WHERE LOWER(b.wallet_address) = LOWER(?)`,
        [req.walletAddress],
        (profileErr, profile) => {
          if (profileErr || !profile) return res.status(500).json({ error: 'Unable to load your battle pass profile.' });
          const currentLevel = getBattlePassLevel(profile.xp);
          db.all('SELECT * FROM battlepass_levels ORDER BY level', [], (levelsErr, levels) => {
            if (levelsErr) return res.status(500).json({ error: 'Unable to load battle pass levels.' });
            db.all(
              'SELECT level, code, discount_bonus_pct, redeemed_at FROM battlepass_reward_codes WHERE LOWER(wallet_address) = LOWER(?)',
              [req.walletAddress],
              (rewardsErr, rewards) => {
              if (rewardsErr) return res.status(500).json({ error: 'Unable to load your battle pass rewards.' });
              const rewardByLevel = new Map((rewards || []).map(reward => [Number(reward.level), reward]));
              db.all(
                `SELECT t.*,
                        (SELECT c.period_key FROM battlepass_task_claims c
                         WHERE c.task_id = t.id AND LOWER(c.wallet_address) = LOWER(?)
                           AND c.cadence = t.cadence
                         ORDER BY c.created_at DESC LIMIT 1) AS last_period_key,
                        EXISTS (SELECT 1 FROM battlepass_events e
                                WHERE e.event_type = 'PLATFORM_REVIEW'
                                  AND LOWER(e.wallet_address) = LOWER(?)) AS review_completed
                 FROM battlepass_tasks t WHERE t.active = 1
                 ORDER BY CASE t.cadence WHEN 'DAILY' THEN 1 WHEN 'WEEKLY' THEN 2 WHEN 'MONTHLY' THEN 3 ELSE 4 END, t.id`,
                [req.walletAddress, req.walletAddress],
                (tasksErr, tasks) => {
                  if (tasksErr) return res.status(500).json({ error: 'Unable to load battle pass tasks.' });
                  for (const task of tasks || []) {
                    const taskPeriod = getBattlePassTaskPeriod(task);
                    task.claimed = task.task_type === 'PLATFORM_REVIEW'
                      ? Number(task.review_completed) === 1
                      : task.last_period_key === taskPeriod.claimPeriodKey;
                    delete task.last_period_key;
                    delete task.review_completed;
                  }
                  const eligibleTasks = tasks || [];
                  let taskIndex = 0;
                  const checkTaskEligibility = () => {
                    if (taskIndex >= eligibleTasks.length) {
                      return res.json({
                        profile: {
                          ...profile,
                          xp: Number(profile.xp),
                          points: Number(profile.points),
                          level: currentLevel
                        },
                        levels: (levels || []).map(level => ({
                          ...level,
                          reward_code: rewardByLevel.get(Number(level.level))?.code || null,
                          reward_redeemed: Boolean(rewardByLevel.get(Number(level.level))?.redeemed_at),
                          unlocked: currentLevel >= Number(level.level)
                        })),
                        tasks: eligibleTasks
                      });
                    }
                    const task = eligibleTasks[taskIndex++];
                    const period = getBattlePassTaskPeriod(task);
                    if (task.claimed) {
                      task.eligible = false;
                      if (task.task_type === 'JOURNAL_DAY' || task.task_type === 'JOURNAL_WEEK') {
                        const period = getBattlePassTaskPeriod(task);
                        return getBattlePassTaskEligibility(task, req.walletAddress, period.activityPeriodKey, (eligibilityErr) => {
                          if (eligibilityErr) return res.status(500).json({ error: eligibilityErr.message });
                          checkTaskEligibility();
                        });
                      }
                      return checkTaskEligibility();
                    }
                    if (task.task_type === 'PLATFORM_REVIEW') {
                      task.eligible = false;
                      return checkTaskEligibility();
                    }
                    getBattlePassTaskEligibility(task, req.walletAddress, period.activityPeriodKey, (eligibilityErr, eligible) => {
                      if (eligibilityErr) return res.status(500).json({ error: eligibilityErr.message });
                      task.eligible = eligible;
                      checkTaskEligibility();
                    });
                  };
                  checkTaskEligibility();
                }
              );
            });
          });
        }
      );
    }
  );
});

app.get('/api/battlepass/profile', (req, res) => {
  const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  if (!/^[a-z0-9_]{3,24}$/i.test(username)) {
    return res.status(400).json({ error: 'A valid battle pass username is required.' });
  }
  db.get(
    `SELECT u.username, b.xp, b.profile_image_url
     FROM users u LEFT JOIN battlepass_users b ON LOWER(b.wallet_address) = LOWER(u.wallet_address)
     WHERE LOWER(u.username) = LOWER(?)`,
    [username],
    (err, profile) => {
      if (err) return res.status(500).json({ error: 'Unable to load this public battle pass profile.' });
      if (!profile) return res.status(404).json({ error: 'Battle pass profile not found.' });
      const xp = Number(profile.xp || 0);
      res.json({
        profile: {
          username: profile.username,
          xp,
            level: getBattlePassLevel(xp),
            profile_image_url: profile.profile_image_url
          }
      });
    }
  );
});

app.post('/api/battlepass/profile', sensitiveLimiter, requireWalletSession, (req, res) => {
  const imageUrl = typeof req.body?.profile_image_url === 'string' ? req.body.profile_image_url.trim() : '';
  if (imageUrl.length > 2048) return res.status(400).json({ error: 'Profile image URL must be 2,048 characters or fewer.' });
  if (imageUrl) {
    try {
      const parsed = new URL(imageUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported profile image URL scheme.');
    } catch {
      return res.status(400).json({ error: 'Enter a valid HTTP or HTTPS profile image URL.' });
    }
  }
  db.run(
    `INSERT INTO battlepass_users (wallet_address, profile_image_url)
     VALUES (?, ?)
     ON CONFLICT(wallet_address) DO UPDATE SET profile_image_url = excluded.profile_image_url,
       updated_at = CURRENT_TIMESTAMP`,
    [req.walletAddress, imageUrl || null],
    (err) => {
      if (err) return res.status(500).json({ error: 'Unable to update your battle pass profile.' });
      res.json({ success: true, profile_image_url: imageUrl || null });
    }
  );
});

app.post('/api/battlepass/tasks/claim', sensitiveLimiter, requireWalletSession, (req, res) => {
  const taskId = Number(req.body?.task_id);
  if (!Number.isInteger(taskId) || taskId <= 0) return res.status(400).json({ error: 'Choose a valid battle pass task.' });
  db.get('SELECT id, task_type, cadence, xp_reward, points_reward FROM battlepass_tasks WHERE id = ? AND active = 1', [taskId], (taskErr, task) => {
    if (taskErr) return res.status(500).json({ error: 'Unable to load this battle pass task.' });
    if (!task) return res.status(404).json({ error: 'This battle pass task is no longer available.' });
    if ((task.task_type === 'GREEN_DAY' && task.cadence !== 'DAILY') ||
        (task.task_type === 'GREEN_WEEK' && task.cadence !== 'WEEKLY') ||
        (task.task_type === 'JOURNAL_DAY' && task.cadence !== 'DAILY') ||
        (task.task_type === 'JOURNAL_WEEK' && task.cadence !== 'WEEKLY')) {
      return res.status(409).json({ error: 'This task has an invalid completion schedule.' });
    }
    const taskPeriod = getBattlePassTaskPeriod(task);
    const periodKey = taskPeriod.claimPeriodKey;
    getBattlePassTaskEligibility(task, req.walletAddress, taskPeriod.activityPeriodKey, (eligibilityErr, eligible) => {
      if (eligibilityErr) return res.status(500).json({ error: eligibilityErr.message });
      if (!eligible) return res.status(409).json({ error: 'This task reward is not available yet.' });
    const claimId = `bpt_${crypto.randomBytes(10).toString('hex')}`;
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', (beginErr) => {
        if (beginErr) return res.status(500).json({ error: 'Unable to start task reward.' });
        const rollback = (status, error) => db.run('ROLLBACK', () => res.status(status).json({ error }));
        db.run(
          `INSERT INTO battlepass_task_claims (id, wallet_address, task_id, cadence, period_key)
           VALUES (?, ?, ?, ?, ?)`,
          [claimId, req.walletAddress, task.id, task.cadence, periodKey],
          (claimErr) => {
            if (claimErr) {
              if (claimErr.code === 'SQLITE_CONSTRAINT') return rollback(409, 'You have already earned this task reward for the current period.');
              return rollback(500, 'Unable to record this task reward.');
            }
            db.run('INSERT OR IGNORE INTO battlepass_users (wallet_address) VALUES (?)', [req.walletAddress], (userErr) => {
              if (userErr) return rollback(500, 'Unable to load your battle pass balance.');
              db.run(
                `UPDATE battlepass_users SET xp = xp + ?, points = points + ?, updated_at = CURRENT_TIMESTAMP
                 WHERE LOWER(wallet_address) = LOWER(?)`,
                [task.xp_reward, task.points_reward, req.walletAddress],
                (balanceErr) => {
                  if (balanceErr) return rollback(500, 'Unable to add your task reward.');
                  db.run(
                    `INSERT INTO battlepass_events (id, wallet_address, event_type, reference_id, xp, points)
                     VALUES (?, ?, 'TASK', ?, ?, ?)`,
                    [`bpe_${crypto.randomBytes(10).toString('hex')}`, req.walletAddress, `${req.walletAddress}:${task.id}:${periodKey}`, task.xp_reward, task.points_reward],
                    (eventErr) => {
                      if (eventErr) return rollback(500, 'Unable to record your task reward history.');
                      db.run('COMMIT', (commitErr) => {
                        if (commitErr) return rollback(500, 'Unable to complete task reward.');
                        res.json({
                          success: true,
                          xp_awarded: task.xp_reward,
                          points_awarded: task.points_reward,
                          period_key: periodKey
                        });
                      });
                    }
                  );
                }
              );
            });
          }
        );
      });
    });
    });
  });
});

app.post('/api/battlepass/rewards/claim', sensitiveLimiter, requireWalletSession, (req, res) => {
  const level = Number(req.body?.level);
  if (!Number.isInteger(level) || level < 1 || level > 12) {
    return res.status(400).json({ error: 'Choose a valid battle pass level reward.' });
  }
  db.get('SELECT xp, points FROM battlepass_users WHERE LOWER(wallet_address) = LOWER(?)', [req.walletAddress], (userErr, user) => {
    if (userErr) return res.status(500).json({ error: 'Unable to load your battle pass balance.' });
    if (!user) return res.status(404).json({ error: 'Battle pass profile not found.' });
    if (getBattlePassLevel(user.xp) < level) return res.status(403).json({ error: 'Earn more XP to unlock this level reward.' });
    db.get('SELECT * FROM battlepass_levels WHERE level = ?', [level], (levelErr, reward) => {
      if (levelErr) return res.status(500).json({ error: 'Unable to load this level reward.' });
      if (!reward) return res.status(404).json({ error: 'Battle pass level not found.' });
      if (Number(user.points) < Number(reward.points_cost)) {
        return res.status(400).json({ error: `You need ${reward.points_cost} points to claim this level reward.` });
      }
      const code = `PASS-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
      db.serialize(() => {
        db.run('BEGIN IMMEDIATE', (beginErr) => {
          if (beginErr) return res.status(500).json({ error: 'Unable to start level reward claim.' });
          const rollback = (status, error) => db.run('ROLLBACK', () => res.status(status).json({ error }));
          db.run(
            `INSERT INTO battlepass_reward_codes (code, wallet_address, level, discount_bonus_pct)
             VALUES (?, ?, ?, ?)`,
            [code, req.walletAddress, level, reward.discount_bonus_pct],
            (insertErr) => {
              if (insertErr) {
                if (insertErr.code === 'SQLITE_CONSTRAINT') return rollback(409, 'This level reward has already been claimed.');
                return rollback(500, 'Unable to create your level discount code.');
              }
              db.run(
                `UPDATE battlepass_users SET points = points - ?, updated_at = CURRENT_TIMESTAMP
                 WHERE LOWER(wallet_address) = LOWER(?) AND points >= ?`,
                [reward.points_cost, req.walletAddress, reward.points_cost],
                function(updateErr) {
                  if (updateErr) return rollback(500, 'Unable to deduct reward points.');
                  if (this.changes !== 1) return rollback(409, 'Your points changed; refresh and try again.');
                  db.run(
                    `INSERT INTO battlepass_events (id, wallet_address, event_type, reference_id, xp, points)
                     VALUES (?, ?, 'LEVEL_REWARD', ?, 0, ?)`,
                    [`bpe_${crypto.randomBytes(10).toString('hex')}`, req.walletAddress, `${req.walletAddress}:level:${level}`, -Number(reward.points_cost)],
                    (eventErr) => {
                      if (eventErr) return rollback(500, 'Unable to record your level reward claim.');
                      db.run('COMMIT', (commitErr) => {
                        if (commitErr) return rollback(500, 'Unable to complete level reward claim.');
                        res.json({ success: true, code, discount_bonus_pct: Number(reward.discount_bonus_pct) });
                      });
                    }
                  );
                }
              );
            }
          );
        });
      });
    });
  });
});

app.get('/api/auth/role', (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet) return res.json({ isAdmin: false });

  db.get("SELECT * FROM admins WHERE LOWER(wallet_address) = LOWER(?)", [wallet], (err, admin) => {
    res.json({ isAdmin: !!admin });
  });
});

app.get('/api/leaderboard', (req, res) => {
  const mode = req.query.mode || 'DAILY';
  const requestedLimit = req.query.limit == null ? 100 : Number(req.query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return res.status(400).json({ error: 'Leaderboard limit must be an integer from 1 to 100.' });
  }
  const limit = requestedLimit;
  let query = '';

  if (mode === 'DAILY') {
    query = `
      SELECT u.username, u.discount_code, u.wallet_address, b.profile_image_url, COALESCE(b.xp, 0) AS battlepass_xp, SUM(t.pnl) as metric_value
      FROM users u
      LEFT JOIN battlepass_users b ON LOWER(b.wallet_address) = LOWER(u.wallet_address)
      JOIN accounts a ON LOWER(u.wallet_address) = LOWER(a.wallet_address)
      JOIN trades t ON a.id = t.account_id
      WHERE t.status = 'CLOSED' AND u.username IS NOT NULL AND COALESCE(u.leaderboard_hidden, 0) = 0
        AND strftime('%Y-%m-%d', t.closed_at) = strftime('%Y-%m-%d', 'now')
        AND EXISTS (SELECT 1 FROM accounts positive_account WHERE LOWER(positive_account.wallet_address) = LOWER(u.wallet_address)
                    AND positive_account.status = 'ACTIVE' AND COALESCE(positive_account.current_balance, 0) > 0)
      GROUP BY u.wallet_address
      ORDER BY metric_value DESC
      LIMIT ${limit};
    `;
  } else if (mode === 'MONTHLY') {
    query = `
      SELECT u.username, u.discount_code, u.wallet_address, b.profile_image_url, COALESCE(b.xp, 0) AS battlepass_xp, SUM(t.pnl) as metric_value
      FROM users u
      LEFT JOIN battlepass_users b ON LOWER(b.wallet_address) = LOWER(u.wallet_address)
      JOIN accounts a ON LOWER(u.wallet_address) = LOWER(a.wallet_address)
      JOIN trades t ON a.id = t.account_id
      WHERE t.status = 'CLOSED' AND u.username IS NOT NULL AND COALESCE(u.leaderboard_hidden, 0) = 0
        AND strftime('%Y-%m', t.closed_at) = strftime('%Y-%m', 'now')
        AND EXISTS (SELECT 1 FROM accounts positive_account WHERE LOWER(positive_account.wallet_address) = LOWER(u.wallet_address)
                    AND positive_account.status = 'ACTIVE' AND COALESCE(positive_account.current_balance, 0) > 0)
      GROUP BY u.wallet_address
      ORDER BY metric_value DESC
      LIMIT ${limit};
    `;
  } else if (mode === 'PAYOUTS') {
    query = `
      SELECT u.username, u.discount_code, u.wallet_address, b.profile_image_url, COALESCE(b.xp, 0) AS battlepass_xp, SUM(w.amount) as metric_value
      FROM users u
      LEFT JOIN battlepass_users b ON LOWER(b.wallet_address) = LOWER(u.wallet_address)
      JOIN (
        SELECT wallet_address, amount FROM withdrawals WHERE status = 'PAID'
        UNION ALL
        SELECT wallet_address, amount FROM referral_withdrawals WHERE status = 'PAID'
      ) w ON LOWER(u.wallet_address) = LOWER(w.wallet_address)
      WHERE u.username IS NOT NULL AND COALESCE(u.leaderboard_hidden, 0) = 0
        AND EXISTS (SELECT 1 FROM accounts positive_account WHERE LOWER(positive_account.wallet_address) = LOWER(u.wallet_address)
                    AND positive_account.status = 'ACTIVE' AND COALESCE(positive_account.current_balance, 0) > 0)
      GROUP BY u.wallet_address
      ORDER BY metric_value DESC
      LIMIT ${limit};
    `;
  } else {
    return res.status(400).json({ error: "Invalid leaderboard mode" });
  }

  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ leaderboard: rows || [], mode });
  });
});

app.post('/api/user/leaderboard-preference', sensitiveLimiter, requireWalletSession, (req, res) => {
  if (typeof req.body?.hidden !== 'boolean') {
    return res.status(400).json({ error: 'Choose whether your profile should be excluded from leaderboard rankings.' });
  }
  db.run(
    'UPDATE users SET leaderboard_hidden = ? WHERE LOWER(wallet_address) = LOWER(?)',
    [req.body.hidden ? 1 : 0, req.walletAddress],
    function (err) {
      if (err) return res.status(500).json({ error: 'Unable to save your leaderboard preference.' });
      if (this.changes !== 1) return res.status(404).json({ error: 'Set up your profile before changing this preference.' });
      res.json({ success: true, leaderboard_hidden: req.body.hidden });
    }
  );
});

app.get('/api/maintenance/status', (req, res) => {
  db.all(
    'SELECT page_id, is_offline, outage_message FROM site_maintenance ORDER BY page_id',
    [],
    (err, pages) => {
      if (err) return res.status(500).json({ error: 'Unable to load site maintenance status.' });
      res.json({
        pages: pages || [],
        outage_message: pages?.find(page => page.outage_message)?.outage_message || ''
      });
    }
  );
});

app.post('/api/admin/maintenance/load', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.all(
    'SELECT page_id, is_offline, outage_message, updated_at FROM site_maintenance ORDER BY page_id',
    [],
    (err, pages) => {
      if (err) return res.status(500).json({ error: 'Unable to load maintenance settings.' });
      res.json({
        pages: pages || [],
        outage_message: pages?.find(page => page.outage_message)?.outage_message || ''
      });
    }
  );
});

app.post('/api/admin/maintenance/save', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const offlinePages = req.body?.offline_pages;
  const outageMessage = typeof req.body?.outage_message === 'string' ? req.body.outage_message.trim() : '';
  if (!Array.isArray(offlinePages) ||
      offlinePages.some(pageId => typeof pageId !== 'string' || !MAINTENANCE_PAGE_IDS.includes(pageId)) ||
      new Set(offlinePages).size !== offlinePages.length) {
    return res.status(400).json({ error: 'Choose valid pages to place under maintenance.' });
  }
  if (outageMessage.length > 1000 || (offlinePages.length > 0 && !outageMessage)) {
    return res.status(400).json({ error: 'Enter an outage message of up to 1,000 characters for selected pages.' });
  }

  const offlineSet = new Set(offlinePages);
  const wallet = req.body.wallet_address.toLowerCase();
  const rollback = error => db.run('ROLLBACK', () => res.status(500).json({ error }));
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', beginErr => {
      if (beginErr) return res.status(500).json({ error: 'Unable to start maintenance settings update.' });
      let index = 0;
      const saveNextPage = () => {
        if (index >= MAINTENANCE_PAGE_IDS.length) {
          return db.run('COMMIT', commitErr => {
            if (commitErr) return rollback('Unable to save maintenance settings.');
            res.json({ success: true });
          });
        }
        const pageId = MAINTENANCE_PAGE_IDS[index++];
        db.run(
          `INSERT INTO site_maintenance (page_id, is_offline, outage_message, updated_by, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(page_id) DO UPDATE SET
             is_offline = excluded.is_offline,
             outage_message = excluded.outage_message,
             updated_by = excluded.updated_by,
             updated_at = CURRENT_TIMESTAMP`,
          [pageId, offlineSet.has(pageId) ? 1 : 0, outageMessage, wallet],
          saveErr => saveErr
            ? rollback('Unable to save maintenance settings.')
            : saveNextPage()
        );
      };
      saveNextPage();
    });
  });
});

app.get('/api/user/profile', requireWalletSession, (req, res) => {
  const wallet = req.query.wallet;
  if (typeof wallet !== 'string' || wallet.toLowerCase() !== req.walletAddress) {
    return res.status(403).json({ error: 'Wallet session does not match the requested profile.' });
  }

  db.get(
    `SELECT u.*,
            COALESCE(u.level_one_pct_override, rs.level_one_pct, 2) AS effective_referral_pct,
            COALESCE(u.level_two_pct_override, rs.level_two_pct, 2) AS effective_level_two_pct
     FROM users u LEFT JOIN referral_settings rs ON rs.id = 1
     WHERE LOWER(u.wallet_address) = LOWER(?)`,
    [wallet],
    (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.all(
      `SELECT COUNT(DISTINCT CASE WHEN level = 1 THEN referee_wallet END) AS total_referrals,
              SUM(commission_earned) AS total_earned
       FROM referrals WHERE LOWER(referrer_wallet) = LOWER(?)`,
      [wallet], 
      (err2, stats) => {
        if (err2) return res.status(500).json({ error: 'Unable to load referral totals.' });
        db.all(
          `SELECT SUM(amount) as total_withdrawn FROM referral_withdrawals WHERE LOWER(wallet_address) = LOWER(?) AND status != 'REJECTED'`,
          [wallet],
          (err3, wdrStats) => {
            if (err3) return res.status(500).json({ error: 'Unable to load referral withdrawal totals.' });
            const totalEarned = stats[0]?.total_earned || 0;
            const totalWithdrawn = wdrStats[0]?.total_withdrawn || 0;
            db.get(
              'SELECT x_url, youtube_url, tiktok_url, instagram_url, twitch_url, discord_url, website_url, community_size, community_description, creator_motivation, status, created_at, updated_at, reviewed_at FROM creator_applications WHERE LOWER(wallet_address) = LOWER(?)',
              [wallet],
              (applicationErr, application) => {
                if (applicationErr) return res.status(500).json({ error: 'Unable to load creator application.' });
                res.json({
                  user: user || null,
                  application: application || null,
                  stats: {
                    total_referrals: stats[0]?.total_referrals || 0,
                    total_earned: totalEarned,
                    available_commission: Math.max(0, totalEarned - totalWithdrawn)
                  }
                });
              }
            );
          }
        );
      }
    );
    }
  );
});

app.get('/api/user/withdrawal-certificates', requireWalletSession, (req, res) => {
  db.all(
    `SELECT id, COALESCE(user_amount, ROUND(amount * 0.9, 2)) AS amount,
            paid_at, created_at
     FROM withdrawals
     WHERE LOWER(wallet_address) = LOWER(?) AND status = 'PAID'
     UNION ALL
     SELECT id, amount, paid_at, created_at
     FROM referral_withdrawals
     WHERE LOWER(wallet_address) = LOWER(?) AND status = 'PAID'
     ORDER BY paid_at DESC, created_at DESC`,
    [req.walletAddress, req.walletAddress],
    (err, certificates) => {
      if (err) return res.status(500).json({ error: 'Unable to load your withdrawal certificates.' });
      db.get(
        'SELECT username FROM users WHERE LOWER(wallet_address) = LOWER(?)',
        [req.walletAddress],
        (userErr, user) => {
          if (userErr) return res.status(500).json({ error: 'Unable to load your certificate profile.' });
          res.json({
            username: user?.username || 'Blastrr Trader',
            certificates: (certificates || []).map(certificate => ({
              ...certificate,
              amount: Number(certificate.amount || 0)
            }))
          });
        }
      );
    }
  );
});

app.post('/api/user/profile', sensitiveLimiter, requireTradeSignature, (req, res) => {
  const { wallet_address, username, discount_code } = req.body;
  if (typeof username !== 'string' || typeof discount_code !== 'string') {
    return res.status(400).json({ error: "Username and promo code are required." });
  }

  const cleanUsername = username.trim().toLowerCase();
  const cleanCode = discount_code.trim().toUpperCase();
  if (!/^[a-z0-9_]{3,24}$/.test(cleanUsername) || !/^[A-Z0-9_-]{4,20}$/.test(cleanCode)) {
    return res.status(400).json({ error: "Username must be 3-24 letters, numbers, or underscores; promo codes must be 4-20 letters, numbers, underscores, or hyphens." });
  }

  db.get(
    `SELECT * FROM users WHERE (LOWER(username) = ? OR UPPER(discount_code) = ?) AND LOWER(wallet_address) != LOWER(?)`,
    [cleanUsername, cleanCode, wallet_address],
    (err, existing) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existing) {
        if (existing.username.toLowerCase() === cleanUsername) {
          return res.status(400).json({ error: "Username is already taken by another user." });
        }
        return res.status(400).json({ error: "Promo Code is already taken by another user." });
      }

      db.run(
        `INSERT INTO users (wallet_address, username, discount_code) 
         VALUES (?, ?, ?)
         ON CONFLICT(wallet_address) DO UPDATE SET 
         username = excluded.username, 
         discount_code = excluded.discount_code`,
        [wallet_address, cleanUsername, cleanCode],
        (err2) => {
          if (err2) return res.status(400).json({ error: "Failed to update profile." });
          res.json({ success: true, message: "Profile updated successfully." });
        }
      );
    }
  );
});

app.post('/api/user/creator-application', sensitiveLimiter, requireTradeSignature, (req, res) => {
  const wallet = req.body.wallet_address.toLowerCase();
  const linkFields = ['x_url', 'youtube_url', 'tiktok_url', 'instagram_url', 'twitch_url', 'discord_url', 'website_url'];
  const links = {};
  for (const field of linkFields) {
    const value = typeof req.body[field] === 'string' ? req.body[field].trim() : '';
    if (value.length > 300) return res.status(400).json({ error: 'Social profile links must be 300 characters or fewer.' });
    if (value) {
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('Invalid URL');
      } catch {
        return res.status(400).json({ error: 'Enter valid http or https links for social profiles.' });
      }
    }
    links[field] = value || null;
  }
  if (!linkFields.some(field => links[field])) {
    return res.status(400).json({ error: 'Add at least one social profile link.' });
  }

  const communitySize = typeof req.body.community_size === 'string' ? req.body.community_size.trim() : '';
  const communityDescription = typeof req.body.community_description === 'string' ? req.body.community_description.trim() : '';
  const creatorMotivation = typeof req.body.creator_motivation === 'string' ? req.body.creator_motivation.trim() : '';
  const allowedCommunitySizes = ['Just me', '1-100', '101-1,000', '1,001-10,000', '10,001-100,000', '100,000+'];
  if (!allowedCommunitySizes.includes(communitySize) ||
      communityDescription.length < 10 || communityDescription.length > 1000 ||
      creatorMotivation.length < 10 || creatorMotivation.length > 1000) {
    return res.status(400).json({ error: 'Choose a community size and answer both questions in 10 to 1,000 characters.' });
  }

  db.run(
    `INSERT INTO creator_applications
      (wallet_address, x_url, youtube_url, tiktok_url, instagram_url, twitch_url, discord_url, website_url,
       community_size, community_description, creator_motivation, status, updated_at, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP, NULL)
     ON CONFLICT(wallet_address) DO UPDATE SET
       x_url = excluded.x_url,
       youtube_url = excluded.youtube_url,
       tiktok_url = excluded.tiktok_url,
       instagram_url = excluded.instagram_url,
       twitch_url = excluded.twitch_url,
       discord_url = excluded.discord_url,
       website_url = excluded.website_url,
       community_size = excluded.community_size,
       community_description = excluded.community_description,
       creator_motivation = excluded.creator_motivation,
       status = 'PENDING',
       updated_at = CURRENT_TIMESTAMP,
       reviewed_at = NULL`,
    [wallet, ...linkFields.map(field => links[field]), communitySize, communityDescription, creatorMotivation],
    err => {
      if (err) return res.status(500).json({ error: 'Unable to save creator application.' });
      res.json({ success: true, status: 'PENDING' });
    }
  );
});

app.post('/api/admin/creator-applications/list', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.all(
    `SELECT ca.*, u.username, COALESCE(u.level_one_pct_override, rs.level_one_pct, 2) AS referral_pct
     FROM creator_applications ca
     LEFT JOIN users u ON LOWER(u.wallet_address) = LOWER(ca.wallet_address)
     LEFT JOIN referral_settings rs ON rs.id = 1
     ORDER BY CASE ca.status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END,
              ca.updated_at DESC
     LIMIT 200`,
    [],
    (err, applications) => {
      if (err) return res.status(500).json({ error: 'Unable to load creator applications.' });
      res.json({ applications: applications || [] });
    }
  );
});

app.post('/api/admin/creator-applications/action', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const wallet = req.body?.user_wallet;
  const action = req.body?.action;
  const referralPct = Number(req.body?.referral_pct);
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet) || !['APPROVE', 'REJECT'].includes(action)) {
    return res.status(400).json({ error: 'Choose a valid creator application and approval action.' });
  }
  if (action === 'APPROVE' && (!Number.isFinite(referralPct) || referralPct < 0 || referralPct > 100)) {
    return res.status(400).json({ error: 'Choose a referral bonus from 0% to 100%.' });
  }

  const normalizedPct = Math.round(referralPct * 100) / 100;
  const rollback = (status, error) => db.run('ROLLBACK', () => res.status(status).json({ error }));
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', beginErr => {
      if (beginErr) return res.status(500).json({ error: 'Unable to start creator application review.' });
      db.get(
        'SELECT wallet_address FROM creator_applications WHERE LOWER(wallet_address) = LOWER(?)',
        [wallet],
        (findErr, application) => {
          if (findErr) return rollback(500, 'Unable to load creator application.');
          if (!application) return rollback(404, 'Creator application not found.');
          const status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
          db.run(
            'UPDATE creator_applications SET status = ?, updated_at = CURRENT_TIMESTAMP, reviewed_at = CURRENT_TIMESTAMP WHERE LOWER(wallet_address) = LOWER(?)',
            [status, wallet],
            updateErr => {
              if (updateErr) return rollback(500, 'Unable to update creator application status.');
              const finish = () => db.run('COMMIT', commitErr => {
                if (commitErr) return rollback(500, 'Unable to save creator application review.');
                res.json({ success: true, status, referral_pct: action === 'APPROVE' ? normalizedPct : 2 });
              });
              const rate = action === 'APPROVE' ? normalizedPct : 2;
              if (action === 'REJECT') {
                return db.run(
                  'UPDATE users SET referral_pct = 2, level_one_pct_override = NULL WHERE LOWER(wallet_address) = LOWER(?)',
                  [application.wallet_address],
                  rateErr => rateErr
                    ? rollback(500, 'Unable to reset creator referral bonus.')
                    : finish()
                );
              }
              db.run(
                `INSERT INTO users (wallet_address, referral_pct, level_one_pct_override)
                 SELECT ?, ?, ? WHERE NOT EXISTS (
                   SELECT 1 FROM users WHERE LOWER(wallet_address) = LOWER(?)
                 )`,
                [application.wallet_address, rate, rate, application.wallet_address],
                insertErr => {
                  if (insertErr) return rollback(500, 'Unable to assign creator referral bonus.');
                  db.run(
                    'UPDATE users SET referral_pct = ?, level_one_pct_override = ? WHERE LOWER(wallet_address) = LOWER(?)',
                    [rate, rate, application.wallet_address],
                    rateErr => rateErr
                      ? rollback(500, 'Unable to assign creator referral bonus.')
                      : finish()
                  );
                }
              );
            }
          );
        }
      );
    });
  });
});

app.post('/api/promo/claim', sensitiveLimiter, requireWalletSession, (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  if (!/^FREE-[A-F0-9]{20}$/.test(code)) {
    return res.status(400).json({ error: 'Enter a valid free account code.' });
  }

  const rollback = (status, error) => db.run('ROLLBACK', () => res.status(status).json({ error }));
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', (beginErr) => {
      if (beginErr) return res.status(500).json({ error: 'Unable to start code redemption.' });
      db.get(
        `SELECT c.plan_id, c.claimed_by, c.claimed_at, p.name AS plan_name,
                p.simulated_capital
         FROM promo_codes c JOIN plans p ON p.id = c.plan_id
         WHERE c.code = ?`,
        [code],
        (codeErr, promo) => {
          if (codeErr) return rollback(500, 'Unable to check this free account code.');
          if (!promo) return rollback(404, 'Free account code not found.');
          if (promo.claimed_at || promo.claimed_by) return rollback(409, 'This free account code has already been claimed.');

          db.get(
            'SELECT wallet_address FROM users WHERE LOWER(wallet_address) = LOWER(?)',
            [req.walletAddress],
            (userErr, user) => {
              if (userErr) return rollback(500, 'Unable to prepare your account.');
              const walletAddress = user?.wallet_address || req.walletAddress;
              const createAccount = () => {
                const accountId = `acc_${crypto.randomBytes(8).toString('hex')}`;
                db.run(
                  `UPDATE promo_codes SET claimed_by = ?, claimed_at = CURRENT_TIMESTAMP
                   WHERE code = ? AND claimed_at IS NULL AND claimed_by IS NULL`,
                  [walletAddress, code],
                  function(claimErr) {
                    if (claimErr) return rollback(500, 'Unable to claim this free account code.');
                    if (this.changes !== 1) return rollback(409, 'This free account code has already been claimed.');
                    db.run(
                      `INSERT INTO accounts (id, wallet_address, plan_id, initial_balance, current_balance,
                         current_equity, high_water_mark, daily_starting_balance, risk_day, status)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
                      [
                        accountId, walletAddress, promo.plan_id, promo.simulated_capital,
                        promo.simulated_capital, promo.simulated_capital, promo.simulated_capital,
                        promo.simulated_capital, new Date().toISOString().slice(0, 10)
                      ],
                      (accountErr) => {
                        if (accountErr) return rollback(500, 'Unable to provision the free account.');
                        db.run('COMMIT', (commitErr) => {
                          if (commitErr) return rollback(500, 'Unable to commit free account provisioning.');
                          res.json({
                            success: true,
                            account_id: accountId,
                            plan_name: promo.plan_name,
                            message: 'Free account provisioned successfully.'
                          });
                        });
                      }
                    );
                  }
                );
              };

              if (user) return createAccount();
              db.run(
                'INSERT INTO users (wallet_address) VALUES (?)',
                [walletAddress],
                (insertUserErr) => {
                  if (insertUserErr) return rollback(500, 'Unable to prepare your account.');
                  createAccount();
                }
              );
            }
          );
        }
      );
    });
  });
});

function attachTicketMessages(tickets, callback) {
  if (!tickets.length) return callback(null, tickets);
  const ids = tickets.map(ticket => ticket.id);
  const placeholders = ids.map(() => '?').join(',');
  db.all(
    `SELECT id, ticket_id, author_role, author_name, body, created_at
     FROM support_ticket_messages WHERE ticket_id IN (${placeholders})
     ORDER BY created_at, id`,
    ids,
    (err, messages) => {
      if (err) return callback(err);
      const grouped = new Map(tickets.map(ticket => [ticket.id, []]));
      for (const message of messages || []) grouped.get(message.ticket_id)?.push(message);
      for (const ticket of tickets) ticket.messages = grouped.get(ticket.id) || [];
      callback(null, tickets);
    }
  );
}

app.get('/api/user/tickets', requireWalletSession, (req, res) => {
  const wallet = req.query.wallet;
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet) || wallet.toLowerCase() !== req.walletAddress) {
    return res.status(403).json({ error: 'Wallet session does not match the requested support tickets.' });
  }
  db.all(
    `SELECT t.*, p.name AS plan_name
     FROM support_tickets t
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN plans p ON p.id = a.plan_id
     WHERE LOWER(t.wallet_address) = LOWER(?)
     ORDER BY t.updated_at DESC, t.created_at DESC LIMIT 100`,
    [wallet],
    (err, tickets) => {
      if (err) return res.status(500).json({ error: 'Unable to load support tickets.' });
      attachTicketMessages(tickets || [], (messagesErr, results) => {
        if (messagesErr) return res.status(500).json({ error: 'Unable to load ticket replies.' });
        res.json({ tickets: results });
      });
    }
  );
});

app.post('/api/user/tickets', sensitiveLimiter, requireWalletSession, (req, res) => {
  const accountId = typeof req.body?.account_id === 'string' && req.body.account_id ? req.body.account_id : null;
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (subject.length < 5 || subject.length > 120 || message.length < 10 || message.length > 5000) {
    return res.status(400).json({ error: 'Enter a subject (5–120 characters) and issue details (10–5,000 characters).' });
  }

  const createTicket = (username) => {
    const ticketId = `ticket_${crypto.randomBytes(8).toString('hex')}`;
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', (beginErr) => {
        if (beginErr) return res.status(500).json({ error: 'Unable to start support ticket.' });
        const rollback = (error) => db.run('ROLLBACK', () => res.status(500).json({ error }));
        db.run(
          `INSERT INTO support_tickets (id, wallet_address, account_id, subject, status)
           VALUES (?, ?, ?, ?, 'OPEN')`,
          [ticketId, req.walletAddress, accountId, subject],
          (ticketErr) => {
            if (ticketErr) return rollback('Unable to create support ticket.');
            db.run(
              `INSERT INTO support_ticket_messages (ticket_id, author_role, author_name, body)
               VALUES (?, 'USER', ?, ?)`,
              [ticketId, username || `${req.walletAddress.slice(0, 6)}…${req.walletAddress.slice(-4)}`, message],
              (messageErr) => {
                if (messageErr) return rollback('Unable to save the initial ticket message.');
                db.run('COMMIT', (commitErr) => {
                  if (commitErr) return rollback('Unable to commit support ticket.');
                  res.status(201).json({ success: true, ticket_id: ticketId });
                });
              }
            );
          }
        );
      });
    });
  };

  const verifyAccount = (done) => {
    if (!accountId) return done(null, null);
    db.get(
      `SELECT id FROM accounts WHERE id = ? AND LOWER(wallet_address) = LOWER(?)`,
      [accountId, req.walletAddress],
      (err, account) => {
        if (err) return res.status(500).json({ error: 'Unable to verify the selected account.' });
        if (!account) return res.status(403).json({ error: 'The selected account does not belong to this wallet.' });
        done(null, account);
      }
    );
  };
  verifyAccount(() => {
    db.get('SELECT username FROM users WHERE LOWER(wallet_address) = LOWER(?)', [req.walletAddress], (userErr, user) => {
      if (userErr) return res.status(500).json({ error: 'Unable to load profile for support ticket.' });
      createTicket(user?.username);
    });
  });
});

app.post('/api/user/tickets/:ticketId/reply', sensitiveLimiter, requireWalletSession, (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (message.length < 1 || message.length > 5000) {
    return res.status(400).json({ error: 'Ticket replies must be between 1 and 5,000 characters.' });
  }
  db.get(
    `SELECT t.id, t.status, u.username FROM support_tickets t
     LEFT JOIN users u ON LOWER(u.wallet_address) = LOWER(t.wallet_address)
     WHERE t.id = ? AND LOWER(t.wallet_address) = LOWER(?)`,
    [req.params.ticketId, req.walletAddress],
    (err, ticket) => {
      if (err) return res.status(500).json({ error: 'Unable to load support ticket.' });
      if (!ticket) return res.status(404).json({ error: 'Support ticket not found.' });
      if (ticket.status === 'CLOSED') return res.status(409).json({ error: 'Closed tickets cannot be replied to.' });
      db.serialize(() => {
        db.run('BEGIN IMMEDIATE', (beginErr) => {
          if (beginErr) return res.status(500).json({ error: 'Unable to start ticket reply.' });
          const rollback = (error) => db.run('ROLLBACK', () => res.status(500).json({ error }));
          db.run(
            `INSERT INTO support_ticket_messages (ticket_id, author_role, author_name, body)
             VALUES (?, 'USER', ?, ?)`,
            [ticket.id, ticket.username || `${req.walletAddress.slice(0, 6)}…${req.walletAddress.slice(-4)}`, message],
            (insertErr) => {
              if (insertErr) return rollback('Unable to save ticket reply.');
              db.run(
                `UPDATE support_tickets SET status = 'OPEN', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status != 'CLOSED'`,
                [ticket.id],
                function(updateErr) {
                  if (updateErr) return rollback('Unable to update ticket status.');
                  if (this.changes !== 1) {
                    return db.run('ROLLBACK', () => res.status(409).json({ error: 'Closed tickets cannot be replied to.' }));
                  }
                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) return rollback('Unable to commit ticket reply.');
                    res.json({ success: true, status: 'OPEN' });
                  });
                }
              );
            }
          );
        });
      });
    }
  );
});

app.get('/api/user/review', requireWalletSession, (req, res) => {
  const wallet = req.query.wallet;
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet) || wallet.toLowerCase() !== req.walletAddress) {
    return res.status(403).json({ error: 'Wallet session does not match the requested review.' });
  }
  db.all(
    `SELECT a.id AS account_id, a.created_at AS account_created_at, p.name AS plan_name,
            r.username, r.rating, r.comment, r.published, r.created_at, r.updated_at
     FROM accounts a
    LEFT JOIN plans p ON p.id = a.plan_id
    LEFT JOIN user_reviews r ON r.account_id = a.id AND LOWER(r.wallet_address) = LOWER(a.wallet_address)
    WHERE LOWER(a.wallet_address) = LOWER(?)
    ORDER BY a.created_at, a.id`,
    [wallet],
    (err, accounts) => {
      if (err) return res.status(500).json({ error: 'Unable to load your eligible review accounts.' });
      res.json({ accounts: accounts || [] });
    }
  );
});

app.post('/api/user/reviews', sensitiveLimiter, requireWalletSession, (req, res) => {
  const accountId = typeof req.body?.account_id === 'string' ? req.body.account_id.trim() : '';
  const rating = Number(req.body?.rating);
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
  if (!accountId || !Number.isInteger(rating) || rating < 1 || rating > 5 || comment.length < 10 || comment.length > 1500) {
    return res.status(400).json({ error: 'Select an account assigned to your wallet, choose 1–5 stars, and enter a review between 10 and 1,500 characters.' });
  }
  db.get('SELECT username FROM users WHERE LOWER(wallet_address) = LOWER(?)', [req.walletAddress], (err, user) => {
    if (err) return res.status(500).json({ error: 'Unable to load your profile.' });
    if (!user?.username) return res.status(400).json({ error: 'Create a profile username before submitting a review.' });
    db.get(
      `SELECT a.id FROM accounts a
       WHERE a.id = ? AND LOWER(a.wallet_address) = LOWER(?)`,
      [accountId, req.walletAddress],
      (accountErr, account) => {
        if (accountErr) return res.status(500).json({ error: 'Unable to verify account ownership.' });
        if (!account) return res.status(403).json({ error: 'Reviews are available only for accounts assigned to this wallet.' });
        db.get(
          `SELECT xp_reward, points_reward FROM battlepass_tasks
           WHERE task_type = 'PLATFORM_REVIEW' AND is_builtin = 1 AND active = 1`,
          [],
          (taskErr, task) => {
            if (taskErr) return res.status(500).json({ error: 'Unable to load the BlastrrPass review reward.' });
            if (!task) return res.status(503).json({ error: 'The BlastrrPass review reward is temporarily unavailable.' });
            db.serialize(() => {
              db.run('BEGIN IMMEDIATE', beginErr => {
                if (beginErr) return res.status(500).json({ error: 'Unable to start review submission.' });
                const rollback = (status, error) => db.run('ROLLBACK', () => res.status(status).json({ error }));
                db.run(
                  `INSERT INTO user_reviews (account_id, wallet_address, username, rating, comment, published)
                   VALUES (?, ?, ?, ?, ?, 0)
                   ON CONFLICT(account_id) DO UPDATE SET username = excluded.username,
                     rating = excluded.rating, comment = excluded.comment, published = 0,
                     updated_at = CURRENT_TIMESTAMP
                   WHERE LOWER(user_reviews.wallet_address) = LOWER(excluded.wallet_address)`,
                  [accountId, req.walletAddress, user.username, rating, comment],
                  function(saveErr) {
                    if (saveErr) return rollback(500, 'Unable to save your review.');
                    if (this.changes !== 1) return rollback(403, 'This account review belongs to another wallet.');
                    db.run(
                      `INSERT OR IGNORE INTO battlepass_events
                       (id, wallet_address, event_type, reference_id, xp, points)
                       VALUES (?, ?, 'PLATFORM_REVIEW', ?, ?, ?)`,
                      [
                        `bpe_${crypto.randomBytes(10).toString('hex')}`,
                        req.walletAddress,
                        req.walletAddress.toLowerCase(),
                        task.xp_reward,
                        task.points_reward
                      ],
                      function(eventErr) {
                        if (eventErr) return rollback(500, 'Unable to record the BlastrrPass review reward.');
                        const rewardApplied = this.changes === 1;
                        const finish = () => db.run('COMMIT', commitErr => {
                          if (commitErr) return rollback(500, 'Unable to complete review submission.');
                          res.json({
                            success: true,
                            message: rewardApplied
                              ? `Review saved for admin review. Your one-time BlastrrPass reward of ${task.xp_reward} XP and ${task.points_reward} points was applied.`
                              : 'Review saved and sent to the admin team for review. Your one-time BlastrrPass reward was already earned.',
                            xp_awarded: rewardApplied ? Number(task.xp_reward) : 0,
                            points_awarded: rewardApplied ? Number(task.points_reward) : 0
                          });
                        });
                        if (!rewardApplied) return finish();
                        db.run(
                          `INSERT OR IGNORE INTO battlepass_users (wallet_address) VALUES (?)`,
                          [req.walletAddress],
                          insertErr => {
                            if (insertErr) return rollback(500, 'Unable to prepare your BlastrrPass balance.');
                            db.run(
                              `UPDATE battlepass_users
                               SET xp = xp + ?, points = points + ?, updated_at = CURRENT_TIMESTAMP
                               WHERE LOWER(wallet_address) = LOWER(?)`,
                              [task.xp_reward, task.points_reward, req.walletAddress],
                              balanceErr => {
                                if (balanceErr) return rollback(500, 'Unable to apply your BlastrrPass reward.');
                                finish();
                              }
                            );
                          }
                        );
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
});

app.get('/api/reviews', (req, res) => {
  db.all(
    `SELECT username, rating, comment, updated_at
     FROM user_reviews WHERE published = 1
     ORDER BY updated_at DESC LIMIT 12`,
    [],
    (err, reviews) => {
      if (err) return res.status(500).json({ error: 'Unable to load published reviews.' });
      res.json({ reviews: reviews || [] });
    }
  );
});

app.post('/api/admin/tickets', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.all(
    `SELECT t.*, u.username, a.plan_id, p.name AS plan_name
     FROM support_tickets t
     LEFT JOIN users u ON LOWER(u.wallet_address) = LOWER(t.wallet_address)
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN plans p ON p.id = a.plan_id
     ORDER BY CASE t.status WHEN 'OPEN' THEN 0 WHEN 'NEEDS_INFO' THEN 1 ELSE 2 END,
       t.updated_at DESC LIMIT 250`,
    [],
    (err, tickets) => {
      if (err) return res.status(500).json({ error: 'Unable to load support tickets.' });
      attachTicketMessages(tickets || [], (messagesErr, results) => {
        if (messagesErr) return res.status(500).json({ error: 'Unable to load ticket replies.' });
        res.json({ tickets: results });
      });
    }
  );
});

app.post('/api/admin/tickets/action', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const ticketId = typeof req.body?.ticket_id === 'string' ? req.body.ticket_id : '';
  const action = req.body?.action;
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!ticketId || !['REPLY', 'CLOSE'].includes(action) ||
      (action === 'REPLY' && (message.length < 1 || message.length > 5000)) ||
      (action === 'CLOSE' && message.length > 5000)) {
    return res.status(400).json({ error: 'A ticket, valid action, and reply within 5,000 characters are required.' });
  }
  db.get('SELECT id, status FROM support_tickets WHERE id = ?', [ticketId], (err, ticket) => {
    if (err) return res.status(500).json({ error: 'Unable to load support ticket.' });
    if (!ticket) return res.status(404).json({ error: 'Support ticket not found.' });
    if (ticket.status === 'CLOSED') return res.status(409).json({ error: 'This ticket is already closed.' });
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', (beginErr) => {
        if (beginErr) return res.status(500).json({ error: 'Unable to start ticket update.' });
        const rollback = (error) => db.run('ROLLBACK', () => res.status(500).json({ error }));
        const updateStatus = () => db.run(
          `UPDATE support_tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'CLOSED'`,
          [action === 'CLOSE' ? 'CLOSED' : 'NEEDS_INFO', ticket.id],
          function(updateErr) {
            if (updateErr) return rollback('Unable to update ticket status.');
            if (this.changes !== 1) {
              return db.run('ROLLBACK', () => res.status(409).json({ error: 'This ticket is already closed.' }));
            }
            db.run('COMMIT', (commitErr) => {
              if (commitErr) return rollback('Unable to commit ticket update.');
              res.json({ success: true, status: action === 'CLOSE' ? 'CLOSED' : 'NEEDS_INFO' });
            });
          }
        );
        if (!message) return updateStatus();
        db.run(
          `INSERT INTO support_ticket_messages (ticket_id, author_role, author_name, body)
           VALUES (?, 'ADMIN', 'Blastrr Support', ?)`,
          [ticket.id, message],
          (insertErr) => insertErr ? rollback('Unable to save admin reply.') : updateStatus()
        );
      });
    });
  });
});

app.post('/api/admin/reviews', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.all(
    `SELECT r.account_id, r.wallet_address, r.username, r.rating, r.comment, r.published, r.created_at, r.updated_at,
            p.name AS plan_name
     FROM user_reviews r
     LEFT JOIN accounts a ON a.id = r.account_id
     LEFT JOIN plans p ON p.id = a.plan_id
     ORDER BY r.published ASC, r.updated_at DESC LIMIT 300`,
    [],
    (err, reviews) => {
      if (err) return res.status(500).json({ error: 'Unable to load user reviews.' });
      res.json({ reviews: reviews || [] });
    }
  );
});

app.post('/api/admin/reviews/action', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const accountId = req.body?.review_account_id;
  const action = req.body?.action;
  if (typeof accountId !== 'string' || !accountId.trim() || !['PUBLISH', 'HIDE'].includes(action)) {
    return res.status(400).json({ error: 'A valid review account and publish or hide action are required.' });
  }
  db.run(
    'UPDATE user_reviews SET published = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = ?',
    [action === 'PUBLISH' ? 1 : 0, accountId.trim()],
    function(updateErr) {
      if (updateErr) return res.status(500).json({ error: 'Unable to update review publication.' });
      if (this.changes !== 1) return res.status(404).json({ error: 'Review not found.' });
      res.json({ success: true, published: action === 'PUBLISH' });
    }
  );
});

app.post('/api/admin/referrals/search', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (username.length < 2 || username.length > 24) {
    return res.status(400).json({ error: 'Enter at least 2 characters of a username to search.' });
  }
  db.all(
    `SELECT u.wallet_address, u.username,
            COALESCE(u.level_one_pct_override, s.level_one_pct, 2) AS referral_pct,
            COALESCE(u.level_two_pct_override, s.level_two_pct, 2) AS level_two_pct
     FROM users u
     LEFT JOIN referral_settings s ON s.id = 1
     WHERE u.username IS NOT NULL AND u.username LIKE ? COLLATE NOCASE
     ORDER BY u.username COLLATE NOCASE LIMIT 50`,
    [`%${username}%`],
    (err, users) => {
      if (err) return res.status(500).json({ error: 'Unable to search users.' });
      res.json({ users: users || [] });
    }
  );
});

app.post('/api/admin/referrals/commission', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const wallet = req.body?.user_wallet;
  const referralPct = Number(req.body?.referral_pct);
  const levelTwoPct = Number(req.body?.level_two_pct);
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet) ||
      !Number.isFinite(referralPct) || referralPct < 0 || referralPct > 100 ||
      !Number.isFinite(levelTwoPct) || levelTwoPct < 0 || levelTwoPct > 100) {
    return res.status(400).json({ error: 'Choose a valid user wallet and level-1 and level-2 rates from 0 to 100%.' });
  }
  const normalizedPct = Math.round(referralPct * 100) / 100;
  const normalizedLevelTwoPct = Math.round(levelTwoPct * 100) / 100;
  db.run(
    `UPDATE users
     SET referral_pct = ?, level_one_pct_override = ?, level_two_pct_override = ?
     WHERE LOWER(wallet_address) = LOWER(?) AND username IS NOT NULL`,
    [normalizedPct, normalizedPct, normalizedLevelTwoPct, wallet],
    function(updateErr) {
      if (updateErr) return res.status(500).json({ error: 'Unable to update the creator commission rate.' });
      if (this.changes !== 1) return res.status(404).json({ error: 'User profile not found.' });
      res.json({ success: true, referral_pct: normalizedPct, level_two_pct: normalizedLevelTwoPct });
    }
  );
});

app.post('/api/admin/referrals/settings/load', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.get('SELECT level_one_pct, level_two_pct FROM referral_settings WHERE id = 1', [], (err, settings) => {
    if (err) return res.status(500).json({ error: 'Unable to load referral commission settings.' });
    res.json({
      level_one_pct: Number(settings?.level_one_pct ?? 2),
      level_two_pct: Number(settings?.level_two_pct ?? 2)
    });
  });
});

app.post('/api/admin/referrals/settings/save', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const levelOnePct = Number(req.body?.level_one_pct);
  const levelTwoPct = Number(req.body?.level_two_pct);
  if (!Number.isFinite(levelOnePct) || levelOnePct < 0 || levelOnePct > 100 ||
      !Number.isFinite(levelTwoPct) || levelTwoPct < 0 || levelTwoPct > 100) {
    return res.status(400).json({ error: 'Enter level-1 and level-2 commission rates from 0 to 100%.' });
  }
  const normalizedLevelOnePct = Math.round(levelOnePct * 100) / 100;
  const normalizedLevelTwoPct = Math.round(levelTwoPct * 100) / 100;
  db.run(
    `INSERT INTO referral_settings (id, level_one_pct, level_two_pct) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       level_one_pct = excluded.level_one_pct,
       level_two_pct = excluded.level_two_pct`,
    [normalizedLevelOnePct, normalizedLevelTwoPct],
    err => {
      if (err) return res.status(500).json({ error: 'Unable to save the referral commission rates.' });
      res.json({ success: true, level_one_pct: normalizedLevelOnePct, level_two_pct: normalizedLevelTwoPct });
    }
  );
});

app.post('/api/admin/promo-codes/list', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.all(
    `SELECT c.code, c.created_at, c.claimed_by, c.claimed_at, p.name AS plan_name
     FROM promo_codes c JOIN plans p ON p.id = c.plan_id
     ORDER BY c.created_at DESC LIMIT 100`,
    [],
    (err, codes) => {
      if (err) return res.status(500).json({ error: 'Unable to load free account codes.' });
      res.json({ codes: codes || [] });
    }
  );
});

app.post('/api/admin/promo-codes/create', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const planId = Number(req.body?.plan_id);
  if (!Number.isInteger(planId) || planId <= 0) {
    return res.status(400).json({ error: 'Choose an account plan for this code.' });
  }
  db.get('SELECT id, name FROM plans WHERE id = ? AND active = 1', [planId], (planErr, plan) => {
    if (planErr) return res.status(500).json({ error: 'Unable to load the selected account plan.' });
    if (!plan) return res.status(404).json({ error: 'The selected account plan is not available.' });
    const code = `FREE-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
    db.run(
      'INSERT INTO promo_codes (code, plan_id, created_by) VALUES (?, ?, ?)',
      [code, plan.id, req.body.wallet_address.toLowerCase()],
      (insertErr) => {
        if (insertErr) return res.status(500).json({ error: 'Unable to generate a free account code.' });
        res.json({ success: true, code, plan_name: plan.name });
      }
    );
  });
});

app.post('/api/admin/battlepass/settings', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const discountPct = Number(req.body?.standard_discount_pct);
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    return res.status(400).json({ error: 'The standard discount must be between 0 and 100%.' });
  }
  const normalizedDiscountPct = Math.round(discountPct * 100) / 100;
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', beginErr => {
      if (beginErr) return res.status(500).json({ error: 'Unable to start the standard discount update.' });
      const rollback = error => db.run('ROLLBACK', () => res.status(500).json({ error }));
      db.run(
        'UPDATE battlepass_settings SET standard_discount_pct = ? WHERE id = 1',
        [normalizedDiscountPct],
        function(updateErr) {
          if (updateErr) return rollback('Unable to update the standard discount.');
          if (this.changes !== 1) return rollback('Battle pass settings are unavailable.');
          db.run(
            'UPDATE plans SET price_usdt = ROUND(base_price_usdt * (100 - ?) / 100, 2)',
            [normalizedDiscountPct],
            priceErr => {
              if (priceErr) return rollback('Unable to synchronize plan sale prices.');
              db.run('COMMIT', commitErr => {
                if (commitErr) return rollback('Unable to commit the standard discount.');
                res.json({ success: true, standard_discount_pct: normalizedDiscountPct });
              });
            }
          );
        }
      );
    });
  });
});

app.post('/api/admin/battlepass/settings/get', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.get('SELECT standard_discount_pct FROM battlepass_settings WHERE id = 1', [], (err, settings) => {
    if (err || !settings) return res.status(500).json({ error: 'Unable to load battle pass settings.' });
    res.json({ settings });
  });
});

app.post('/api/admin/battlepass/levels/list', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.all('SELECT level, xp_required, discount_bonus_pct, points_cost FROM battlepass_levels ORDER BY level', [], (err, levels) => {
    if (err) return res.status(500).json({ error: 'Unable to load battle pass levels.' });
    res.json({ levels: levels || [] });
  });
});

app.post('/api/admin/battlepass/levels/save', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const level = Number(req.body?.level);
  const discountPct = Number(req.body?.discount_bonus_pct);
  const pointsCost = Number(req.body?.points_cost);
  if (!Number.isInteger(level) || level < 1 || level > 12 ||
      !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100 ||
      !Number.isSafeInteger(pointsCost) || pointsCost < 0) {
    return res.status(400).json({ error: 'Set a level from 1 to 12, an additional discount from 0 to 100%, and a non-negative point cost.' });
  }
  db.run(
    'UPDATE battlepass_levels SET discount_bonus_pct = ?, points_cost = ? WHERE level = ?',
    [Math.round(discountPct * 100) / 100, pointsCost, level],
    function(updateErr) {
      if (updateErr) return res.status(500).json({ error: 'Unable to update the level reward.' });
      if (this.changes !== 1) return res.status(404).json({ error: 'Battle pass level not found.' });
      res.json({ success: true });
    }
  );
});

app.post('/api/admin/battlepass/plan-rewards/list', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.all(
    `SELECT p.id AS plan_id, p.name, p.simulated_capital,
            COALESCE(r.xp_reward, 1000) AS xp_reward,
            COALESCE(r.points_reward, 100) AS points_reward
     FROM plans p LEFT JOIN battlepass_plan_rewards r ON r.plan_id = p.id
     WHERE p.active = 1 ORDER BY p.id`,
    [],
    (err, plans) => {
      if (err) return res.status(500).json({ error: 'Unable to load plan battle pass rewards.' });
      res.json({ plans: plans || [] });
    }
  );
});

app.post('/api/admin/battlepass/plan-rewards/save', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const planId = Number(req.body?.plan_id);
  const xpReward = Number(req.body?.xp_reward);
  const pointsReward = Number(req.body?.points_reward);
  if (!Number.isInteger(planId) || planId <= 0 ||
      !Number.isSafeInteger(xpReward) || xpReward < 0 ||
      !Number.isSafeInteger(pointsReward) || pointsReward < 0) {
    return res.status(400).json({ error: 'Set a valid plan and non-negative XP and point rewards.' });
  }
  db.get('SELECT id FROM plans WHERE id = ? AND active = 1', [planId], (planErr, plan) => {
    if (planErr) return res.status(500).json({ error: 'Unable to load the selected plan.' });
    if (!plan) return res.status(404).json({ error: 'The selected plan is unavailable.' });
    db.run(
      `INSERT INTO battlepass_plan_rewards (plan_id, xp_reward, points_reward) VALUES (?, ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET xp_reward = excluded.xp_reward, points_reward = excluded.points_reward`,
      [planId, xpReward, pointsReward],
      (saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Unable to save plan battle pass rewards.' });
        res.json({ success: true });
      }
    );
  });
});

app.post('/api/admin/battlepass/tasks/list', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.all('SELECT * FROM battlepass_tasks ORDER BY active DESC, cadence, id', [], (err, tasks) => {
    if (err) return res.status(500).json({ error: 'Unable to load battle pass tasks.' });
    res.json({ tasks: tasks || [] });
  });
});

app.post('/api/admin/battlepass/tasks/rewards', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const taskId = Number(req.body?.task_id);
  const xpReward = Number(req.body?.xp_reward);
  const pointsReward = Number(req.body?.points_reward);
  if (!Number.isInteger(taskId) || taskId <= 0 ||
      !Number.isSafeInteger(xpReward) || xpReward < 0 ||
      !Number.isSafeInteger(pointsReward) || pointsReward < 0) {
    return res.status(400).json({ error: 'Set valid non-negative XP and point rewards for a built-in task.' });
  }
  db.run(
    'UPDATE battlepass_tasks SET xp_reward = ?, points_reward = ? WHERE id = ? AND is_builtin = 1',
    [xpReward, pointsReward, taskId],
    function(updateErr) {
      if (updateErr) return res.status(500).json({ error: 'Unable to update built-in task rewards.' });
      if (this.changes !== 1) return res.status(404).json({ error: 'Built-in battle pass task not found.' });
      res.json({ success: true });
    }
  );
});

app.post('/api/admin/battlepass/tasks/save', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const taskId = req.body?.task_id == null || req.body?.task_id === '' ? null : Number(req.body.task_id);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const actionUrl = typeof req.body?.action_url === 'string' ? req.body.action_url.trim() : '';
  const taskType = req.body?.task_type;
  const cadence = req.body?.cadence;
  const xpReward = Number(req.body?.xp_reward);
  const pointsReward = Number(req.body?.points_reward);
  const active = req.body?.active === false ? 0 : 1;
  const validTypes = ['SOCIAL_CLICK', 'WITHDRAWAL'];
  const urlValid = (() => {
    try { return actionUrl.length <= 2048 && new URL(actionUrl).protocol === 'https:'; } catch { return false; }
  })();
  if ((taskId != null && (!Number.isInteger(taskId) || taskId <= 0)) ||
      title.length < 3 || title.length > 100 ||
      description.length < 3 || description.length > 500 ||
      !validTypes.includes(taskType) || !['DAILY', 'WEEKLY', 'MONTHLY'].includes(cadence) ||
      (taskType === 'SOCIAL_CLICK' && !urlValid) ||
      !Number.isSafeInteger(xpReward) || xpReward < 0 ||
      !Number.isSafeInteger(pointsReward) || pointsReward < 0) {
    return res.status(400).json({ error: 'Provide a valid task, cadence, action link (for social tasks), and non-negative XP and point rewards.' });
  }
  const values = [title, description, actionUrl || 'https://x.com/', taskType, cadence, xpReward, pointsReward, active];
  if (taskId == null) {
    return db.run(
      `INSERT INTO battlepass_tasks (title, description, action_url, task_type, cadence, xp_reward, points_reward, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      values,
      function(insertErr) {
        if (insertErr) return res.status(500).json({ error: 'Unable to create the battle pass task.' });
        res.json({ success: true, task_id: this.lastID });
      }
    );
  }
  db.get('SELECT is_builtin FROM battlepass_tasks WHERE id = ?', [taskId], (taskErr, task) => {
    if (taskErr) return res.status(500).json({ error: 'Unable to load the battle pass task.' });
    if (!task) return res.status(404).json({ error: 'Battle pass task not found.' });
    if (Number(task.is_builtin) === 1) {
      return res.status(400).json({ error: 'Built-in activity tasks only allow their XP and point rewards to be changed.' });
    }
    db.run(
      `UPDATE battlepass_tasks SET title = ?, description = ?, action_url = ?, task_type = ?,
         cadence = ?, xp_reward = ?, points_reward = ?, active = ? WHERE id = ? AND is_builtin = 0`,
      [...values, taskId],
      function(updateErr) {
        if (updateErr) return res.status(500).json({ error: 'Unable to update the battle pass task.' });
        if (this.changes !== 1) return res.status(404).json({ error: 'Battle pass task not found.' });
        res.json({ success: true, task_id: taskId });
      }
    );
  });
});

app.get('/api/user/referrals', requireWalletSession, (req, res) => {
  const wallet = req.query.wallet;
  if (typeof wallet !== 'string' || wallet.toLowerCase() !== req.walletAddress) {
    return res.status(403).json({ error: 'Wallet session does not match the requested referrals.' });
  }

  db.all(
    `SELECT r.created_at, r.paid_amount, r.commission_earned, r.commission_pct, r.level AS referral_level,
            p.name AS plan_name, u.username AS buyer_username
     FROM referrals r
     JOIN plans p ON r.plan_id = p.id
     LEFT JOIN users u ON LOWER(r.referee_wallet) = LOWER(u.wallet_address)
     WHERE LOWER(r.referrer_wallet) = LOWER(?)
     ORDER BY r.created_at DESC`,
    [wallet],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(
        `SELECT wallet_address, username
         FROM users WHERE LOWER(referred_by) = LOWER(?)
         ORDER BY username COLLATE NOCASE, wallet_address`,
        [wallet],
        (refereesErr, referees) => {
          if (refereesErr) return res.status(500).json({ error: 'Unable to load your referees.' });
          db.get(
            `SELECT COALESCE(u.level_one_pct_override, s.level_one_pct, 2) AS level_one_pct,
                    COALESCE(u.level_two_pct_override, s.level_two_pct, 2) AS level_two_pct
             FROM referral_settings s
             LEFT JOIN users u ON LOWER(u.wallet_address) = LOWER(?)
             WHERE s.id = 1`,
            [wallet],
            (settingsErr, settings) => {
            if (settingsErr) return res.status(500).json({ error: 'Unable to load referral commission settings.' });
            res.json({
              referrals: rows || [],
              referees: referees || [],
              level_one_pct: Number(settings?.level_one_pct ?? 2),
              level_two_pct: Number(settings?.level_two_pct ?? 2)
            });
            }
          );
        }
      );
    }
  );
});

app.post('/api/referrals/withdraw', sensitiveLimiter, requireTradeSignature, (req, res) => {
  const { wallet_address, amount } = req.body;
  const amountValue = Number(amount);
  if (!Number.isFinite(amountValue) || amountValue <= 0) {
    return res.status(400).json({ error: "Invalid withdrawal parameters." });
  }

  const rollback = (status, error) => db.run('ROLLBACK', () => res.status(status).json({ error }));
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', (beginErr) => {
      if (beginErr) return res.status(500).json({ error: 'Unable to start commission withdrawal.' });
      db.get(
        `SELECT COALESCE(SUM(commission_earned), 0) AS total_earned
         FROM referrals WHERE LOWER(referrer_wallet) = LOWER(?)`,
        [wallet_address],
        (earnedErr, earnedRow) => {
          if (earnedErr) return rollback(500, 'Unable to calculate commission balance.');
          db.get(
            `SELECT COALESCE(SUM(amount), 0) AS total_withdrawn
             FROM referral_withdrawals WHERE LOWER(wallet_address) = LOWER(?) AND status != 'REJECTED'`,
            [wallet_address],
            (withdrawnErr, withdrawnRow) => {
              if (withdrawnErr) return rollback(500, 'Unable to check prior commission withdrawals.');
              const available = Number(earnedRow.total_earned) - Number(withdrawnRow.total_withdrawn);
              if (amountValue > available) {
                return rollback(400, `Requested amount ($${amountValue}) exceeds available commission balance ($${available.toFixed(2)}).`);
              }

              const withdrawalId = `refw_${crypto.randomBytes(7).toString('hex')}`;
              db.run(
                `INSERT INTO referral_withdrawals (id, wallet_address, amount, status)
                 VALUES (?, ?, ?, 'PENDING')`,
                [withdrawalId, wallet_address, amountValue],
                (insertErr) => {
                  if (insertErr) return rollback(500, 'Unable to record commission withdrawal.');
                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) return rollback(500, 'Unable to commit commission withdrawal.');
                    res.json({ success: true, message: 'Commission withdrawal requested successfully.' });
                  });
                }
              );
            }
          );
        }
      );
    });
  });
});

app.post('/api/promo/validate', sensitiveLimiter, (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  if (!code) return res.json({ valid: false });
  db.get('SELECT standard_discount_pct FROM battlepass_settings WHERE id = 1', [], (settingsErr, settings) => {
    if (settingsErr) return res.status(500).json({ error: 'Unable to load current purchase discounts.' });
    const standardDiscountPct = Number(settings?.standard_discount_pct ?? 90);
    db.get('SELECT wallet_address FROM users WHERE UPPER(discount_code) = ?', [code], (userErr, user) => {
      if (userErr) return res.status(500).json({ error: 'Unable to validate the promo code.' });
      if (user) {
        return res.json({ valid: true, type: 'CREATOR', discount_pct: standardDiscountPct });
      }
      db.get(
        `SELECT discount_bonus_pct FROM battlepass_reward_codes
         WHERE UPPER(code) = ? AND redeemed_at IS NULL`,
        [code],
        (rewardErr, reward) => {
          if (rewardErr) return res.status(500).json({ error: 'Unable to validate the reward code.' });
          if (!reward) return res.json({ valid: false, error: 'Invalid or already-used promo code.' });
          res.json({
            valid: true,
            type: 'BATTLEPASS',
            discount_pct: Math.min(100, standardDiscountPct + Number(reward.discount_bonus_pct)),
            bonus_discount_pct: Number(reward.discount_bonus_pct)
          });
        }
      );
    });
  });
});

app.get('/api/accounts', requireWalletSession, (req, res) => {
  const wallet = req.query.wallet;
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet) || wallet.toLowerCase() !== req.walletAddress) {
    return res.status(403).json({ error: 'Wallet session does not match the requested accounts.' });
  }

  db.all(
    `SELECT a.*, p.name as plan_name, p.profit_target, p.max_drawdown_pct, p.daily_loss_pct, p.simulated_capital 
     FROM accounts a 
     JOIN plans p ON a.plan_id = p.id 
     WHERE LOWER(a.wallet_address) = LOWER(?)`,
    [wallet],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ accounts: rows || [] });
    }
  );
});

app.get('/api/accounts/performance', requireWalletSession, (req, res) => {
  db.all(
    `SELECT a.id AS account_id, p.name AS plan_name, a.initial_balance, a.current_balance,
            a.status, a.lock_reason, a.permanent_lock, a.admin_frozen,
            t.id AS trade_id, t.status AS trade_status, t.pnl AS trade_pnl
     FROM accounts a
     JOIN plans p ON p.id = a.plan_id
     LEFT JOIN trades t ON t.account_id = a.id
     WHERE LOWER(a.wallet_address) = LOWER(?)
     ORDER BY a.created_at, t.created_at`,
    [req.walletAddress],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Unable to load account performance.' });
      const accounts = new Map();
      for (const row of rows || []) {
        let account = accounts.get(row.account_id);
        if (!account) {
          account = {
            accountId: row.account_id,
            planName: row.plan_name || 'Trading account',
            initialBalance: Number(row.initial_balance || 0),
            currentBalance: Number(row.current_balance || 0),
            status: row.status,
            lockReason: row.lock_reason,
            permanentLock: Number(row.permanent_lock) === 1,
            adminFrozen: Number(row.admin_frozen) === 1,
            trades: []
          };
          accounts.set(row.account_id, account);
        }
        if (row.trade_id) account.trades.push({ status: row.trade_status, pnl: row.trade_pnl });
      }

      const allAccounts = [...accounts.values()];
      const activeAccounts = allAccounts.filter(account =>
        account.status === 'ACTIVE' &&
        !account.lockReason &&
        !account.permanentLock &&
        !account.adminFrozen
      );
      const dllLockedAccounts = allAccounts.filter(account =>
        account.status === 'LOCKED' &&
        account.lockReason === 'DLL' &&
        !account.permanentLock &&
        !account.adminFrozen
      );
      const includedAccounts = [...activeAccounts, ...dllLockedAccounts];
      const accountSummaries = activeAccounts.map(account => ({
        accountId: account.accountId,
        planName: account.planName,
        initialBalance: account.initialBalance,
        currentBalance: account.currentBalance,
        metrics: calculateTradePerformance(account.trades)
      }));
      const allTrades = includedAccounts.flatMap(account => account.trades);
      const includedInitialBalance = includedAccounts.reduce((total, account) => total + account.initialBalance, 0);
      const includedCurrentBalance = includedAccounts.reduce((total, account) => total + account.currentBalance, 0);
      res.json({
        overall: {
          ...calculateTradePerformance(allTrades),
          accountCount: includedAccounts.length,
          activeAccountCount: activeAccounts.length,
          dllLockedAccountCount: dllLockedAccounts.length,
          initialBalance: includedInitialBalance,
          currentBalance: includedCurrentBalance
        },
        accounts: accountSummaries
      });
    }
  );
});

app.get('/api/accounts/details', requireWalletSession, (req, res) => {
  const accountId = req.query.account_id;
  const wallet = req.query.wallet;
  if (!accountId || typeof wallet !== 'string' || !ethers.isAddress(wallet) || wallet.toLowerCase() !== req.walletAddress) {
    return res.status(403).json({ error: 'Wallet session does not match the requested account.' });
  }

  db.get(
    `SELECT wallet_address FROM accounts WHERE id = ?`,
    [accountId],
    (err, account) => {
      if (err) return res.status(500).json({ error: 'Unable to load account.' });
      if (!account) return res.status(404).json({ error: "Account not found" });
      if (account.wallet_address.toLowerCase() !== wallet.toLowerCase()) {
        return res.status(403).json({ error: 'Wallet does not own this account.' });
      }

      refreshRiskBaselines(accountId, (baselineErr, refreshedAccount) => {
        if (baselineErr) return res.status(500).json({ error: 'Unable to update daily account baselines.' });
        account = refreshedAccount;
        refreshAccountLock(account, (unlockErr, activeLock) => {
        if (unlockErr) return res.status(500).json({ error: 'Unable to refresh account lock status.' });
        db.all(`SELECT * FROM trades WHERE account_id = ? ORDER BY created_at DESC`, [accountId], (err2, trades) => {
        if (err2) return res.status(500).json({ error: 'Unable to load account trades.' });
        const totalProfit = account.current_equity - account.initial_balance;
        const profitProgress = Math.min(100, Math.max(0, (totalProfit / account.profit_target) * 100));
        
        const maxAllowedDD = account.initial_balance * (account.max_drawdown_pct / 100);
        const mllFloor = getMllFloor(account, account);
        const riskBalance = getRiskBalance(account);
        const currentDD = Math.max(0, account.high_water_mark - riskBalance);
        const ddProgress = Math.min(100, Math.max(0, (currentDD / maxAllowedDD) * 100));

        const maxAllowedDLL = account.daily_starting_balance * (account.daily_loss_pct / 100);
        const currentDLL = Math.max(0, account.daily_starting_balance - riskBalance);
        const dllProgress = Math.min(100, Math.max(0, (currentDLL / maxAllowedDLL) * 100));
        const withdrawalFloor = getProtectedPayoutBalance(account.initial_balance, account.max_drawdown_pct);
        const withdrawableAmount = getAvailableGrossWithdrawal(
          account.current_balance,
          withdrawalFloor,
          Number(account.pending_withdrawal_amount || 0)
        );

        let consistencyScore = 100;
        if (trades && trades.length > 0) {
          const closedTrades = trades.filter(t => t.status === 'CLOSED');
          if (closedTrades.length > 0) {
            const profits = closedTrades.map(t => t.pnl);
            const maxWin = Math.max(...profits, 0);
            const totalPnLSum = profits.reduce((a, b) => a + b, 0);
            if (totalPnLSum > 0) {
              consistencyScore = Math.max(20, Math.round(100 - ((maxWin / totalPnLSum) * 50)));
            }
          }
        }

        db.all(
          `SELECT day, opening_balance, closing_balance, profit
           FROM daily_account_summaries WHERE account_id = ? ORDER BY day`,
          [accountId],
          (summaryErr, dailySummaries) => {
            if (summaryErr) return res.status(500).json({ error: 'Unable to load daily profit history.' });
            db.all(
              'SELECT day, body, updated_at FROM account_trade_journals WHERE account_id = ? ORDER BY day',
              [accountId],
              (journalErr, journalEntries) => {
                if (journalErr) return res.status(500).json({ error: 'Unable to load account trade journal entries.' });
                res.json({
                  account,
                  lock: activeLock,
                  metrics: {
                    profitProgress: profitProgress.toFixed(1),
                    profitTarget: account.profit_target,
                    currentProfit: totalProfit,
                    ddProgress: ddProgress.toFixed(1),
                    maxAllowedDD,
                    currentDD,
                    mllFloor,
                    dllProgress: dllProgress.toFixed(1),
                    maxAllowedDLL,
                    currentDLL,
                    withdrawalFloor,
                    pendingWithdrawalAmount: Number(account.pending_withdrawal_amount || 0),
                    withdrawableAmount,
                    withdrawalPending: Number(account.pending_withdrawal_amount || 0) > 0,
                    riskBalance,
                    consistencyScore
                  },
                  dailySummaries: dailySummaries || [],
                  journalEntries: journalEntries || [],
                  trades: trades || []
                });
              }
            );
          }
        );
        });
      });
      });
    }
  );
});

app.put('/api/accounts/:accountId/journal', sensitiveLimiter, requireWalletSession, (req, res) => {
  const { accountId } = req.params;
  const { day, body } = req.body || {};
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(`${day}T00:00:00.000Z`)) ||
      new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day ||
      day > new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'Choose a valid calendar day that is not in the future.' });
  }
  if (typeof body !== 'string' || body.length > 5000) {
    return res.status(400).json({ error: 'Journal entries must be text of 5,000 characters or fewer.' });
  }
  const journalText = body.trim();
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(journalText)) {
    return res.status(400).json({ error: 'Journal entries cannot contain control characters.' });
  }

  db.get(
    'SELECT wallet_address FROM accounts WHERE id = ?',
    [accountId],
    (accountErr, account) => {
      if (accountErr) return res.status(500).json({ error: 'Unable to verify account ownership.' });
      if (!account || account.wallet_address?.toLowerCase() !== req.walletAddress) {
        return res.status(403).json({ error: 'You do not own this account.' });
      }

      if (!journalText) {
        return db.run(
          'DELETE FROM account_trade_journals WHERE account_id = ? AND day = ?',
          [accountId, day],
          function(deleteErr) {
            if (deleteErr) return res.status(500).json({ error: 'Unable to delete the journal entry.' });
            res.json({ entry: null, deleted: this.changes > 0 });
          }
        );
      }

      db.run(
        `INSERT INTO account_trade_journals (account_id, day, body, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(account_id, day) DO UPDATE SET
           body = excluded.body,
           updated_at = CURRENT_TIMESTAMP`,
        [accountId, day, journalText],
        (saveErr) => {
          if (saveErr) return res.status(500).json({ error: 'Unable to save the journal entry.' });
          db.get(
            'SELECT day, body, updated_at FROM account_trade_journals WHERE account_id = ? AND day = ?',
            [accountId, day],
            (entryErr, entry) => {
              if (entryErr) return res.status(500).json({ error: 'Unable to confirm the saved journal entry.' });
              res.json({ entry });
            }
          );
        }
      );
    }
  );
});

// --- SECURE PURCHASE ENDPOINT (WITH MULTI-CHAIN ON-CHAIN VERIFICATION) ---
app.post('/api/accounts/purchase', sensitiveLimiter, requireWalletSession, requireUserNotSuspended, async (req, res) => {
  const { wallet_address, plan_id, tx_hash, chain_id } = req.body;
  const quantity = Number(req.body?.quantity ?? 1);
  const maxPurchaseQuantity = 10;
  const promoCode = typeof req.body?.promo_code === 'string' ? req.body.promo_code.trim().toUpperCase() : '';
  if (req.body?.disclaimer_version !== DISCLAIMER_VERSION ||
      req.body?.terms_accepted !== true ||
      req.body?.simulated_funds_acknowledged !== true) {
    return res.status(400).json({ error: 'Confirm the current disclaimers and simulated-funds acknowledgement before purchasing.' });
  }
  if (typeof wallet_address !== 'string' || !ethers.isAddress(wallet_address) ||
      !Number.isInteger(Number(plan_id)) || Number(plan_id) <= 0 ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > maxPurchaseQuantity ||
      (req.body?.promo_code != null && (typeof req.body.promo_code !== 'string' || req.body.promo_code.length > 32))) {
    return res.status(400).json({ error: `Provide a valid plan and a quantity from 1 to ${maxPurchaseQuantity}.` });
  }

  const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
  try {
    const [plan, settings, referralSettings] = await Promise.all([
      dbGet('SELECT * FROM plans WHERE id = ? AND active = 1', [Number(plan_id)]),
      dbGet('SELECT standard_discount_pct FROM battlepass_settings WHERE id = 1'),
      dbGet('SELECT level_one_pct, level_two_pct FROM referral_settings WHERE id = 1')
    ]);
    if (!plan) return res.status(404).json({ error: 'Plan not found.' });
    const standardDiscountPct = Math.max(0, Math.min(100, Number(settings?.standard_discount_pct ?? 90)));
    const levelOneCommissionPct = Math.max(0, Math.min(100, Number(referralSettings?.level_one_pct ?? 2)));
    const levelTwoCommissionPct = Math.max(0, Math.min(100, Number(referralSettings?.level_two_pct ?? 2)));
    let rewardCode = null;
    let referrerWallet = null;
    let referralCommissionPct = 10;
    let bonusDiscountPct = 0;
    if (promoCode) {
      const [creator, coupon] = await Promise.all([
        dbGet('SELECT wallet_address, level_one_pct_override FROM users WHERE UPPER(discount_code) = ?', [promoCode]),
        dbGet(
          `SELECT code, wallet_address, discount_bonus_pct FROM battlepass_reward_codes
           WHERE UPPER(code) = ? AND redeemed_at IS NULL`,
          [promoCode]
        )
      ]);
      if (creator) {
        referrerWallet = creator.wallet_address;
        referralCommissionPct = Number(creator.level_one_pct_override ?? levelOneCommissionPct);
      } else if (coupon && coupon.wallet_address.toLowerCase() === wallet_address.toLowerCase()) {
        rewardCode = coupon;
        bonusDiscountPct = Number(coupon.discount_bonus_pct);
      } else {
        return res.status(400).json({ error: 'Invalid, used, or wallet-bound promo code.' });
      }
    }

    const totalDiscountPct = Math.min(100, standardDiscountPct + bonusDiscountPct);
    const finalPrice = Math.round(Number(plan.base_price_usdt) * (100 - totalDiscountPct)) / 100;
    const totalPrice = Math.round(finalPrice * quantity * 100) / 100;
    const isFreeRedemption = finalPrice === 0;
    if (isFreeRedemption && quantity > 1) {
      return res.status(400).json({ error: 'Free or fully discounted purchases are limited to one account per checkout.' });
    }
    let normalizedTxHash;
    let purchaseChainId = 0;
    if (!isFreeRedemption) {
      if (typeof tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash) ||
          !Number.isInteger(Number(chain_id))) {
        return res.status(400).json({ error: 'A valid payment transaction and network are required.' });
      }
      const verification = await verifyMultiChainPurchase(tx_hash, Number(chain_id), wallet_address, totalPrice, TREASURY_WALLET);
      if (!verification.success) return res.status(400).json({ error: verification.error });
      normalizedTxHash = tx_hash.toLowerCase();
      purchaseChainId = Number(chain_id);
    } else {
      normalizedTxHash = rewardCode
        ? `pass_${rewardCode.code.toLowerCase()}`
        : `free_${crypto.randomBytes(16).toString('hex')}`;
    }

    db.run('INSERT OR IGNORE INTO users (wallet_address) VALUES (?)', [wallet_address], (userErr) => {
      if (userErr) return res.status(500).json({ error: 'Unable to prepare the purchasing account.' });
      db.get(
        `SELECT COALESCE(xp_reward, 1000) AS xp_reward, COALESCE(points_reward, 100) AS points_reward
         FROM battlepass_plan_rewards WHERE plan_id = ?`,
        [Number(plan_id)],
        (rewardErr, planReward) => {
          if (rewardErr) return res.status(500).json({ error: 'Unable to load plan battle pass rewards.' });
          const xpAward = Number(planReward?.xp_reward ?? 1000) * quantity;
          const pointsAward = Number(planReward?.points_reward ?? 100) * quantity;
          const accountIds = Array.from({ length: quantity }, () => `acc_${crypto.randomBytes(8).toString('hex')}`);
          const accountId = accountIds[0];
          db.serialize(() => {
            db.run('BEGIN IMMEDIATE', (beginErr) => {
              if (beginErr) return res.status(500).json({ error: 'Unable to start account provisioning.' });
              const rollback = (status, error) => db.run('ROLLBACK', () => res.status(status).json({ error }));
              db.get(
                'SELECT admin_suspended, admin_suspend_reason FROM users WHERE LOWER(wallet_address) = LOWER(?)',
                [wallet_address],
                (userErr, user) => {
                  if (userErr) return rollback(500, 'Unable to verify user account access.');
                  if (Number(user?.admin_suspended) === 1) {
                    return rollback(403, `This user account is suspended by an administrator${user.admin_suspend_reason ? `: ${user.admin_suspend_reason}` : '.'}`);
                  }
                  db.run(
                    `INSERT INTO purchases (tx_hash, chain_id, wallet_address, account_id, quantity)
                     VALUES (?, ?, ?, ?, ?)`,
                    [normalizedTxHash, purchaseChainId, wallet_address, accountId, quantity],
                    (purchaseErr) => {
                      if (purchaseErr) return rollback(409, 'This transaction or discount code has already been used.');
                  const provisionAccounts = (index, onComplete) => {
                    if (index >= accountIds.length) return onComplete();
                    db.run(
                      `INSERT INTO accounts (id, wallet_address, plan_id, initial_balance, current_balance,
                         current_equity, high_water_mark, daily_starting_balance, risk_day, status)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
                      [
                        accountIds[index], wallet_address, Number(plan_id), plan.simulated_capital,
                        plan.simulated_capital, plan.simulated_capital, plan.simulated_capital,
                        plan.simulated_capital, new Date().toISOString().slice(0, 10)
                      ],
                      accountErr => accountErr
                        ? rollback(500, 'Unable to provision all purchased accounts.')
                        : provisionAccounts(index + 1, onComplete)
                    );
                  };
                  const completeProvisioning = () => provisionAccounts(0, () => {
                      const finishPurchase = () => db.run('COMMIT', (commitErr) => {
                        if (commitErr) return rollback(500, 'Unable to commit account provisioning.');
                        res.json({
                          success: true,
                          account_id: accountId,
                          account_ids: accountIds,
                          quantity,
                          xp_awarded: isFreeRedemption ? 0 : xpAward,
                          points_awarded: isFreeRedemption ? 0 : pointsAward,
                          message: isFreeRedemption
                            ? 'Free battle pass account provisioned successfully.'
                            : `${quantity} account${quantity === 1 ? '' : 's'} provisioned; payment verified successfully.`
                        });
                      });
                      const recordReferralCommissions = () => {
                        if (!referrerWallet || referrerWallet.toLowerCase() === wallet_address.toLowerCase()) {
                          return finishPurchase();
                        }
                        db.run(
                          `UPDATE users SET referred_by = ?
                           WHERE LOWER(wallet_address) = LOWER(?)
                             AND (referred_by IS NULL OR TRIM(referred_by) = '')`,
                          [referrerWallet, wallet_address],
                          attributionErr => {
                            if (attributionErr) return rollback(500, 'Unable to save referral attribution.');
                            db.run(
                              `INSERT INTO referrals
                               (referrer_wallet, referee_wallet, plan_id, paid_amount, commission_earned, commission_pct, level)
                               VALUES (?, ?, ?, ?, ?, ?, 1)`,
                              [
                                referrerWallet,
                                wallet_address,
                                Number(plan_id),
                                totalPrice,
                                totalPrice * referralCommissionPct / 100,
                                referralCommissionPct
                              ],
                              referralErr => {
                                if (referralErr) return rollback(500, 'Unable to record the direct referral commission.');
                                db.get(
                                  'SELECT referred_by, level_two_pct_override FROM users WHERE LOWER(wallet_address) = LOWER(?)',
                                  [referrerWallet],
                                  (parentErr, parent) => {
                                    if (parentErr) return rollback(500, 'Unable to load level-2 referral attribution.');
                                    const secondLevelWallet = parent?.referred_by;
                                    const secondLevelCommissionPct = Number(parent?.level_two_pct_override ?? levelTwoCommissionPct);
                                    if (!secondLevelWallet ||
                                        secondLevelWallet.toLowerCase() === wallet_address.toLowerCase() ||
                                        secondLevelWallet.toLowerCase() === referrerWallet.toLowerCase()) {
                                      return finishPurchase();
                                    }
                                    db.run(
                                      `INSERT INTO referrals
                                       (referrer_wallet, referee_wallet, plan_id, paid_amount, commission_earned, commission_pct, level)
                                       VALUES (?, ?, ?, ?, ?, ?, 2)`,
                                      [
                                        secondLevelWallet,
                                        wallet_address,
                                        Number(plan_id),
                                        totalPrice,
                                        totalPrice * secondLevelCommissionPct / 100,
                                        secondLevelCommissionPct
                                      ],
                                      levelTwoErr => levelTwoErr
                                        ? rollback(500, 'Unable to record the level-2 referral commission.')
                                        : finishPurchase()
                                    );
                                  }
                                );
                              }
                            );
                          }
                        );
                      };
                      if (isFreeRedemption) return recordReferralCommissions();
                      db.run('INSERT OR IGNORE INTO battlepass_users (wallet_address) VALUES (?)', [wallet_address], (battlePassErr) => {
                        if (battlePassErr) return rollback(500, 'Unable to prepare battle pass purchase rewards.');
                        db.run(
                          `UPDATE battlepass_users SET xp = xp + ?, points = points + ?, updated_at = CURRENT_TIMESTAMP
                           WHERE LOWER(wallet_address) = LOWER(?)`,
                          [xpAward, pointsAward, wallet_address],
                          (balanceErr) => {
                            if (balanceErr) return rollback(500, 'Unable to apply battle pass purchase rewards.');
                            db.run(
                              `INSERT INTO battlepass_events (id, wallet_address, event_type, reference_id, xp, points)
                               VALUES (?, ?, 'PURCHASE', ?, ?, ?)`,
                              [`bpe_${crypto.randomBytes(10).toString('hex')}`, wallet_address, normalizedTxHash, xpAward, pointsAward],
                              (eventErr) => eventErr
                                ? rollback(500, 'Unable to record battle pass purchase rewards.')
                                : recordReferralCommissions()
                            );
                          }
                        );
                      });
                    });
                  if (!rewardCode) return completeProvisioning();
                  db.run(
                    `UPDATE battlepass_reward_codes SET redeemed_at = CURRENT_TIMESTAMP
                     WHERE code = ? AND LOWER(wallet_address) = LOWER(?) AND redeemed_at IS NULL`,
                    [rewardCode.code, wallet_address],
                    function(redeemErr) {
                      if (redeemErr) return rollback(500, 'Unable to redeem the battle pass discount code.');
                      if (this.changes !== 1) return rollback(409, 'This battle pass discount code has already been used.');
                      completeProvisioning();
                    }
                  );
                    }
                  );
                }
              );
            });
          });
        }
      );
    });
  } catch (error) {
    console.error('Unable to calculate purchase price:', error.message);
    return res.status(500).json({ error: 'Unable to calculate the current purchase price.' });
  }
});

// --- SECURE WITHDRAWAL REQUEST ENDPOINT ---
app.post('/api/withdrawals/request', sensitiveLimiter, requireTradeSignature, requireUserNotSuspended, (req, res) => {
    const { account_id, wallet_address, amount } = req.body;
    const amountValue = Math.round(Number(amount) * 100) / 100;
    const userIp = req.ip;

    if (!account_id || !Number.isFinite(amountValue) || amountValue <= 0) {
        return res.status(400).json({ success: false, error: "Invalid request parameters." });
    }

    const rollback = (status, error) => db.run('ROLLBACK', () => res.status(status).json({ success: false, error }));
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', (beginErr) => {
        if (beginErr) return res.status(500).json({ success: false, error: 'Unable to start withdrawal request.' });
        db.get(`
            SELECT a.*, p.name as plan_name, p.max_drawdown_pct,
                   COALESCE(u.admin_suspended, 0) AS user_suspended, u.admin_suspend_reason
            FROM accounts a 
            JOIN plans p ON a.plan_id = p.id 
            LEFT JOIN users u ON LOWER(u.wallet_address) = LOWER(a.wallet_address)
            WHERE a.id = ? AND LOWER(a.wallet_address) = LOWER(?)
        `, [account_id, wallet_address], (accountErr, account) => {
          if (accountErr) return rollback(500, 'Unable to load account.');
          if (!account) return rollback(404, 'Account not found or wallet mismatch.');
          if (Number(account.user_suspended) === 1) {
            return rollback(403, `This user account is suspended by an administrator${account.admin_suspend_reason ? `: ${account.admin_suspend_reason}` : '.'}`);
          }
          if (Number(account.admin_frozen) === 1) return rollback(403, 'This account is frozen by an administrator.');
          if (account.status !== 'ACTIVE') return rollback(400, 'Account is not active.');

          db.get(
            `SELECT COALESCE(SUM(amount), 0) AS pending_amount, COUNT(*) AS pending_count FROM withdrawals
             WHERE account_id = ? AND status = 'PENDING'`,
            [account_id],
            (sumErr, row) => {
              if (sumErr) return rollback(500, 'Unable to verify pending payouts.');
              if (Number(row.pending_count) > 0) {
                return rollback(409, 'A withdrawal is already awaiting admin review; trading remains frozen until it is resolved.');
              }
              const withdrawalFloor = getProtectedPayoutBalance(account.initial_balance, account.max_drawdown_pct);
              const pendingAmount = Number(row.pending_amount) || 0;
              const maxAllowableWithdrawal = getAvailableGrossWithdrawal(
                account.current_balance,
                withdrawalFloor,
                pendingAmount
              );
              if (amountValue > maxAllowableWithdrawal) {
                return rollback(400, `Withdrawal exceeds the amount above the protected account balance of $${withdrawalFloor.toLocaleString()}. Available to request: $${maxAllowableWithdrawal.toFixed(2)} USDT.`);
              }

              const withdrawalId = `WDR-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
              const { gross, userAmount, adminShare } = splitWithdrawal(amountValue);
              db.run(
                `INSERT INTO withdrawals
                 (id, account_id, wallet_address, type, plan_name, amount, user_amount, admin_share, user_ip, status, funds_deducted, created_at)
                 VALUES (?, ?, ?, 'PROFIT_SPLIT', ?, ?, ?, ?, ?, 'PENDING', 0, datetime('now'))`,
                [withdrawalId, account_id, wallet_address, account.plan_name, gross, userAmount, adminShare, userIp],
                (insertErr) => {
                  if (insertErr) return rollback(500, 'Unable to record withdrawal request.');
                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) return rollback(500, 'Unable to complete withdrawal request.');
                    res.json({
                      success: true,
                      message: 'Withdrawal request submitted for admin review.',
                      gross_amount: gross,
                      user_amount: userAmount,
                      admin_share: adminShare,
                      protected_balance: withdrawalFloor
                    });
                  });
                }
              );
            }
          );
        });
      });
    });
});

app.post('/api/admin/withdrawals', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.all(
    `SELECT w.id, w.account_id, w.wallet_address, w.amount, w.status, w.created_at, w.funds_deducted,
     'ACCOUNT' as type, p.name as plan_name, w.user_ip, a.current_balance AS account_balance,
     a.initial_balance, a.high_water_mark, a.admin_frozen, a.admin_freeze_reason,
     p.max_drawdown_pct,
     COALESCE(w.user_amount, ROUND(w.amount * 0.9, 2)) AS user_amount,
     COALESCE(w.admin_share, ROUND(w.amount - ROUND(w.amount * 0.9, 2), 2)) AS admin_share
     FROM withdrawals w 
     JOIN accounts a ON w.account_id = a.id 
     JOIN plans p ON a.plan_id = p.id 
     UNION ALL
     SELECT id as id, NULL as account_id, wallet_address, amount, status, created_at, NULL AS funds_deducted,
      'COMMISSION' as type, 'Referral Commission' as plan_name, NULL as account_balance,
      NULL AS initial_balance, NULL AS high_water_mark, NULL AS admin_frozen,
      NULL AS admin_freeze_reason, NULL AS max_drawdown_pct,
      amount AS user_amount, 0 AS admin_share, NULL as user_ip
     FROM referral_withdrawals
     ORDER BY created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Unable to load withdrawal queue.' });
      const withdrawals = rows || [];
      const accountIds = [...new Set(withdrawals.filter(row => row.type === 'ACCOUNT').map(row => row.account_id))];
      const tradesByAccount = new Map();
      const loadNext = (index) => {
        if (index >= accountIds.length) {
          return res.json({
            withdrawals: withdrawals.map(row => ({
              ...row,
              trades: row.type === 'ACCOUNT' ? (tradesByAccount.get(row.account_id) || []) : []
            }))
          });
        }
        const accountId = accountIds[index];
        db.all(
          `SELECT id, symbol, side, entry_price, size_usd, pnl, status, created_at, closed_at
           FROM trades WHERE account_id = ? ORDER BY created_at DESC`,
          [accountId],
          (tradeErr, trades) => {
            if (tradeErr) return res.status(500).json({ error: 'Unable to load account trade review.' });
            tradesByAccount.set(accountId, trades || []);
            loadNext(index + 1);
          }
        );
      };
      loadNext(0);
    }
  );
});

app.post('/api/admin/hedging-alerts', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  db.all(
    `SELECT h.id, h.wallet_address, COALESCE(u.username, '') AS username, h.symbol,
     h.attempted_account_id, h.attempted_side, h.conflicting_side, h.created_at,
     GROUP_CONCAT(DISTINCT CASE WHEN ha.account_id != h.attempted_account_id THEN ha.account_id END) AS conflicting_account_ids,
     COUNT(DISTINCT CASE WHEN a.admin_frozen = 1 THEN a.id END) AS frozen_account_count
     FROM hedging_alerts h
     LEFT JOIN users u ON LOWER(u.wallet_address) = LOWER(h.wallet_address)
     JOIN hedging_alert_accounts ha ON ha.alert_id = h.id
     JOIN accounts a ON a.id = ha.account_id
     GROUP BY h.id
     HAVING COUNT(DISTINCT CASE WHEN a.admin_frozen = 1 THEN a.id END) > 0
     ORDER BY h.created_at DESC LIMIT 100`,
    [],
    (err, alerts) => {
      if (err) return res.status(500).json({ error: 'Unable to load hedging alerts.' });
      res.json({ alerts: alerts || [] });
    }
  );
});

app.post('/api/admin/users/search', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (query.length < 2 || query.length > 100 || !/^[a-z0-9_]+$/i.test(query)) {
    return res.status(400).json({ error: 'Enter at least 2 letters, numbers, or underscores to search by username or wallet.' });
  }
  db.all(
    `SELECT u.wallet_address, u.username, u.created_at,
            COALESCE(u.admin_suspended, 0) AS admin_suspended, u.admin_suspend_reason,
            (SELECT l.locked_at FROM wallet_security_locks l
             WHERE LOWER(l.wallet_address) = LOWER(u.wallet_address) AND l.cleared_at IS NULL
             ORDER BY l.id DESC LIMIT 1) AS security_locked_at,
            (SELECT i.ip_address FROM wallet_security_locks l
             JOIN ip_security_incidents i ON i.id = l.incident_id
             WHERE LOWER(l.wallet_address) = LOWER(u.wallet_address) AND l.cleared_at IS NULL
             ORDER BY l.id DESC LIMIT 1) AS security_lock_ip,
            (SELECT COUNT(*) FROM user_login_ip_events li
             WHERE LOWER(li.wallet_address) = LOWER(u.wallet_address) AND li.is_new_ip = 1
               AND li.created_at >= datetime('now', '-180 days')) AS new_ip_count,
            (SELECT COUNT(*) FROM accounts a WHERE LOWER(a.wallet_address) = LOWER(u.wallet_address)) AS account_count
     FROM users u
     WHERE instr(LOWER(COALESCE(u.username, '')), LOWER(?)) > 0
        OR instr(LOWER(u.wallet_address), LOWER(?)) > 0
     ORDER BY CASE WHEN LOWER(u.username) = LOWER(?) THEN 0 ELSE 1 END,
              u.username COLLATE NOCASE, u.wallet_address
     LIMIT 25`,
    [query, query, query],
    (err, users) => {
      if (err) return res.status(500).json({ error: 'Unable to search user profiles.' });
      res.json({ users: users || [] });
    }
  );
});

app.post('/api/admin/users/action', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const { user_wallet: wallet, action } = req.body;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet) ||
      !['SUSPEND', 'RESTORE', 'CLEAR_IP_SOFT_LOCK'].includes(action) ||
      (action === 'SUSPEND' && (!reason || reason.length > 500))) {
    return res.status(400).json({ error: 'Choose a valid user, action, and a suspension reason (up to 500 characters).' });
  }
  if (action === 'CLEAR_IP_SOFT_LOCK') {
    if (reason.length > 500) return res.status(400).json({ error: 'The review note must be 500 characters or fewer.' });
    return clearWalletSecurityLock(db, wallet, req.walletAddress, reason, (clearErr, result) => {
      if (clearErr) {
        console.error('Unable to clear wallet security lock:', clearErr.message);
        return res.status(500).json({ error: 'Unable to clear wallet security lock.' });
      }
      if (!result.cleared) return res.status(404).json({ error: 'No active IP security lock exists for this wallet.' });
      res.json({ success: true, message: 'Wallet security lock cleared after review.' });
    });
  }
  const suspended = action === 'SUSPEND' ? 1 : 0;
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', beginErr => {
      if (beginErr) return res.status(500).json({ error: 'Unable to start user suspension update.' });
      const rollback = (status, error) => db.run('ROLLBACK', () => res.status(status).json({ error }));
      db.run(
        `UPDATE users SET admin_suspended = ?, admin_suspend_reason = ?, admin_suspended_by = ?,
           admin_suspended_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE LOWER(wallet_address) = LOWER(?)`,
        [suspended, suspended ? reason : null, suspended ? req.body.wallet_address : null, suspended, wallet],
        function(updateErr) {
          if (updateErr) return rollback(500, 'Unable to update user suspension.');
          if (this.changes !== 1) return rollback(404, 'User not found.');
          db.run(
            `INSERT INTO user_admin_actions (wallet_address, admin_wallet, action, reason)
             VALUES (?, ?, ?, ?)`,
            [wallet.toLowerCase(), req.body.wallet_address.toLowerCase(), action, suspended ? reason : null],
            insertErr => {
              if (insertErr) return rollback(500, 'Unable to record the user suspension audit event.');
              db.run('COMMIT', commitErr => {
                if (commitErr) return rollback(500, 'Unable to commit user suspension update.');
                res.json({
                  success: true,
                  message: suspended
                    ? 'User suspended. Account purchases, new trades, and withdrawals are disabled; sign-in, viewing, and closing existing trades remain available.'
                    : 'User suspension removed. Per-account freezes and risk locks remain in effect.'
                });
              });
            }
          );
        }
      );
    });
  });
});

app.post('/api/admin/users/accounts', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const wallet = req.body?.user_wallet;
  if (typeof wallet !== 'string' || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: 'Choose a valid user wallet.' });
  }
  loadAdminUserSecurity(wallet, (securityErr, security) => {
    if (securityErr) return res.status(securityErr.message === 'User not found.' ? 404 : 500).json({ error: "Unable to load this user's security details." });
    db.all(
      `SELECT a.id, a.wallet_address, a.plan_id, a.initial_balance, a.current_balance, a.current_equity,
       a.high_water_mark, a.daily_starting_balance, a.status, a.lock_reason, a.locked_until,
       a.permanent_lock, a.admin_frozen, a.admin_freeze_reason, a.created_at, p.name AS plan_name,
       p.max_drawdown_pct, p.daily_loss_pct,
       EXISTS(SELECT 1 FROM withdrawals w WHERE w.account_id = a.id AND w.status = 'PENDING') AS withdrawal_pending
       FROM accounts a JOIN plans p ON a.plan_id = p.id
       WHERE LOWER(a.wallet_address) = LOWER(?)
       ORDER BY CASE WHEN a.status = 'ACTIVE' THEN 0 ELSE 1 END, a.created_at DESC`,
      [wallet],
      (err, accounts) => {
        if (err) return res.status(500).json({ error: "Unable to load this user's accounts." });
        const rows = accounts || [];
        const loadNext = index => {
          if (index >= rows.length) return res.json({ accounts: rows, ...security });
          const row = rows[index];
          loadAccountWithLiveRisk(row.id, (riskErr, liveAccount) => {
            if (riskErr) return res.status(503).json({ error: `Unable to calculate live risk for account ${row.id}.` });
            refreshAccountLock(liveAccount, (lockErr, lock) => {
              if (lockErr) return res.status(500).json({ error: `Unable to apply risk lock for account ${row.id}.` });
              Object.assign(row, {
                risk_balance: getRiskBalance(liveAccount),
                status: liveAccount.status,
                lock_reason: liveAccount.lock_reason,
                locked_until: liveAccount.locked_until,
                permanent_lock: liveAccount.permanent_lock,
                risk_lock: lock || getActiveLock(liveAccount),
                open_trades: liveAccount.open_trades
              });
              db.all(
                `SELECT id, symbol, side, entry_price, size_usd, pnl, status, created_at, closed_at
                 FROM trades WHERE account_id = ? ORDER BY created_at DESC`,
                [row.id],
                (tradeErr, trades) => {
                  if (tradeErr) return res.status(500).json({ error: 'Unable to load account trade review.' });
                  row.trades = trades || [];
                  loadNext(index + 1);
                }
              );
            });
          });
        };
        loadNext(0);
      }
      );
  });
});

app.post('/api/admin/accounts/action', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const { account_id, action } = req.body;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (typeof account_id !== 'string' || !account_id || !['FREEZE', 'UNFREEZE'].includes(action) ||
      (action === 'FREEZE' && (!reason || reason.length > 500))) {
    return res.status(400).json({ error: 'Account, action, and a freeze reason (up to 500 characters) are required.' });
  }
  if (action === 'FREEZE') {
    return db.run(
      `UPDATE accounts SET admin_frozen = 1, admin_freeze_reason = ? WHERE id = ?`,
      [reason, account_id],
      function(err) {
        if (err) return res.status(500).json({ error: 'Unable to freeze account.' });
        if (this.changes !== 1) return res.status(404).json({ error: 'Account not found.' });
        res.json({ success: true, message: 'Account frozen. New trades and withdrawals are disabled.' });
      }
    );
  }
  db.run(
    `UPDATE accounts SET admin_frozen = 0, admin_freeze_reason = NULL WHERE id = ? AND admin_frozen = 1`,
    [account_id],
    function(err) {
      if (err) return res.status(500).json({ error: 'Unable to unfreeze account.' });
      if (this.changes !== 1) return res.status(409).json({ error: 'Account is not currently frozen or was not found.' });
      res.json({ success: true, message: 'Administrator freeze removed. Any active risk lock remains in effect.' });
    }
  );
});

app.post('/api/admin/withdrawals/action', sensitiveLimiter, requireTradeSignature, requireAdminWallet, (req, res) => {
  const { withdrawal_id, action, type } = req.body;
  const normalizedAction = action === 'APPROVE' ? 'PAID' : action;
  if (!withdrawal_id || !['REJECT', 'PAID'].includes(normalizedAction) || !['ACCOUNT', 'COMMISSION'].includes(type)) {
    return res.status(400).json({ error: "A valid withdrawal ID and action are required." });
  }

  const isCommission = type === 'COMMISSION';
  const tableName = isCommission ? 'referral_withdrawals' : 'withdrawals';
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE', (beginErr) => {
      if (beginErr) return res.status(500).json({ error: 'Unable to start withdrawal update.' });
      db.get(`SELECT * FROM ${tableName} WHERE id = ?`, [withdrawal_id], (err, wdr) => {
        const rollback = (status, error) => db.run('ROLLBACK', () => res.status(status).json({ error }));
        if (err) return rollback(500, 'Unable to load withdrawal request.');
        if (!wdr) return rollback(404, 'Withdrawal request not found.');
        if (wdr.status !== 'PENDING') return rollback(409, 'Request already processed.');

        const updateStatus = () => db.run(
          `UPDATE ${tableName} SET status = ?, paid_at = CASE WHEN ? = 'PAID' THEN CURRENT_TIMESTAMP ELSE paid_at END${isCommission ? '' : ", funds_deducted = CASE WHEN ? = 'PAID' THEN 1 ELSE funds_deducted END"}
           WHERE id = ? AND status = 'PENDING'`,
          isCommission
            ? [normalizedAction === 'REJECT' ? 'REJECTED' : 'PAID', normalizedAction, withdrawal_id]
            : [normalizedAction === 'REJECT' ? 'REJECTED' : 'PAID', normalizedAction, normalizedAction, withdrawal_id],
          function(updateErr) {
            if (updateErr) return rollback(500, 'Unable to update withdrawal status.');
            if (this.changes !== 1) return rollback(409, 'Request already processed.');
            db.run('COMMIT', (commitErr) => {
              if (commitErr) return rollback(500, 'Unable to commit withdrawal update.');
              res.json({ success: true, message: `Withdrawal marked as ${normalizedAction}.` });
            });
          }
        );

        if (isCommission || !wdr.account_id) return updateStatus();
        if (normalizedAction === 'REJECT') {
          if (Number(wdr.funds_deducted) !== 1) return updateStatus();
          return db.run(
            `UPDATE accounts SET current_balance = current_balance + ? WHERE id = ?`,
            [wdr.amount, wdr.account_id],
            (refundErr) => {
              if (refundErr) return rollback(500, 'Unable to return previously reserved withdrawal funds.');
              updateStatus();
            }
          );
        }
        if (Number(wdr.funds_deducted) === 1) return updateStatus();
        db.get(
          `SELECT a.current_balance, a.current_equity, a.daily_starting_balance, a.admin_frozen,
           a.initial_balance, p.max_drawdown_pct
           FROM accounts a JOIN plans p ON a.plan_id = p.id WHERE a.id = ?`,
          [wdr.account_id],
          (accountErr, account) => {
            if (accountErr) return rollback(500, 'Unable to load account for withdrawal approval.');
            if (!account) return rollback(404, 'Withdrawal account not found.');
            if (Number(account.admin_frozen) === 1) return rollback(409, 'Unfreeze this account before approving the withdrawal.');
            const withdrawalFloor = getProtectedPayoutBalance(account.initial_balance, account.max_drawdown_pct);
            db.get(
              `SELECT COALESCE(SUM(amount), 0) AS other_pending FROM withdrawals
               WHERE account_id = ? AND status = 'PENDING' AND id != ?`,
              [wdr.account_id, withdrawal_id],
              (pendingErr, pendingRow) => {
                if (pendingErr) return rollback(500, 'Unable to check other pending withdrawals.');
                if (account.current_balance - wdr.amount - Number(pendingRow.other_pending) < withdrawalFloor - 0.005) {
                  return rollback(409, `Approval would reduce account balance or remaining pending payouts below its protected $${withdrawalFloor.toFixed(2)} floor.`);
                }
                db.run(
                  `UPDATE accounts
                   SET current_balance = current_balance - ?,
                       current_equity = current_equity - ?,
                       daily_starting_balance = daily_starting_balance - ?
                   WHERE id = ? AND current_balance - ? >= ? AND admin_frozen = 0`,
                  [wdr.amount, wdr.amount, wdr.amount, wdr.account_id, wdr.amount, withdrawalFloor],
                  function(balanceErr) {
                    if (balanceErr) return rollback(500, 'Unable to deduct approved withdrawal.');
                    if (this.changes !== 1) return rollback(409, 'Account balance changed; refresh and retry.');
                    updateStatus();
                  }
                );
              }
            );
          }
        );
      });
    });
  });
});

app.get('/api/trade-copy/groups', requireWalletSession, (req, res) => {
  db.all(
    `SELECT g.id, g.name, g.active, g.created_at, g.updated_at,
            m.account_id, m.role, m.size_pct, a.plan_id, a.initial_balance,
            a.current_balance, a.status, a.lock_reason, a.permanent_lock, a.admin_frozen,
            p.name AS plan_name
     FROM trade_copy_groups g
     JOIN trade_copy_group_members m ON m.group_id = g.id
     JOIN accounts a ON a.id = m.account_id
     LEFT JOIN plans p ON p.id = a.plan_id
     WHERE LOWER(g.wallet_address) = LOWER(?)
     ORDER BY g.created_at DESC, m.role, a.created_at`,
    [req.walletAddress],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Unable to load copy-trading groups.' });
      const groups = new Map();
      for (const row of rows || []) {
        let group = groups.get(row.id);
        if (!group) {
          group = {
            id: row.id,
            name: row.name,
            active: Number(row.active) === 1,
            created_at: row.created_at,
            updated_at: row.updated_at,
            leader: null,
            followers: []
          };
          groups.set(row.id, group);
        }
        const account = {
          id: row.account_id,
          plan_id: row.plan_id,
          plan_name: row.plan_name || 'Trading account',
          initial_balance: Number(row.initial_balance || 0),
          current_balance: Number(row.current_balance || 0),
          status: row.status,
          lock_reason: row.lock_reason,
          permanent_lock: Number(row.permanent_lock) === 1,
          admin_frozen: Number(row.admin_frozen) === 1,
          size_pct: Number(row.size_pct)
        };
        if (row.role === 'LEADER') group.leader = account;
        else group.followers.push(account);
      }
      res.json({ groups: [...groups.values()] });
    }
  );
});

app.post('/api/trade-copy/groups', sensitiveLimiter, requireWalletSession, walletActionLimiter, requireWalletNotSoftLockedForNewCopyActions, requireUserNotSuspended, (req, res) => {
  if (copyFlatteningWallets.has(req.walletAddress)) {
    return res.status(409).json({ error: 'Copy-trading emergency stop is in progress. Try again when it finishes.' });
  }
  const { group_id: groupId, name: rawName, leader_account_id: leaderAccountId, followers, active } = req.body || {};
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if ((groupId !== undefined && groupId !== null && typeof groupId !== 'string') ||
      (active !== undefined && typeof active !== 'boolean') ||
      !name || name.length > 60 || typeof leaderAccountId !== 'string' ||
      !Array.isArray(followers) || followers.length < 1) {
    return res.status(400).json({ error: 'Enter a group name, one leader, and at least one follower.' });
  }
  const followerIds = followers.map(follower => follower?.account_id);
  if (followerIds.some(id => typeof id !== 'string' || id === leaderAccountId) ||
      new Set(followerIds).size !== followerIds.length ||
      followers.some(follower => !Number.isFinite(Number(follower?.size_pct)) || Number(follower.size_pct) <= 0)) {
    return res.status(400).json({ error: 'Choose unique accounts and enter a positive copy size percentage for each follower.' });
  }

  const accountIds = [leaderAccountId, ...followerIds];
  const placeholders = accountIds.map(() => '?').join(', ');
  db.all(
    `SELECT id, status, lock_reason, permanent_lock FROM accounts
     WHERE LOWER(wallet_address) = LOWER(?) AND id IN (${placeholders})`,
    [req.walletAddress, ...accountIds],
    (accountsErr, accounts) => {
      if (accountsErr) return res.status(500).json({ error: 'Unable to verify selected accounts.' });
      if ((accounts || []).length !== accountIds.length) {
        return res.status(403).json({ error: 'Every selected account must belong to your connected wallet.' });
      }
      if (accounts.some(account =>
        account.status === 'PERMANENTLY_LOCKED' ||
        account.lock_reason === 'MLL' ||
        Number(account.permanent_lock) === 1
      )) {
        return res.status(403).json({ error: 'Permanently locked accounts cannot be added to copy-trading groups.' });
      }
      const persistGroup = (existingGroup) => {
        if (groupId && !existingGroup) return res.status(404).json({ error: 'Copy-trading group not found.' });
        const resolvedGroupId = groupId || `cpy_${crypto.randomBytes(10).toString('hex')}`;
        const isActive = active === undefined ? Number(existingGroup?.active || 0) : active === true;
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE', beginErr => {
            if (beginErr) return res.status(500).json({ error: 'Unable to start group save.' });
            const fail = (status, message) => db.run('ROLLBACK', () => res.status(status).json({ error: message }));
            const saveGroup = groupErr => {
              if (groupErr) return fail(500, 'Unable to save copy-trading group.');
              db.run('DELETE FROM trade_copy_group_members WHERE group_id = ?', [resolvedGroupId], deleteErr => {
                if (deleteErr) return fail(500, 'Unable to update group accounts.');
                const members = [
                  { account_id: leaderAccountId, role: 'LEADER', size_pct: 100 },
                  ...followers.map(follower => ({
                    account_id: follower.account_id,
                    role: 'FOLLOWER',
                    size_pct: Number(follower.size_pct)
                  }))
                ];
                const addMember = index => {
                  if (index >= members.length) {
                    return db.run('COMMIT', commitErr => {
                      if (commitErr) return fail(500, 'Unable to finish saving the group.');
                      res.json({ success: true, group_id: resolvedGroupId });
                    });
                  }
                  const member = members[index];
                  db.run(
                    'INSERT INTO trade_copy_group_members (group_id, account_id, role, size_pct) VALUES (?, ?, ?, ?)',
                    [resolvedGroupId, member.account_id, member.role, member.size_pct],
                    insertErr => {
                      if (insertErr) {
                        const conflict = /UNIQUE constraint failed: trade_copy_group_members\.account_id/.test(insertErr.message);
                        return fail(conflict ? 409 : 500, conflict
                          ? 'An account is already assigned to another copy-trading group.'
                          : 'Unable to assign an account to the group.');
                      }
                      addMember(index + 1);
                    }
                  );
                };
                addMember(0);
              });
            };
            if (existingGroup) {
              return db.run(
                `UPDATE trade_copy_groups SET name = ?, active = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND LOWER(wallet_address) = LOWER(?)`,
                [name, isActive ? 1 : 0, resolvedGroupId, req.walletAddress],
                saveGroup
              );
            }
            db.run(
              `INSERT INTO trade_copy_groups (id, wallet_address, name, active)
               VALUES (?, ?, ?, ?)`,
              [resolvedGroupId, req.walletAddress, name, isActive ? 1 : 0],
              saveGroup
            );
          });
        });
      };
      if (!groupId) return persistGroup(null);
      db.get(
        'SELECT id, active FROM trade_copy_groups WHERE id = ? AND LOWER(wallet_address) = LOWER(?)',
        [groupId, req.walletAddress],
        (groupErr, group) => {
          if (groupErr) return res.status(500).json({ error: 'Unable to verify copy-trading group.' });
          persistGroup(group);
        }
      );
    }
  );
});

app.post('/api/trade-copy/groups/:groupId/active', sensitiveLimiter, requireWalletSession, walletActionLimiter, requireWalletNotSoftLockedForNewCopyActions, requireUserNotSuspended, (req, res) => {
  if (copyFlatteningWallets.has(req.walletAddress)) {
    return res.status(409).json({ error: 'Copy-trading emergency stop is in progress. Try again when it finishes.' });
  }
  const active = req.body?.active;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'Choose whether this copy-trading group is active.' });
  if (active) {
    return db.get(
      `SELECT a.status, a.lock_reason, a.permanent_lock, a.admin_frozen
       FROM trade_copy_group_members m
       JOIN trade_copy_groups g ON g.id = m.group_id
       JOIN accounts a ON a.id = m.account_id
       WHERE m.group_id = ? AND m.role = 'LEADER'
         AND LOWER(g.wallet_address) = LOWER(?)`,
      [req.params.groupId, req.walletAddress],
      (leaderErr, leader) => {
        if (leaderErr) return res.status(500).json({ error: 'Unable to verify the copy-trading leader.' });
        if (!leader || leader.status !== 'ACTIVE' || leader.lock_reason === 'MLL' ||
            Number(leader.permanent_lock) === 1 || Number(leader.admin_frozen) === 1) {
          return res.status(409).json({ error: 'Choose an available leader before activating this group.' });
        }
        updateCopyGroupActive(req, res, active);
      }
    );
  }
  updateCopyGroupActive(req, res, active);
});

function updateCopyGroupActive(req, res, active) {
  db.run(
    `UPDATE trade_copy_groups SET active = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND LOWER(wallet_address) = LOWER(?)`,
    [active ? 1 : 0, req.params.groupId, req.walletAddress],
    function(err) {
      if (err) return res.status(500).json({ error: 'Unable to update group status.' });
      if (this.changes !== 1) return res.status(404).json({ error: 'Copy-trading group not found.' });
      res.json({ success: true, active });
    }
  );
}

app.delete('/api/trade-copy/groups/:groupId', sensitiveLimiter, requireWalletSession, requireUserNotSuspended, (req, res) => {
  db.get(
    'SELECT id FROM trade_copy_groups WHERE id = ? AND LOWER(wallet_address) = LOWER(?)',
    [req.params.groupId, req.walletAddress],
    (findErr, group) => {
      if (findErr) return res.status(500).json({ error: 'Unable to verify copy-trading group.' });
      if (!group) return res.status(404).json({ error: 'Copy-trading group not found.' });
      db.serialize(() => {
        db.run('BEGIN IMMEDIATE', beginErr => {
          if (beginErr) return res.status(500).json({ error: 'Unable to start group deletion.' });
          db.run('DELETE FROM trade_copy_group_members WHERE group_id = ?', [req.params.groupId], membersErr => {
            if (membersErr) return db.run('ROLLBACK', () => res.status(500).json({ error: 'Unable to clear group accounts.' }));
            db.run('DELETE FROM trade_copy_groups WHERE id = ?', [req.params.groupId], deleteErr => {
              if (deleteErr) return db.run('ROLLBACK', () => res.status(500).json({ error: 'Unable to delete copy-trading group.' }));
              db.run('COMMIT', commitErr => {
                if (commitErr) return db.run('ROLLBACK', () => res.status(500).json({ error: 'Unable to finish deleting the group.' }));
                res.json({ success: true });
              });
            });
          });
        });
      });
    }
  );
});

function executeTradeForAccount(accountId, order, walletAddress, callback) {
  const { symbol, side, size_usd, margin_used, leverage, order_type, trigger_price } = order;
  const orderType = String(order_type || 'MARKET').toUpperCase();
  const limitTriggerPrice = trigger_price == null ? null : Number(trigger_price);
  const market = getTradeMarket(symbol);
  const isForex = market?.asset_class === 'FOREX';
  const lotSize = isForex ? Number(order.lot_size) : null;
  if (!market || market.enabled === false) {
    return callback({ status: 400, error: 'The selected market is unavailable.' });
  }
  if (orderType === 'LIMIT' && (!Number.isFinite(limitTriggerPrice) || limitTriggerPrice <= 0)) {
    return callback({ status: 400, error: 'A valid limit trigger price is required.' });
  }
  if (isForex && (!Number.isFinite(lotSize) || lotSize <= 0)) {
    return callback({ status: 400, error: 'A valid forex lot size is required.' });
  }
  db.get(
    `SELECT a.*, p.max_drawdown_pct, p.daily_loss_pct,
     COALESCE((SELECT SUM(w.amount) FROM withdrawals w
       WHERE w.account_id = a.id AND w.status = 'PENDING'), 0) AS pending_withdrawal_amount
     FROM accounts a JOIN plans p ON a.plan_id = p.id WHERE a.id = ?`,
    [accountId],
    (err, account) => {
      if (err) return callback({ status: 500, error: 'Unable to load account.' });
      if (!account) return callback({ status: 404, error: 'Account not found.' });
      if (account.wallet_address.toLowerCase() !== walletAddress) {
        return callback({ status: 403, error: 'Wallet does not own this account.' });
      }

      refreshRiskBaselines(accountId, (baselineErr, refreshedAccount) => {
        if (baselineErr) return callback({ status: 500, error: 'Unable to update daily account baselines.' });
        account = refreshedAccount;
        unlockExpiredAccount(account, (unlockErr, activeLock) => {
          if (unlockErr) return callback({ status: 500, error: 'Unable to refresh account lock status.' });
          if (Number(account.admin_frozen) === 1) {
            return callback({ status: 403, error: `Account is frozen by an administrator${account.admin_freeze_reason ? `: ${account.admin_freeze_reason}` : '.'}` });
          }
          if (activeLock) {
            const message = activeLock.permanent
              ? 'Account permanently locked after exceeding the maximum loss limit (MLL).'
              : `Account locked for DLL breach until ${activeLock.lockedUntil}.`;
            return callback({ status: 403, error: message, lock: activeLock });
          }
          if (account.status !== 'ACTIVE') return callback({ status: 403, error: `Account is not active (${account.status}).` });
          if (Number(account.pending_withdrawal_amount) > 0) {
            return callback({ status: 403, error: 'Trading is temporarily frozen while a withdrawal awaits admin review.' });
          }
          const existingBreach = getRiskBreach(account, account);
          if (existingBreach) {
            return applyRiskBreach(account, existingBreach, (lockErr, appliedLock) => {
              if (lockErr) return callback({ status: 500, error: 'Unable to apply account risk lock.' });
              callback({
                status: 403,
                error: appliedLock.permanent
                  ? 'Account permanently locked after exceeding the maximum loss limit (MLL).'
                  : `Account locked for DLL breach until ${appliedLock.lockedUntil}.`,
                lock: appliedLock
              });
            });
          }

          const requestedMargin = Number(margin_used);
          if (!isForex && requestedMargin > account.current_balance) {
            return callback({ status: 400, error: `Insufficient available balance ($${account.current_balance.toFixed(2)} available).` });
          }
          const maxQuoteAgeMs = getMarketQuoteMaxAgeMs(market);
          Promise.all([
            getAuthoritativePrice(market, maxQuoteAgeMs),
            getLiveForexQuoteToUsdRate(market, maxQuoteAgeMs)
          ]).then(([marketPrice, quoteToUsdRate]) => {
            const slippage = isForex ? 0 : market.source === 'BITGET_PERP' ? marketPrice * 0.0005 : 5;
            const executionPrice = orderType === 'LIMIT'
              ? limitTriggerPrice
              : marketPrice + (side === 'BUY' ? slippage : -slippage);
            const forexSize = isForex
              ? calculateForexMargin(lotSize, executionPrice, leverage, quoteToUsdRate, market.lot_units)
              : null;
            const margin = isForex ? forexSize.marginUsd : requestedMargin;
            const units = isForex ? forexSize.units : Number(size_usd) / executionPrice;
            if (margin > account.current_balance) {
              return callback({ status: 400, error: `Insufficient available balance ($${account.current_balance.toFixed(2)} available).` });
            }
            let levels;
            try {
              levels = isForex
                ? resolveForexStopTargetPrices({
                    executionPrice,
                    units,
                    quoteToUsdRate,
                    pipSize: market.pip_size,
                    side,
                    mode: order.sl_tp_mode,
                    sl: order.sl,
                    tp: order.tp,
                    slAmount: order.sl_amount,
                    tpAmount: order.tp_amount
                  })
                : resolveStopTargetPrices({
                    executionPrice,
                    units,
                    side,
                    mode: order.sl_tp_mode,
                    sl: order.sl,
                    tp: order.tp,
                    slAmount: order.sl_amount,
                    tpAmount: order.tp_amount
                  });
            } catch (levelError) {
              return callback({ status: 400, error: levelError.message });
            }
            const { sl: stopLoss, tp: takeProfit } = levels;
            const tradeId = `trd_${crypto.randomBytes(8).toString('hex')}`;
            const tradeStatus = orderType === 'LIMIT' ? 'PENDING' : 'OPEN';
            db.serialize(() => {
              db.run('BEGIN IMMEDIATE', beginErr => {
                if (beginErr) return callback({ status: 500, error: 'Unable to reserve account balance.' });
                const rollback = (status, error) => db.run('ROLLBACK', () => callback({ status, error }));
                const freezeHedgingAccounts = conflictingTrades => {
                  const conflictingSide = side === 'BUY' ? 'SELL' : 'BUY';
                  const accountIds = [...new Set([accountId, ...conflictingTrades.map(trade => trade.account_id)])];
                  const reason = `Hedging detected on ${symbol}; review the admin alert and support ticket before unfreezing.`;
                  const freezeNext = index => {
                    if (index >= accountIds.length) {
                      return db.run(
                        `INSERT INTO hedging_alerts
                         (wallet_address, symbol, attempted_account_id, attempted_side, conflicting_side)
                         VALUES (?, ?, ?, ?, ?)`,
                        [walletAddress, symbol, accountId, side, conflictingSide],
                        function(alertErr) {
                          if (alertErr) return rollback(500, 'Unable to record the hedging alert.');
                          const alertId = this.lastID;
                          const alertAccounts = [
                            { account_id: accountId, trade_id: null, position_side: side },
                            ...conflictingTrades.map(trade => ({
                              account_id: trade.account_id,
                              trade_id: trade.trade_id,
                              position_side: trade.side
                            }))
                          ];
                          const insertNext = index => {
                            if (index >= alertAccounts.length) {
                              return db.run('COMMIT', commitErr => {
                                if (commitErr) return callback({ status: 500, error: 'Unable to commit hedging alert.' });
                                callback({
                                  status: 409,
                                  error: `Hedging is not allowed. An opposite ${conflictingSide} position in ${symbol} was found on another account. The involved accounts have been frozen and an admin alert was created.`,
                                  hedging_violation: true
                                });
                              });
                            }
                            const item = alertAccounts[index];
                            db.run(
                              `INSERT INTO hedging_alert_accounts (alert_id, account_id, trade_id, position_side)
                               VALUES (?, ?, ?, ?)`,
                              [alertId, item.account_id, item.trade_id, item.position_side],
                              insertErr => {
                                if (insertErr) return rollback(500, 'Unable to record hedging alert account details.');
                                insertNext(index + 1);
                              }
                            );
                          };
                          insertNext(0);
                        }
                      );
                    }
                    db.run(
                      `UPDATE accounts SET admin_frozen = 1,
                       admin_freeze_reason = CASE WHEN admin_frozen = 1 THEN admin_freeze_reason ELSE ? END
                       WHERE id = ? AND LOWER(wallet_address) = LOWER(?)`,
                      [reason, accountIds[index], walletAddress],
                      function(freezeErr) {
                        if (freezeErr) return rollback(500, 'Unable to freeze accounts involved in the hedge.');
                        if (this.changes !== 1) return rollback(409, 'An involved account changed during hedging review.');
                        freezeNext(index + 1);
                      }
                    );
                  };
                  freezeNext(0);
                };
                db.all(
                  `SELECT t.id AS trade_id, t.account_id, t.side
                   FROM trades t
                   JOIN accounts a ON a.id = t.account_id
                   WHERE LOWER(a.wallet_address) = LOWER(?) AND t.account_id != ?
                     AND t.symbol = ? AND t.side = ? AND t.status = 'OPEN'`,
                  [walletAddress, accountId, symbol, side === 'BUY' ? 'SELL' : 'BUY'],
                  (hedgeErr, conflictingTrades) => {
                    if (hedgeErr) return rollback(500, 'Unable to verify opposite open positions.');
                    if (conflictingTrades?.length) return freezeHedgingAccounts(conflictingTrades);
                    db.run(
                      `UPDATE accounts SET current_balance = current_balance - ?
                       WHERE id = ? AND current_balance >= ? AND status = 'ACTIVE' AND admin_frozen = 0
                       AND NOT EXISTS (SELECT 1 FROM withdrawals WHERE account_id = ? AND status = 'PENDING')
                       AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.wallet_address) = LOWER(accounts.wallet_address)
                                       AND COALESCE(u.admin_suspended, 0) = 1)`,
                      [margin, accountId, margin, accountId],
                      function(updateErr) {
                        if (updateErr) {
                          return db.run('ROLLBACK', () => callback({ status: 500, error: 'Unable to reserve account balance.' }));
                        }
                        if (this.changes !== 1) {
                          return db.get(
                            'SELECT admin_suspend_reason FROM users WHERE LOWER(wallet_address) = LOWER(?) AND admin_suspended = 1',
                            [account.wallet_address],
                            (suspensionErr, suspendedUser) => db.run('ROLLBACK', () => {
                              if (suspensionErr) return callback({ status: 500, error: 'Unable to verify user account access.' });
                              if (suspendedUser) {
                                return callback({
                                  status: 403,
                                  error: `This user account is suspended by an administrator${suspendedUser.admin_suspend_reason ? `: ${suspendedUser.admin_suspend_reason}` : '.'}`,
                                  user_suspended: true
                                });
                              }
                              callback({ status: 409, error: 'Account balance or status changed. Refresh and retry.' });
                            })
                          );
                        }
                        db.run(
                          `INSERT INTO trades
                           (id, account_id, symbol, market_type, side, entry_price, order_type, trigger_price,
                            size_usd, units, lot_size, pip_size, sl, tp, status, leverage)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                          [tradeId, accountId, symbol, isForex ? 'FOREX' : 'CRYPTO', side, executionPrice, orderType, tradeStatus === 'PENDING' ? limitTriggerPrice : null, margin, units, lotSize, isForex ? market.pip_size : null, stopLoss, takeProfit, tradeStatus, leverage],
                          insertErr => {
                            if (insertErr) return db.run('ROLLBACK', () => callback({ status: 500, error: 'Unable to create trade.' }));
                            db.run('COMMIT', commitErr => {
                              if (commitErr) return callback({ status: 500, error: 'Unable to commit trade.' });
                              callback(null, { success: true, trade_id: tradeId, execution_price: executionPrice, trigger_price: tradeStatus === 'PENDING' ? limitTriggerPrice : null, sl: stopLoss, tp: takeProfit, order_type: orderType, status: tradeStatus, lot_size: lotSize, margin_used: margin });
                            });
                          }
                        );
                      }
                    );
                  }
                );
              });
            });
          }).catch(priceError => {
            console.error('Unable to obtain trade execution price:', priceError.message);
            callback({ status: 503, error: 'Unable to obtain a fresh market price. Please retry.' });
          });
        });
      });
    }
  );
}

app.post('/api/trades/execute', sensitiveLimiter, requireWalletSession, walletActionLimiter, requireWalletNotSoftLocked, requireUserNotSuspended, (req, res) => {
  const { account_id: accountId, symbol, side, price, size_usd: sizeUsd, margin_used: marginUsed, leverage, sl, tp } = req.body || {};
  const slTpMode = req.body?.sl_tp_mode || 'price';
  const slAmount = req.body?.sl_amount == null ? null : Number(req.body.sl_amount);
  const tpAmount = req.body?.tp_amount == null ? null : Number(req.body.tp_amount);
  const orderType = String(req.body?.order_type || '').toUpperCase();
  const triggerPrice = req.body?.trigger_price == null ? null : Number(req.body.trigger_price);
  const lotSize = req.body?.lot_size == null ? null : Number(req.body.lot_size);
  const market = supportedMarkets.find(item => item.symbol === symbol);
  const isForex = market?.asset_class === 'FOREX';
  const numericFields = isForex
    ? [price, sizeUsd, marginUsed, leverage, lotSize]
    : [price, sizeUsd, marginUsed, leverage];
  if (!accountId || !market || market.enabled === false || !['BUY', 'SELL'].includes(side) ||
      !['MARKET', 'LIMIT'].includes(orderType) ||
      !(isForex ? ['pips', 'amount'] : ['price', 'amount']).includes(slTpMode) ||
      numericFields.some(value => !Number.isFinite(Number(value)) || Number(value) <= 0) ||
      !Number.isInteger(Number(leverage)) || Number(leverage) > 50 ||
      (!isForex && Math.abs(Number(sizeUsd) - Number(marginUsed) * Number(leverage)) > 0.01) ||
      (orderType === 'LIMIT' && (!Number.isFinite(triggerPrice) || Number(triggerPrice) <= 0)) ||
      (sl != null && (!Number.isFinite(Number(sl)) || Number(sl) <= 0)) ||
      (tp != null && (!Number.isFinite(Number(tp)) || Number(tp) <= 0)) ||
      (slTpMode === 'amount' && (
        (slAmount != null && (!Number.isFinite(slAmount) || slAmount <= 0)) ||
        (tpAmount != null && (!Number.isFinite(tpAmount) || tpAmount <= 0))
      ))) return res.status(400).json({ error: 'Invalid trade parameters.' });
  if (copyFlatteningWallets.has(req.walletAddress)) {
    return res.status(409).json({ error: 'Copy-trading emergency stop is in progress. Wait before opening another trade.' });
  }
  const accountTradeRequestKey = `${req.walletAddress.toLowerCase()}:${accountId}`;
  if (inFlightAccountTradeRequests.has(accountTradeRequestKey)) {
    return res.status(409).json({ error: 'A trade request for this account is already processing. Wait for it to finish before submitting another.' });
  }
  inFlightAccountTradeRequests.add(accountTradeRequestKey);
  let accountTradeRequestReleased = false;
  const releaseAccountTradeRequest = () => {
    if (accountTradeRequestReleased) return;
    accountTradeRequestReleased = true;
    inFlightAccountTradeRequests.delete(accountTradeRequestKey);
  };
  res.once('finish', releaseAccountTradeRequest);
  res.once('close', releaseAccountTradeRequest);
  const releaseExecution = trackTradeExecution(req.walletAddress, res);
  const respond = (status, body) => {
    releaseExecution();
    return res.status(status).json(body);
  };

  const order = {
    symbol, side, size_usd: Number(sizeUsd), margin_used: Number(marginUsed), leverage: Number(leverage),
    lot_size: lotSize,
    order_type: orderType, trigger_price: orderType === 'LIMIT' ? triggerPrice : null,
    sl_tp_mode: slTpMode, sl: sl == null ? null : Number(sl), tp: tp == null ? null : Number(tp),
    sl_amount: slAmount, tp_amount: tpAmount
  };
  db.get(
    `SELECT g.id FROM trade_copy_groups g
     JOIN trade_copy_group_members m ON m.group_id = g.id
     WHERE m.account_id = ? AND m.role = 'LEADER' AND g.active = 1
       AND LOWER(g.wallet_address) = LOWER(?)`,
    [accountId, req.walletAddress],
    (groupErr, activeGroup) => {
      if (groupErr) return respond(500, { error: 'Unable to check active copy-trading group.' });
      executeTradeForAccount(accountId, order, req.walletAddress, (leaderErr, leaderTrade) => {
        if (leaderErr) return respond(leaderErr.status, {
          error: leaderErr.error,
          lock: leaderErr.lock,
          user_suspended: leaderErr.user_suspended,
          hedging_violation: leaderErr.hedging_violation
        });
        if (!activeGroup) return respond(200, leaderTrade);
        db.run(
          'INSERT INTO trade_copy_leader_trades (leader_trade_id, group_id) VALUES (?, ?)',
          [leaderTrade.trade_id, activeGroup.id],
          leaderMarkErr => {
            if (leaderMarkErr) {
              console.error('Unable to mark copy-trading leader trade:', leaderMarkErr.message);
              return respond(200, { ...leaderTrade, copy_error: 'Leader trade opened, but copy tracking could not be saved.' });
            }
            db.all(
              `SELECT m.account_id, m.size_pct FROM trade_copy_group_members m
               WHERE m.group_id = ? AND m.role = 'FOLLOWER' ORDER BY m.rowid`,
              [activeGroup.id],
              (followersErr, followers) => {
                if (followersErr) {
                  console.error('Unable to load copy-trading followers:', followersErr.message);
                  return respond(200, { ...leaderTrade, copy_error: 'Leader trade opened, but follower accounts could not be loaded.' });
                }
                const results = [];
                const copyNext = index => {
                  if (index >= followers.length) {
                    return respond(200, { ...leaderTrade, copy_group_id: activeGroup.id, copy_results: results });
                  }
                  const follower = followers[index];
                  const ratio = Number(follower.size_pct) / 100;
                  const followerMargin = order.margin_used * ratio;
                  const followerOrder = {
                    ...order,
                    margin_used: followerMargin,
                    size_usd: followerMargin * order.leverage,
                    ...(isForex ? { lot_size: order.lot_size * ratio } : {})
                  };
                  if (order.sl_tp_mode === 'amount') {
                    followerOrder.sl_amount = order.sl_amount == null ? null : order.sl_amount * ratio;
                    followerOrder.tp_amount = order.tp_amount == null ? null : order.tp_amount * ratio;
                  }
                  if (!Number.isFinite(followerOrder.margin_used) || !Number.isFinite(followerOrder.size_usd) ||
                      followerOrder.margin_used <= 0 || followerOrder.size_usd <= 0) {
                    results.push({ account_id: follower.account_id, success: false, error: 'Follower size percentage results in an invalid order size.' });
                    return copyNext(index + 1);
                  }
                  executeTradeForAccount(follower.account_id, followerOrder, req.walletAddress, (followerErr, followerTrade) => {
                    if (followerErr) {
                      results.push({
                        account_id: follower.account_id,
                        success: false,
                        error: followerErr.error,
                        hedging_violation: followerErr.hedging_violation
                      });
                      return copyNext(index + 1);
                    }
                    db.run(
                      `INSERT INTO trade_copy_links (leader_trade_id, follower_trade_id, group_id)
                       VALUES (?, ?, ?)`,
                      [leaderTrade.trade_id, followerTrade.trade_id, activeGroup.id],
                      linkErr => {
                        if (linkErr) {
                          console.error('Unable to link copied trade:', linkErr.message);
                          results.push({
                            account_id: follower.account_id,
                            success: false,
                            trade_id: followerTrade.trade_id,
                            error: 'Follower trade opened, but its copy link could not be saved.'
                          });
                        } else {
                          results.push({
                            account_id: follower.account_id,
                            success: true,
                            trade_id: followerTrade.trade_id,
                            execution_price: followerTrade.execution_price
                          });
                        }
                        copyNext(index + 1);
                      }
                    );
                  });
                };
                copyNext(0);
              }
            );
          }
        );
      });
    }
  );
});

function closeTradeForWallet(tradeId, walletAddress, callback, options = {}) {
  db.get(
    `SELECT t.*, a.wallet_address, a.current_equity, a.daily_starting_balance,
     a.status AS account_status, a.lock_reason, a.locked_until, a.permanent_lock
     FROM trades t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ? AND t.status IN ('OPEN', 'PENDING')`,
    [tradeId],
    (err, trade) => {
      if (err) return callback({ status: 500, error: 'Unable to load trade.' });
      if (!trade) return callback({ status: 404, error: 'Open trade not found.' });
      if (trade.wallet_address.toLowerCase() !== walletAddress) {
        return callback({ status: 403, error: 'Wallet does not own this trade.' });
      }

      refreshRiskBaselines(trade.account_id, (baselineErr, refreshedAccount) => {
      if (baselineErr) return callback({ status: 500, error: 'Unable to update daily account baselines.' });
      const account = {
        id: trade.account_id,
        current_equity: refreshedAccount.current_equity,
        risk_balance: refreshedAccount.risk_balance,
        daily_starting_balance: refreshedAccount.daily_starting_balance,
        status: refreshedAccount.status,
        lock_reason: refreshedAccount.lock_reason,
        locked_until: refreshedAccount.locked_until,
        permanent_lock: refreshedAccount.permanent_lock
      };
      unlockExpiredAccount(account, (unlockErr) => {
        if (unlockErr) return callback({ status: 500, error: 'Unable to refresh account lock status.' });
        const market = getTradeMarket(trade.symbol);
        if (!market) return callback({ status: 409, error: 'The trade market is no longer configured.' });
        const overridePrice = Number(options.exitPrice);
        const pricePromise = trade.status === 'PENDING'
          ? Promise.resolve(Number(trade.entry_price))
          : Number.isFinite(overridePrice) && overridePrice > 0
            ? Promise.resolve(overridePrice)
            : getAuthoritativePrice(market);
        const conversionPromise = trade.status === 'PENDING'
          ? Promise.resolve(1)
          : getLiveForexQuoteToUsdRate(market);
        Promise.all([pricePromise, conversionPromise]).then(([price, quoteToUsdRate]) => {
        const pnl = trade.status === 'PENDING'
          ? 0
          : calculateUnrealizedPnl(trade, price, quoteToUsdRate);
        const returnedMargin = getTradeMargin(trade) + pnl;
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE');
          db.run(
            `UPDATE trades SET status = 'CLOSED', pnl = ?, closed_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = ?`,
            [pnl, tradeId, trade.status],
            function(updateErr) {
              if (updateErr || this.changes !== 1) {
                return db.run('ROLLBACK', () => callback({ status: 409, error: 'Trade was already closed.' }));
              }
              db.run(
                `UPDATE accounts SET current_balance = current_balance + ?, current_equity = current_equity + ?
                 WHERE id = ?`,
                [returnedMargin, pnl, trade.account_id],
                (balanceErr) => {
                  if (balanceErr) return db.run('ROLLBACK', () => callback({ status: 500, error: 'Unable to settle trade.' }));
                  loadAccountWithLiveRisk(trade.account_id, (accountErr, account) => {
                      if (accountErr || !account) return db.run('ROLLBACK', () => callback({ status: 500, error: 'Unable to verify account limits.' }));
                      const breach = getRiskBreach(account, account);
                      const activeLock = breach || getActiveLock(account);
                      const commit = (lock = null, riskBreachSettled = false) => db.run('COMMIT', (commitErr) => {
                        if (commitErr) return callback({ status: 500, error: 'Unable to commit trade settlement.' });
                        callback(null, {
                          success: true,
                          pnl,
                          lock,
                          trade_id: tradeId,
                          ...(riskBreachSettled ? { risk_breach_settled: true } : {})
                        });
                      });
                      if (!breach) return commit(activeLock);
                      settleBreachWithinTransaction(account, breach, (lockErr, appliedLock) => {
                        if (lockErr) return db.run('ROLLBACK', () => callback({ status: 500, error: 'Unable to apply account lock.' }));
                        commit({
                          reason: appliedLock.reason,
                          permanent: appliedLock.permanent,
                          lockedUntil: appliedLock.lockedUntil
                        }, true);
                      });
                    });
                }
              );
            }
          );
        });
        }).catch((priceError) => {
          console.error('Unable to obtain trade closing price:', priceError.message);
          callback({ status: 503, error: 'Unable to obtain a fresh market price. Please retry.' });
        });
      });
      });
    }
  );
}

function closeOutstandingCopyTrades(walletAddress, callback, options = {}) {
  db.all(
    `SELECT l.leader_trade_id, l.follower_trade_id, fa.id AS account_id
     FROM trade_copy_links l
     JOIN trades lt ON lt.id = l.leader_trade_id AND lt.status = 'CLOSED'
     JOIN accounts la ON la.id = lt.account_id AND LOWER(la.wallet_address) = LOWER(?)
     JOIN trades ft ON ft.id = l.follower_trade_id AND ft.status IN ('OPEN', 'PENDING')
     JOIN accounts fa ON fa.id = ft.account_id AND LOWER(fa.wallet_address) = LOWER(?)
     ORDER BY lt.closed_at, ft.created_at`,
    [walletAddress, walletAddress],
    (linksErr, links) => {
      if (linksErr) return callback(linksErr);
      const results = [];
      const closeNext = index => {
        if (index >= links.length) return callback(null, results);
        const linked = links[index];
        const exitPrice = String(linked.leader_trade_id) === String(options.leaderTradeId)
          ? options.exitPrice
          : null;
        closeTradeForWallet(linked.follower_trade_id, walletAddress, (closeErr, closedTrade) => {
          results.push(closeErr?.status === 404
            ? {
                leader_trade_id: linked.leader_trade_id,
                account_id: linked.account_id,
                trade_id: linked.follower_trade_id,
                success: true,
                already_closed: true
              }
            : closeErr
            ? {
                leader_trade_id: linked.leader_trade_id,
                account_id: linked.account_id,
                trade_id: linked.follower_trade_id,
                success: false,
                error: closeErr.error
              }
            : {
                leader_trade_id: linked.leader_trade_id,
                account_id: linked.account_id,
                trade_id: linked.follower_trade_id,
                success: true,
                pnl: closedTrade.pnl
              });
          closeNext(index + 1);
        }, { exitPrice });
      };
      closeNext(0);
    }
  );
}

const stopOrderChecksInProgress = new Set();
let stopOrderSweepInProgress = false;
function checkServerStopOrders() {
  if (stopOrderSweepInProgress) return;
  stopOrderSweepInProgress = true;
  db.all(
    `SELECT t.id, t.symbol, t.side, t.sl, t.tp, t.sl_tp_mode, a.wallet_address
     FROM trades t JOIN accounts a ON a.id = t.account_id
     WHERE t.status = 'OPEN' AND (t.sl IS NOT NULL OR t.tp IS NOT NULL)`,
    [],
    (err, trades) => {
      if (err) {
        stopOrderSweepInProgress = false;
        console.error('Unable to load open stop orders:', err.message);
        return;
      }
      const triggeredTrades = [];
      for (const trade of trades) {
        if (stopOrderChecksInProgress.has(trade.id)) continue;
        const market = getTradeMarket(trade.symbol);
        if (!market) continue;
        try {
          const price = marketDataService.getQuote(market.symbol, getMarketQuoteMaxAgeMs(market)).price;
          const exitPrice = getTriggeredExitPrice({ price, side: trade.side, sl: trade.sl, tp: trade.tp });
          if (exitPrice !== null) {
            triggeredTrades.push({
              ...trade,
              exitPrice: trade.sl_tp_mode === 'amount' ? exitPrice : null
            });
          }
        } catch {
          // A stale quote cannot safely trigger a stop; fresh execution prices are required to settle.
        }
      }

      const closeNext = index => {
        if (index >= triggeredTrades.length) {
          stopOrderSweepInProgress = false;
          return;
        }
        const trade = triggeredTrades[index];
        stopOrderChecksInProgress.add(trade.id);
        closeTradeForWallet(trade.id, trade.wallet_address.toLowerCase(), closeErr => {
          if (closeErr && closeErr.status !== 404) {
            console.error(`Unable to execute stop order for trade ${trade.id}:`, closeErr.error);
          }
          if (!closeErr) {
            closeOutstandingCopyTrades(trade.wallet_address, copyErr => {
              if (copyErr) console.error('Unable to close copied trades after stop execution:', copyErr.message);
              stopOrderChecksInProgress.delete(trade.id);
              closeNext(index + 1);
            }, { leaderTradeId: trade.id, exitPrice: trade.exitPrice });
          } else {
            stopOrderChecksInProgress.delete(trade.id);
            closeNext(index + 1);
          }
        }, { exitPrice: trade.exitPrice });
      };
      closeNext(0);
    }
  );
}

setTimeout(checkServerStopOrders, 2000);
setInterval(checkServerStopOrders, 1000);

app.post('/api/trades/close', sensitiveLimiter, requireWalletSession, (req, res) => {
  const tradeId = req.body?.trade_id;
  if (typeof tradeId !== 'string' || !tradeId) return res.status(400).json({ error: 'Trade ID is required.' });
  closeTradeForWallet(tradeId, req.walletAddress, (closeErr, closedTrade) => {
    if (closeErr) return res.status(closeErr.status).json({ error: closeErr.error });
    closeOutstandingCopyTrades(req.walletAddress, (linksErr, copyResults) => {
      if (linksErr) {
        console.error('Unable to close linked copy trades:', linksErr.message);
        return res.json({ ...closedTrade, copy_close_error: 'Trade closed, but copied follower positions could not be checked.' });
      }
      res.json({
        ...closedTrade,
        ...(copyResults.length ? { copy_close_results: copyResults } : {})
      });
    });
  });
});

app.post('/api/trade-copy/flatten', sensitiveLimiter, requireWalletSession, (req, res) => {
  const wallet = req.walletAddress;
  if (copyFlatteningWallets.has(wallet)) {
    return res.status(409).json({ error: 'A copy-trading emergency stop is already in progress.' });
  }
  copyFlatteningWallets.add(wallet);
  let flattenFinished = false;
  const releaseFlattening = () => {
    if (flattenFinished) return;
    flattenFinished = true;
    copyFlatteningWallets.delete(wallet);
  };
  res.once('finish', releaseFlattening);
  waitForTradeExecutions(wallet, () => {
    db.run(
      'UPDATE trade_copy_groups SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE LOWER(wallet_address) = LOWER(?)',
      [wallet],
      disableErr => {
        if (disableErr) {
          releaseFlattening();
          return res.status(500).json({ error: 'Unable to pause copy groups before flattening.' });
        }
        db.all(
    `SELECT DISTINCT t.id AS trade_id, a.id AS account_id
     FROM trades t
     JOIN accounts a ON a.id = t.account_id
     WHERE t.status IN ('OPEN', 'PENDING') AND LOWER(a.wallet_address) = LOWER(?)
       AND (EXISTS (SELECT 1 FROM trade_copy_leader_trades l WHERE l.leader_trade_id = t.id)
            OR EXISTS (SELECT 1 FROM trade_copy_links c WHERE c.follower_trade_id = t.id))
     ORDER BY a.created_at, t.created_at`,
    [wallet],
    (tradesErr, trades) => {
      if (tradesErr) {
        releaseFlattening();
        return res.status(500).json({ error: 'Unable to load open copy trades.' });
      }
      const results = [];
      const closeNext = index => {
        if (index >= trades.length) {
          const failed = results.filter(result => !result.success);
          releaseFlattening();
          return res.json({
            success: failed.length === 0,
            groups_deactivated: true,
            closed: results.length - failed.length,
            failed,
            results
          });
        }
        const trade = trades[index];
        closeTradeForWallet(trade.trade_id, wallet, (closeErr, closedTrade) => {
          if (closeErr?.status === 404) {
            results.push({ account_id: trade.account_id, trade_id: trade.trade_id, success: true, already_closed: true });
            return closeNext(index + 1);
          }
          if (closeErr) {
            results.push({ account_id: trade.account_id, trade_id: trade.trade_id, success: false, error: closeErr.error });
            return closeNext(index + 1);
          }
          closeOutstandingCopyTrades(wallet, (linksErr, copyResults) => {
            const failedCopies = (copyResults || []).filter(result => !result.success);
            results.push({
              account_id: trade.account_id, trade_id: trade.trade_id, success: true, pnl: closedTrade.pnl,
              ...(linksErr ? { warning: 'Trade closed, but linked follower positions could not be checked.' } : {}),
              ...(failedCopies.length ? { warning: 'Some linked follower positions remain open.' } : {})
            });
            closeNext(index + 1);
          });
        });
      };
      closeNext(0);
    }
        );
      }
    );
  });
});

function findEligibleChatAccount(walletAddress, callback) {
  db.all(
    'SELECT id FROM accounts WHERE LOWER(wallet_address) = LOWER(?) ORDER BY created_at, id',
    [walletAddress],
    (accountsErr, accounts) => {
      if (accountsErr) return callback(accountsErr);
      const checkNext = (index) => {
        if (index >= accounts.length) return callback(null, false);
        const accountId = accounts[index].id;
        refreshRiskBaselines(accountId, (baselineErr, account) => {
          if (baselineErr) return callback(baselineErr);
          refreshAccountLock(account, (lockErr) => {
            if (lockErr) return callback(lockErr);
            const eligible = account.status === 'ACTIVE' &&
              !account.lock_reason &&
              Number(account.permanent_lock) !== 1 &&
              Number(account.admin_frozen) !== 1 &&
              Number(account.pending_withdrawal_amount || 0) <= 0;
            if (eligible) return callback(null, true);
            checkNext(index + 1);
          });
        });
      };
      checkNext(0);
    }
  );
}

app.get('/api/chat/messages', (req, res) => {
  const symbol = req.query.symbol;
  const market = supportedMarkets.find(item => item.symbol === symbol && item.enabled !== false);
  if (!market) return res.status(400).json({ error: 'Select a configured market to view its chat.' });

  db.all(
    `SELECT c.id,
       COALESCE(NULLIF(u.username, ''), 'Trader') AS username,
     COALESCE(NULLIF(u.discount_code, ''), '') AS referral_code,
     COALESCE(b.xp, 0) AS battlepass_xp, COALESCE(b.points, 0) AS battlepass_points, b.profile_image_url,
     COALESCE((SELECT SUM(w.amount) FROM withdrawals w WHERE LOWER(w.wallet_address) = LOWER(c.wallet_address) AND w.status = 'PAID'), 0)
       + COALESCE((SELECT SUM(rw.amount) FROM referral_withdrawals rw WHERE LOWER(rw.wallet_address) = LOWER(c.wallet_address) AND rw.status = 'PAID'), 0) AS total_payouts,
     c.body, c.created_at
     FROM public_chat_messages c
     LEFT JOIN users u ON LOWER(u.wallet_address) = LOWER(c.wallet_address)
     LEFT JOIN battlepass_users b ON LOWER(b.wallet_address) = LOWER(c.wallet_address)
     WHERE c.market_symbol = ?
     ORDER BY c.id DESC
     LIMIT 100`,
    [market.symbol],
    (err, messages) => {
      if (err) return res.status(500).json({ error: 'Unable to load public chat.' });
      res.json({
        messages: (messages || []).reverse().map(message => ({
          ...message,
          battlepass_level: getBattlePassLevel(message.battlepass_xp)
        }))
      });
    }
  );
});

app.post('/api/chat/messages', sensitiveLimiter, requireWalletSession, requireUserNotSuspended, (req, res) => {
  const { symbol, message: rawMessage } = req.body || {};
  const market = supportedMarkets.find(item => item.symbol === symbol && item.enabled !== false);
  if (!market) return res.status(400).json({ error: 'Select a configured market before posting.' });
  const moderated = moderateChatMessage(rawMessage);
  if (!moderated.valid) return res.status(400).json({ error: moderated.error });

  findEligibleChatAccount(req.walletAddress, (eligibilityErr, eligible) => {
    if (eligibilityErr) {
      console.error('Unable to verify public chat account eligibility:', eligibilityErr.message);
      return res.status(503).json({ error: 'Unable to verify account eligibility. Please retry.' });
    }
    if (!eligible) {
      return res.status(403).json({ error: 'Posting requires an active, unlocked trading account with no admin freeze or pending withdrawal.' });
    }

    db.run(
      `INSERT INTO public_chat_messages (market_symbol, wallet_address, body)
       SELECT ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM public_chat_messages
         WHERE wallet_address = ?
           AND datetime(created_at) > datetime('now', ?)
       )`,
      [market.symbol, req.walletAddress, moderated.message, req.walletAddress, `-${CHAT_COOLDOWN_MS / 1000} seconds`],
      function(insertErr) {
        if (insertErr) {
          console.error('Unable to save public chat message:', insertErr.message);
          return res.status(500).json({ error: 'Unable to send your chat message.' });
        }
        if (this.changes === 0) {
          return db.get(
            `SELECT created_at FROM public_chat_messages
             WHERE wallet_address = ?
             ORDER BY id DESC LIMIT 1`,
            [req.walletAddress],
            (recentErr, recentMessage) => {
              if (recentErr) return res.status(500).json({ error: 'Unable to check the chat posting limit.' });
              const lastSentAt = recentMessage
                ? Date.parse(`${recentMessage.created_at.replace(' ', 'T')}Z`)
                : Date.now();
              const retryAfter = Math.max(1, Math.ceil((lastSentAt + CHAT_COOLDOWN_MS - Date.now()) / 1000));
              res.set('Retry-After', String(retryAfter));
              res.status(429).json({
                error: 'Slow mode is on: you can send one message per minute.',
                retry_after_seconds: retryAfter
              });
            }
          );
        }
        db.get(
          `SELECT c.id,
             COALESCE(NULLIF(u.username, ''), 'Trader') AS username,
             COALESCE(NULLIF(u.discount_code, ''), '') AS referral_code,
             COALESCE(b.xp, 0) AS battlepass_xp, COALESCE(b.points, 0) AS battlepass_points, b.profile_image_url,
             COALESCE((SELECT SUM(w.amount) FROM withdrawals w WHERE LOWER(w.wallet_address) = LOWER(c.wallet_address) AND w.status = 'PAID'), 0)
               + COALESCE((SELECT SUM(rw.amount) FROM referral_withdrawals rw WHERE LOWER(rw.wallet_address) = LOWER(c.wallet_address) AND rw.status = 'PAID'), 0) AS total_payouts,
             c.body, c.created_at
           FROM public_chat_messages c
           LEFT JOIN users u ON LOWER(u.wallet_address) = LOWER(c.wallet_address)
           LEFT JOIN battlepass_users b ON LOWER(b.wallet_address) = LOWER(c.wallet_address)
           WHERE c.id = ?`,
          [this.lastID],
          (messageErr, savedMessage) => {
            if (messageErr) return res.status(500).json({ error: 'Your chat message could not be confirmed.' });
            res.status(201).json({
              message: savedMessage && {
                ...savedMessage,
                battlepass_level: getBattlePassLevel(savedMessage.battlepass_xp)
              }
            });
          }
        );
      }
    );
  });
});

app.get('/api/trades/active', requireWalletSession, (req, res) => {
  const accountId = req.query.account_id;
  const wallet = req.query.wallet;
  if (!accountId || typeof wallet !== 'string' || !ethers.isAddress(wallet) || wallet.toLowerCase() !== req.walletAddress) {
    return res.status(403).json({ error: 'Wallet session does not match the requested trades.' });
  }

  db.get("SELECT wallet_address FROM accounts WHERE id = ?", [accountId], (accountErr, account) => {
    if (accountErr) return res.status(500).json({ error: 'Unable to load account.' });
    if (!account || account.wallet_address.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).json({ error: 'Wallet does not own this account.' });
    }
    refreshRiskBaselines(accountId, (baselineErr, liveAccount) => {
      if (baselineErr) return res.status(503).json({ error: 'Unable to calculate live account risk.' });
      refreshAccountLock(liveAccount, (lockErr, lock) => {
        if (lockErr) return res.status(500).json({ error: 'Unable to apply account risk lock.' });
        res.json({
          trades: liveAccount.open_trades || [],
          risk_balance: getRiskBalance(liveAccount),
          lock: lock || getActiveLock(liveAccount),
          account_status: liveAccount.status,
          lock_reason: liveAccount.lock_reason
        });
      });
    });
  });
});

app.get('/api/forex/candles', sensitiveLimiter, requireWalletSession, chartLimiter, requireWalletNotSoftLocked, (req, res) => {
  const market = getTradeMarket(String(req.query.symbol || ''));
  if (!market || market.asset_class !== 'FOREX') {
    return res.status(400).json({ error: 'Choose a supported Forex market.' });
  }
  const timeframe = String(req.query.timeframe || '1m');
  if (!forexChartTimeframes[timeframe]) {
    return res.status(400).json({ error: 'Choose a supported Forex chart timeframe.' });
  }
  getForexChartHistory(market, timeframe)
    .then(history => res.json(history))
    .catch(error => {
      console.warn(`Unable to load Yahoo Finance Forex history for ${market.pair}:`, error.message);
      res.status(502).json({ error: 'Unable to load Forex chart history. Live pricing is still available.' });
    });
});

function streamMarketData(req, res, filter = () => true, walletAddress) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  const client = {
    res,
    filter,
    walletAddress,
    heartbeat: setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
    }, 20000)
  };
  marketPriceStreamClients.add(client);
  for (const quote of marketDataService.getLatestQuotes()) {
    if (filter(quote)) res.write(`data: ${JSON.stringify(quote)}\n\n`);
  }
  let removed = false;
  const removeClient = () => {
    if (removed) return;
    removed = true;
    clearInterval(client.heartbeat);
    marketPriceStreamClients.delete(client);
  };
  client.close = () => {
    removeClient();
    if (!res.destroyed && !res.writableEnded) res.end();
  };
  req.on('close', removeClient);
  res.on('close', removeClient);
}

function disconnectMarketDataStreams(walletAddress) {
  for (const client of marketPriceStreamClients) {
    if (client.walletAddress === walletAddress) client.close();
  }
}

app.get('/api/market-data/stream', sensitiveLimiter, requireWalletSession, chartLimiter, requireWalletNotSoftLocked, (req, res) => {
  streamMarketData(req, res, () => true, req.walletAddress);
});

app.get('/api/forex/stream', sensitiveLimiter, requireWalletSession, chartLimiter, requireWalletNotSoftLocked, (req, res) => {
  streamMarketData(req, res, quote => quote.assetClass === 'FOREX', req.walletAddress);
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`Blastrr server running on port ${PORT}`);
});
