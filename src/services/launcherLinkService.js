const crypto = require('crypto');
const { query, withTransaction } = require('../db');

function generateCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function createLauncherLinkCode({ clientId, nickname }) {
  const code = generateCode(8);
  const result = await query(
    `INSERT INTO launcher_link_codes (code, client_id, nickname, expires_at)
     VALUES ($1,$2,$3,NOW() + INTERVAL '10 minutes')
     RETURNING code, client_id, nickname, expires_at`,
    [code, clientId, nickname || null]
  );
  return result.rows[0];
}

async function consumeLauncherLinkCode({ code, userId }) {
  return withTransaction(async (client) => {
    const codeResult = await client.query(`SELECT * FROM launcher_link_codes WHERE code = $1 LIMIT 1 FOR UPDATE`, [code]);
    const row = codeResult.rows[0];
    if (!row) throw new Error('invalid_link_code');
    if (row.consumed_at) throw new Error('link_code_already_used');
    if (new Date(row.expires_at) < new Date()) throw new Error('link_code_expired');

    await client.query(
      `INSERT INTO launcher_links (user_id, client_id, nickname)
       VALUES ($1,$2,$3)
       ON CONFLICT (client_id)
       DO UPDATE SET user_id = EXCLUDED.user_id, nickname = EXCLUDED.nickname`,
      [userId, row.client_id, row.nickname]
    );

    await client.query(
      `UPDATE launcher_link_codes SET consumed_at = NOW(), consumed_by_user_id = $2 WHERE id = $1`,
      [row.id, userId]
    );

    return { clientId: row.client_id, nickname: row.nickname };
  });
}

module.exports = { createLauncherLinkCode, consumeLauncherLinkCode };
