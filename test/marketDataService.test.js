const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MarketDataService } = require('../marketDataService');

test('market data streams remain subscribed until the response closes', () => {
  const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = serverJs.indexOf('function streamMarketData(');
  const end = serverJs.indexOf('function disconnectMarketDataStreams(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const streamHandler = serverJs.slice(start, end);
  const cryptoStreamRouteStart = serverJs.indexOf("app.get('/api/market-data/stream'");
  const cryptoStreamRouteEnd = serverJs.indexOf('\n', cryptoStreamRouteStart);
  const cryptoStreamRoute = serverJs.slice(cryptoStreamRouteStart, cryptoStreamRouteEnd);

  assert.match(streamHandler, /res\.on\('close', removeClient\)/);
  assert.doesNotMatch(streamHandler, /req\.on\('close', removeClient\)/);
  assert.match(cryptoStreamRoute, /requireWalletSession, chartLimiter, requireWalletNotSoftLocked/);
  assert.doesNotMatch(cryptoStreamRoute, /sensitiveLimiter/);
});

test('market data service groups instruments and fans each provider quote into a shared snapshot', () => {
  const providerGroups = [];
  const providers = {
    BINANCE_SPOT: {
      start(markets, publish) {
        providerGroups.push(markets);
        publish({
          symbol: 'BINANCE:BTCUSDT',
          price: 65000,
          bid: 64999,
          ask: 65001,
          publishedAt: 1000,
          priceChangePercent: 1.25
        });
        return () => {};
      }
    }
  };
  const service = new MarketDataService({
    now: () => 1100,
    markets: [
      { symbol: 'BINANCE:BTCUSDT', pair: 'BTCUSDT', source: 'BINANCE_SPOT', type: 'SPOT' },
      { symbol: 'BINANCE:ETHUSDT', pair: 'ETHUSDT', source: 'BINANCE_SPOT', type: 'SPOT' }
    ],
    providers
  });
  const updates = [];
  service.on('quote', quote => updates.push(quote));

  service.start();

  assert.equal(providerGroups.length, 1);
  assert.equal(providerGroups[0].length, 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].assetClass, 'CRYPTO');
  assert.equal(service.getQuote('BINANCE:BTCUSDT', 500).price, 65000);
  service.stop();
});

test('market data service rejects stale, missing, and out-of-order prices', () => {
  let now = 1000;
  const service = new MarketDataService({
    now: () => now,
    markets: [{ symbol: 'FX:EURUSD', pair: 'EUR/USD', source: 'SWISSQUOTE', asset_class: 'FOREX' }],
    providers: {}
  });

  assert.throws(() => service.getQuote('FX:EURUSD', 30000), /No live market price/);
  assert.equal(service.publish('SWISSQUOTE', {
    symbol: 'FX:EURUSD',
    price: 1.08,
    bid: 1.0799,
    ask: 1.0801,
    publishedAt: 1000
  }), true);
  assert.equal(service.publish('SWISSQUOTE', {
    symbol: 'FX:EURUSD',
    price: 1.07,
    publishedAt: 900
  }), false);
  assert.equal(service.getQuote('FX:EURUSD', 30000).price, 1.08);

  now = 31001;
  assert.throws(() => service.getQuote('FX:EURUSD', 30000), /price .* is stale/);
});
