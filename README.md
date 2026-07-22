# TRUST Backend

Backend for TRUST matchmaking: Steam login, sessions, party system, 2x2 queue, match room, leaderboard, game-server sync, and result submission.

## What was hardened in this build

- Fixed UUID handling in Steam auth exchange. User IDs are UUID strings, not numbers.
- Fixed `authToken.js` UUID handling and token TTL config.
- Added `.env.example`.
- Added basic production hardening with Helmet.
- Added in-memory rate limiting for global/auth/party/launcher/internal routes.
- Added weak internal-token rejection in production mode.
- Added safer default server token config through `DEFAULT_SERVER_TOKEN`.
- Fixed result config so the game plugin can map Team A/B from real player SteamID64 and live CT/T sides.
- Added `DEPLOY_NOTES.md` and `Dockerfile`.

## Backend env

Copy `.env.example` to `.env` and fill real values.

Important production values:

```env
NODE_ENV=production
TRUST_PRODUCTION_MODE=true
SESSION_SECRET=<openssl rand -hex 32>
DEFAULT_SERVER_TOKEN=<64+ random chars, same as sm_trust_server_token>
COOKIE_SECURE=true
```

## Run

```bash
npm install
npm start
```

## Frontend

In the frontend, set `frontend-config.js`:

```js
window.TRUST_BACKEND_BASE_URL = 'https://YOUR-BACKEND-DOMAIN';
```

## Game server

Set the same token in SourceMod cfg:

```cfg
sm_trust_api_base "https://YOUR-BACKEND-DOMAIN"
sm_trust_server_token "same_64_plus_char_token_as_backend"
```

See `DEPLOY_NOTES.md` for the full checklist.

## TRUST Match Center API

### Server authorization

Game-server callbacks use the existing internal route namespace and must include the trusted server token:

```http
X-Server-Token: <server_instances.server_token>
```

The backend validates the token against `server_instances`; production mode rejects obvious development tokens. Do not expose this token to clients or log it.

### Submit match result

```http
POST /internal/server/result
Content-Type: application/json
X-Server-Token: <server token>
```

Extended payload accepted from the SourceMod plugin:

```json
{
  "matchId": "match-id",
  "winnerTeam": "A",
  "teamAScore": 13,
  "teamBScore": 9,
  "map": "de_lake",
  "durationSeconds": 1540,
  "serverId": "server-1",
  "players": [
    {
      "steamId": "76561198000000001",
      "team": "A",
      "kills": 19,
      "deaths": 12,
      "assists": 5,
      "headshots": 8,
      "damage": 1684,
      "mvps": 4,
      "firstKills": 3,
      "clutches": 1
    }
  ],
  "rounds": [
    {
      "roundNumber": 1,
      "winnerTeam": "A",
      "reason": "elimination",
      "teamAScore": 1,
      "teamBScore": 0,
      "durationSeconds": 76
    }
  ]
}
```

Legacy payload remains supported during migration:

```json
{
  "matchId": "match-id",
  "winnerTeam": "A",
  "teamAScore": 13,
  "teamBScore": 9,
  "map": "de_lake"
}
```

Optional extended fields default safely: missing player stats are stored as zero, missing rounds are not inserted, and missing duration stays `null`. Elo is calculated only on the backend. Re-submitting an already finished `matchId` returns a successful idempotent response such as:

```json
{ "ok": true, "alreadyFinished": true, "duplicate": true, "resultSource": "server_plugin" }
```

Validation errors use HTTP 400 with `{ "ok": false, "error": "<code>" }`; invalid server tokens use HTTP 401. Common error codes include `match_not_found`, `match_cancelled`, `match_not_live`, `server_mismatch`, `invalid_score`, `winner_score_mismatch`, `player_not_in_match`, `duplicate_player`, `player_team_mismatch`, and `invalid_player_stats`.

SourceMod-style example:

```sourcepawn
Handle request = SteamWorks_CreateHTTPRequest(k_EHTTPMethodPOST, "https://api.example.com/internal/server/result");
SteamWorks_SetHTTPRequestHeaderValue(request, "X-Server-Token", g_ServerToken);
SteamWorks_SetHTTPRequestHeaderValue(request, "Content-Type", "application/json");
SteamWorks_SetHTTPRequestRawPostBody(request, "application/json", jsonPayload, strlen(jsonPayload));
SteamWorks_SendHTTPRequest(request);
```

### Match details

```http
GET /api/matches/:matchId
```

Returns match metadata, teams, score, map, duration, server, per-player Steam ID/nickname/avatar/rank/Elo before and after/Elo delta/statistics/MVP flag, and round history.

### Player match history

```http
GET /api/players/:steamId/matches?page=1&limit=20
```

Returns paginated finished matches for the Steam ID with result, score, map, duration, Elo delta, and compact stats.

### Player aggregate stats

```http
GET /api/players/:steamId/stats
```

Returns total matches, wins, losses, winrate, kills, deaths, assists, K/D, average damage per match, average damage per round when round data exists, headshot rate, match MVP count, current streak, best win streak, current Elo, and per-map statistics. Players without completed matches receive zero-safe values.

### Match Center storage migration

Apply the latest schema updates before deploying the SourceMod plugin changes. The schema adds `matches.duration_seconds`, per-player stat columns on `match_players`, and the `match_rounds` table with a unique `(match_id, round_number)` constraint.
