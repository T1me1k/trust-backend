# TRUST Backend v2

Improved Railway-ready backend for TRUST.

## Features
- Steam OpenID login
- Account/profile API
- Party create/invite/accept/leave/disband
- Queue 2x2
- Matchmaking job
- Current match/history/leaderboard
- Simple Elo: start 100, win +25, loss -25
- Launcher link code endpoints
- Internal match result endpoint for server plugin

## Start
1. Import `sql/schema.sql` into PostgreSQL
2. Fill env vars from `.env.example`
3. `npm install`
4. `npm start`

## Main routes
- `GET /health`
- `GET /config`
- `GET /auth/steam`
- `GET /auth/steam/callback`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /api/account/me`
- `GET /api/account/me/history`
- `GET /api/users/search?q=`
- `POST /api/party/create`
- `GET /api/party/me`
- `POST /api/party/invite`
- `POST /api/party/invite/:id/accept`
- `POST /api/party/invite/:id/decline`
- `POST /api/party/leave`
- `POST /api/party/disband`
- `GET /api/queue/me`
- `POST /api/queue/join`
- `POST /api/queue/cancel`
- `GET /api/matches/me/current`
- `GET /api/matches/me/history`
- `GET /api/leaderboard?mode=2x2`
- `POST /internal/server/result`
- `POST /launcher/link/start`
- `POST /launcher/link/consume`

## Notes
- Nickname comes from Steam persona name.
- Site and launcher should treat backend as source of truth.
- Rotate any secrets that were exposed in screenshots.
