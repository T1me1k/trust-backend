import crypto from "crypto";
import { query } from "./db.js";

function generateCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";

  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }

  return out;
}

export async function createLauncherLinkCode({ clientId, nickname }) {
  const code = generateCode(8);

  const result = await query(
    `
    INSERT INTO launcher_link_codes (
      code,
      client_id,
      nickname,
      expires_at
    )
    VALUES (
      $1,
      $2,
      $3,
      NOW() + INTERVAL '10 minutes'
    )
    RETURNING code, client_id, nickname, expires_at
    `,
    [code, clientId, nickname || null]
  );

  return result.rows[0];
}

export async function consumeLauncherLinkCode({ code, userId }) {
  const client = await query("SELECT NOW() as now");
  const now = client.rows[0].now;

  const codeResult = await query(
    `
    SELECT *
    FROM launcher_link_codes
    WHERE code = $1
    LIMIT 1
    `,
    [code]
  );

  const row = codeResult.rows[0];
  if (!row) {
    throw new Error("Invalid link code");
  }

  if (row.consumed_at) {
    throw new Error("Link code already used");
  }

  if (new Date(row.expires_at) < new Date(now)) {
    throw new Error("Link code expired");
  }

  const existingClientLink = await query(
    `
    SELECT *
    FROM launcher_links
    WHERE client_id = $1
    LIMIT 1
    `,
    [row.client_id]
  );

  if (existingClientLink.rows[0]) {
    await query(
      `
      UPDATE launcher_link_codes
      SET consumed_at = NOW(),
          consumed_by_user_id = $2
      WHERE id = $1
      `,
      [row.id, userId]
    );

    return {
      alreadyLinked: true,
      clientId: row.client_id,
      nickname: row.nickname
    };
  }

  await query("BEGIN");
  try {
    await query(
      `
      INSERT INTO launcher_links (
        user_id,
        client_id,
        nickname
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (client_id)
      DO NOTHING
      `,
      [userId, row.client_id, row.nickname]
    );

    await query(
      `
      UPDATE launcher_link_codes
      SET consumed_at = NOW(),
          consumed_by_user_id = $2
      WHERE id = $1
      `,
      [row.id, userId]
    );

    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }

  return {
    alreadyLinked: false,
    clientId: row.client_id,
    nickname: row.nickname
  };
}

export async function getLinkedAccountByClientId(clientId) {
  const result = await query(
    `
    SELECT
      ll.client_id,
      ll.nickname,
      ll.linked_at,
      u.id AS user_id,
      u.steam_id,
      u.persona_name,
      u.profile_url,
      u.avatar_full_url
    FROM launcher_links ll
    JOIN users u ON u.id = ll.user_id
    WHERE ll.client_id = $1
    LIMIT 1
    `,
    [clientId]
  );

  return result.rows[0] || null;
}

export async function cleanupExpiredLinkCodes() {
  await query(
    `
    DELETE FROM launcher_link_codes
    WHERE expires_at < NOW() - INTERVAL '1 day'
    `
  );
}