const test = require('node:test');
const assert = require('node:assert/strict');
const { performanceScore, pickMatchMvp } = require('../src/services/matchService');

test('calculates MVP by performance score', () => {
  const mvp = pickMatchMvp([
    { steamId: '2', kills: 10, deaths: 10, assists: 0, headshots: 0, damage: 1000, mvps: 0, firstKills: 0, clutches: 0 },
    { steamId: '1', kills: 12, deaths: 8, assists: 2, headshots: 4, damage: 1200, mvps: 1, firstKills: 1, clutches: 1 }
  ]);
  assert.equal(mvp.steamId, '1');
  assert.equal(performanceScore(mvp), 36);
});

test('MVP tie breaker prefers damage, kills, fewer deaths, then steam ID', () => {
  assert.equal(pickMatchMvp([
    { steamId: 'b', kills: 1, deaths: 1, assists: 0, headshots: 0, damage: 100, mvps: 0, firstKills: 0, clutches: 0 },
    { steamId: 'a', kills: 1, deaths: 1, assists: 0, headshots: 0, damage: 100, mvps: 0, firstKills: 0, clutches: 0 }
  ]).steamId, 'a');
});

test('MVP tie breaker prefers higher damage', () => {
  assert.equal(pickMatchMvp([
    { steamId: '1', kills: 1, deaths: 1, assists: 0, headshots: 0, damage: 200, mvps: 0, firstKills: 0, clutches: 0 },
    { steamId: '2', kills: 1, deaths: 1, assists: 0, headshots: 0, damage: 100, mvps: 0, firstKills: 0, clutches: 0 }
  ]).steamId, '1');
});

test('MVP tie breaker prefers more kills then fewer deaths', () => {
  assert.equal(pickMatchMvp([
    { steamId: '1', kills: 2, deaths: 3, assists: 0, headshots: 0, damage: 100, mvps: 0, firstKills: 0, clutches: 0 },
    { steamId: '2', kills: 1, deaths: 1, assists: 0, headshots: 0, damage: 100, mvps: 0, firstKills: 0, clutches: 0 }
  ]).steamId, '1');
});
