# TRUST production checklist

## 1. Backend

1. Copy `.env.example` to `.env` and fill all values.
2. Use a real `SESSION_SECRET` generated with `openssl rand -hex 32`.
3. Use a long unique `DEFAULT_SERVER_TOKEN`; copy the same value into `sm_trust_server_token` on the CS server.
4. Keep `TRUST_PRODUCTION_MODE=true` in production so weak default server tokens are rejected.
5. Run PostgreSQL migrations/schema initialization once before opening the platform publicly.

## 2. Game server cvars

Put these into the server cfg loaded by SourceMod:

```cfg
sm_trust_api_base "https://api.example.com"
sm_trust_server_token "your_64_plus_char_server_token"
sm_trust_rounds_to_win "13"
sm_trust_strict_whitelist "1"
sm_trust_match_poll_seconds "5.0"
```

## 3. Result integrity

`trust_result_backend.sp` now reads the active player list from backend and maps the live CT/T score back to Team A/Team B by checking current connected players' SteamID64 and sides. This fixes the old CT=Team A assumption after knife-round `!switch`.

## 4. Security

The backend now includes:

- Helmet headers.
- In-memory rate limiting for global, auth, party, launcher, and internal routes.
- Production rejection of weak internal server tokens such as `change_me` and `local-dev-token`.
- UUID-safe auth exchange and auth token handling.

For serious public launch, put the backend behind nginx/Caddy with HTTPS and add firewall rules so only the game server can call `/internal/*` when possible.
