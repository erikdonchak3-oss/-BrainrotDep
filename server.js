const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || '').trim();
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN) console.warn('BOT_TOKEN is not configured; Telegram API authentication will be unavailable.');
if (!ADMIN_TELEGRAM_ID) console.warn('ADMIN_TELEGRAM_ID is not configured; admin access is disabled.');
if (!DATABASE_URL) console.warn('DATABASE_URL is not configured; persistent storage is unavailable.');

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 5
}) : null;

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname, { extensions: ['html'] }));

async function ensureDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revision BIGINT NOT NULL DEFAULT 1
    )
  `);
  await pool.query('ALTER TABLE players ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1');
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData || initData.length > 8192) {
    throw Object.assign(new Error('Telegram authorization required'), { status: 401 });
  }
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw Object.assign(new Error('Invalid Telegram signature'), { status: 401 });
  }
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const providedHash = Buffer.from(receivedHash, 'hex');
  if (providedHash.length !== calculatedHash.length || !crypto.timingSafeEqual(providedHash, calculatedHash)) {
    throw Object.assign(new Error('Invalid Telegram signature'), { status: 401 });
  }
  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > 86400) {
    throw Object.assign(new Error('Telegram session expired. Reopen the Mini App.'), { status: 401 });
  }
  let user;
  try { user = JSON.parse(params.get('user') || '{}'); } catch (_) {}
  if (!user || !/^\d{1,20}$/.test(String(user.id || ''))) {
    throw Object.assign(new Error('Telegram user not found'), { status: 401 });
  }
  return {
    id: String(user.id),
    username: typeof user.username === 'string' ? user.username.slice(0, 64) : null,
    firstName: typeof user.first_name === 'string' ? user.first_name.slice(0, 128) : null
  };
}

async function telegramAuth(req, res, next) {
  try {
    if (!pool) throw Object.assign(new Error('Database is not configured on the server'), { status: 503 });
    const initData = req.get('x-telegram-init-data') || '';
    req.telegramUser = verifyTelegramInitData(initData);
    req.isAdmin = Boolean(ADMIN_TELEGRAM_ID && req.telegramUser.id === ADMIN_TELEGRAM_ID);
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'Unauthorized' });
  }
}
function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access denied' });
  next();
}
function cleanState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Invalid player state'), { status: 400 });
  }
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^brainrotdep-[a-z0-9-]{1,80}$/i.test(key)) continue;
    const serialized = JSON.stringify(value);
    if (serialized.length > 180000) continue;
    output[key] = value;
  }
  if (Object.keys(output).length > 100) {
    throw Object.assign(new Error('Too many state fields'), { status: 400 });
  }
  if (output['brainrotdep-tokens'] !== undefined) {
    const tokens = Number(output['brainrotdep-tokens']);
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > 1_000_000_000) {
      throw Object.assign(new Error('Invalid token balance'), { status: 400 });
    }
    output['brainrotdep-tokens'] = String(tokens);
  }
  if (output['brainrotdep-collection'] !== undefined) {
    const collection = output['brainrotdep-collection'];
    if (!Array.isArray(collection) || collection.length > 500) {
      throw Object.assign(new Error('Invalid character collection'), { status: 400 });
    }
  }
  return output;
}
async function getPlayer(id) {
  const result = await pool.query('SELECT telegram_id, username, first_name, state, created_at, updated_at, revision FROM players WHERE telegram_id = $1', [id]);
  return result.rows[0] || null;
}

app.get('/health', (_req, res) => res.status(200).json({ ok: true, app: 'BrainrotDep' }));

app.get('/api/state', telegramAuth, async (req, res, next) => {
  try {
    let player = await getPlayer(req.telegramUser.id);
    const isNew = !player;
    if (!player) {
      const inserted = await pool.query(
        `INSERT INTO players (telegram_id, username, first_name)
         VALUES ($1, $2, $3) ON CONFLICT (telegram_id) DO NOTHING
         RETURNING telegram_id, username, first_name, state, created_at, updated_at`,
        [req.telegramUser.id, req.telegramUser.username, req.telegramUser.firstName]
      );
      player = inserted.rows[0] || await getPlayer(req.telegramUser.id);
    }
    res.json({ state: player.state || {}, revision: Number(player.revision || 1), isNew, isAdmin: req.isAdmin, telegramId: req.telegramUser.id });
  } catch (err) { next(err); }
});

app.put('/api/state', telegramAuth, async (req, res, next) => {
  try {
    const state = cleanState(req.body && req.body.state);
    const expectedRevision = Number(req.body && req.body.revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return res.status(400).json({ error: 'Missing player state revision' });
    }
    const updated = await pool.query(
      `UPDATE players SET username=$2, first_name=$3, state=$4::jsonb,
         updated_at=NOW(), revision=revision+1
       WHERE telegram_id=$1 AND revision=$5
       RETURNING revision`,
      [req.telegramUser.id, req.telegramUser.username, req.telegramUser.firstName, JSON.stringify(state), expectedRevision]
    );
    if (!updated.rowCount) return res.status(409).json({ error: 'Player data changed in another session. Reloading latest saved progress is required.' });
    res.json({ ok: true, revision: Number(updated.rows[0].revision) });
  } catch (err) { next(err); }
});

app.get('/api/admin/me', telegramAuth, adminOnly, (req, res) => {
  res.json({ ok: true, telegramId: req.telegramUser.id });
});

app.get('/api/admin/player/:id', telegramAuth, adminOnly, async (req, res, next) => {
  try {
    if (!/^\d{1,20}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid Telegram ID' });
    const player = await getPlayer(req.params.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const state = player.state || {};
    res.json({
      telegramId: String(player.telegram_id),
      username: player.username,
      firstName: player.first_name,
      tokens: Number(state['brainrotdep-tokens'] || 0),
      collection: Array.isArray(state['brainrotdep-collection']) ? state['brainrotdep-collection'] : [],
      stats: Object.fromEntries(Object.entries(state).filter(([key]) => key.startsWith('brainrotdep-stat-'))),
      updatedAt: player.updated_at,
      revision: Number(player.revision || 1)
    });
  } catch (err) { next(err); }
});

app.patch('/api/admin/player/:id/tokens', telegramAuth, adminOnly, async (req, res, next) => {
  try {
    const id = req.params.id;
    const amount = Number(req.body && req.body.amount);
    if (!/^\d{1,20}$/.test(id) || !Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000_000) {
      return res.status(400).json({ error: 'Enter a valid non-zero token amount' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT state FROM players WHERE telegram_id=$1 FOR UPDATE', [id]);
      if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Player not found' }); }
      const state = found.rows[0].state || {};
      const current = Number(state['brainrotdep-tokens'] || 0);
      const next = current + amount;
      if (!Number.isSafeInteger(next) || next < 0 || next > 1_000_000_000) {
        await client.query('ROLLBACK'); return res.status(400).json({ error: 'Balance would be outside allowed limits' });
      }
      state['brainrotdep-tokens'] = String(next);
      await client.query('UPDATE players SET state=$2::jsonb, updated_at=NOW(), revision=revision+1 WHERE telegram_id=$1', [id, JSON.stringify(state)]);
      await client.query('COMMIT');
      res.json({ ok: true, tokens: next });
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch (err) { next(err); }
});

app.post('/api/admin/player/:id/characters', telegramAuth, adminOnly, async (req, res, next) => {
  try {
    const id = req.params.id;
    const name = String(req.body && req.body.name || '').trim().slice(0, 100);
    const rarity = String(req.body && req.body.rarity || 'Brainrot').trim().slice(0, 40);
    if (!/^\d{1,20}$/.test(id) || !name) return res.status(400).json({ error: 'Enter a character name' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT state FROM players WHERE telegram_id=$1 FOR UPDATE', [id]);
      if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Player not found' }); }
      const state = found.rows[0].state || {};
      const collection = Array.isArray(state['brainrotdep-collection']) ? state['brainrotdep-collection'] : [];
      if (collection.length >= 500) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Player collection is full' }); }
      collection.push({ name, rarity, type: 'brainrot', addedAt: Date.now(), adminGranted: true });
      state['brainrotdep-collection'] = collection;
      await client.query('UPDATE players SET state=$2::jsonb, updated_at=NOW(), revision=revision+1 WHERE telegram_id=$1', [id, JSON.stringify(state)]);
      await client.query('COMMIT');
      res.json({ ok: true, collection });
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch (err) { next(err); }
});

app.delete('/api/admin/player/:id/characters/:index', telegramAuth, adminOnly, async (req, res, next) => {
  try {
    const id = req.params.id;
    const index = Number(req.params.index);
    if (!/^\d{1,20}$/.test(id) || !Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid player or character index' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT state FROM players WHERE telegram_id=$1 FOR UPDATE', [id]);
      if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Player not found' }); }
      const state = found.rows[0].state || {};
      const collection = Array.isArray(state['brainrotdep-collection']) ? state['brainrotdep-collection'] : [];
      if (index >= collection.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Character not found' }); }
      collection.splice(index, 1);
      state['brainrotdep-collection'] = collection;
      await client.query('UPDATE players SET state=$2::jsonb, updated_at=NOW(), revision=revision+1 WHERE telegram_id=$1', [id, JSON.stringify(state)]);
      await client.query('COMMIT');
      res.json({ ok: true, collection });
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch (err) { next(err); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error('Request failed:', err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
});

ensureDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`BrainrotDep listening on ${PORT}`));
}).catch(err => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});
