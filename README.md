# BrainrotDep — Telegram Mini App

## Files
- `index.html` — existing game interface and mechanics, with Telegram account state synchronization.
- `server.js` — Express API, Telegram `initData` verification, PostgreSQL persistence and protected admin endpoints.
- `admin.html` — admin interface; all data operations are checked by the server.
- `package.json` — Express and PostgreSQL dependencies.
- `render.yaml` — Render web service configuration.

## Render setup

1. Create a PostgreSQL database in Render.
2. Copy its **Internal Database URL** (when the web service and database are in the same Render region) into the web service Environment as `DATABASE_URL`.
3. Set these Environment Variables on the web service:
   - `BOT_TOKEN` — Telegram bot token. Keep it private; never put it in `index.html` or GitHub.
   - `ADMIN_TELEGRAM_ID` — your numeric Telegram user ID (not your bot ID).
   - `DATABASE_URL` — Render PostgreSQL connection URL.
   - `NODE_ENV` — `production`.
4. Deploy with Build Command `npm install` and Start Command `npm start`.
5. Check `https://YOUR-DOMAIN/health`; it should return `{ "ok": true, "app": "BrainrotDep" }`.
6. Open the Mini App from the Telegram bot. Reopen it after deployment to establish a fresh Telegram session.

The server creates the `players` table automatically on startup.

## Admin panel

Open `https://YOUR-DOMAIN/admin.html` from the Telegram Mini App. The server validates Telegram's signed `initData` on every admin request and compares the authenticated Telegram ID with `ADMIN_TELEGRAM_ID`. Hiding the page is not the security boundary: the API itself rejects non-admin users.

Features:
- Search a player by exact Telegram ID.
- Add or remove tokens (use a positive or negative integer).
- Grant a character by name and rarity.
- Remove a character from the player's inventory.

## Persistence notes / next hardening step

The state row uses a revision counter to prevent an older open tab from silently overwriting newer server/admin changes. On a conflict the client reloads the latest server state. The current game mechanics still run in the existing browser code. The Mini App synchronizes the existing `brainrotdep-*` local state to PostgreSQL, preserving the current UI and mechanics. Telegram identity and admin operations are verified on the server.

**Important:** because the original case-opening, upgrade, promo and reward logic is client-side, this first persistence layer is not yet an anti-cheat economy. A technically skilled player can modify browser storage or make client-side state changes. Before treating tokens/characters as competitive or valuable, move every balance- and inventory-changing game action (case opening, sale, upgrade, daily reward, promo redemption) to server-side transactional API endpoints. That is the next hardening phase; do not treat browser-side state as trusted.

## Data safety

- Back up the PostgreSQL database before major deployments.
- Do not commit `.env` files or bot tokens.
- If a bot token was ever exposed, rotate it with BotFather.
