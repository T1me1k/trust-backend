# TRUST Final Backend

Что внутри:
- Steam login
- устойчивый session login
- автоинициализация и авточинка legacy Railway Postgres при старте
- party create / invite / accept / leave / disband
- единый 2x2 queue: соло + пати из двух
- текущий матч / история / leaderboard
- internal result endpoint для server plugin

## Backend env
Смотри `.env.example`.

## Frontend
Во фронте добавлен `frontend-config.js`.
Перед деплоем впиши туда URL своего Railway backend:

```js
window.TRUST_BACKEND_BASE_URL = 'https://YOUR-BACKEND.up.railway.app';
```
