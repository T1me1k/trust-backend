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
