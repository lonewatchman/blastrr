const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appJs = fs.readFileSync('public/js/app.js', 'utf8');

test('wallet sign-in reports the API endpoint when the server responds with HTML', () => {
  assert.match(appJs, /async function readApiJson\(response, endpoint\)/);
  assert.match(appJs, /The server returned an HTML page instead of API JSON/);
  assert.match(appJs, /response\.status === 502/);
  assert.match(appJs, /The API server is unavailable; the hosting proxy could not reach the Blastrr backend/);
  assert.match(appJs, /Check that this site routes \/api requests to the running Blastrr API server/);
  assert.match(appJs, /readApiJson\(challengeResponse, '\/api\/auth\/trade-challenge'\)/);
  assert.match(appJs, /readApiJson\(response, '\/api\/auth\/wallet-session'\)/);
});

test('wallet sign-in response parsing preserves JSON API errors', () => {
  assert.match(appJs, /const challengeData = await readApiJson\(challengeResponse, '\/api\/auth\/trade-challenge'\);[\s\S]*?if \(!challengeResponse\.ok\) throw new Error\(challengeData\.error/);
  assert.match(appJs, /const data = await readApiJson\(response, '\/api\/auth\/wallet-session'\);[\s\S]*?if \(!response\.ok\) throw new Error\(data\.error/);
});
