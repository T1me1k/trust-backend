const crypto = require("crypto");
const config = require("../config");

function b64urlEncode(value) {
  return Buffer.from(String(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "";
  return Buffer.from(normalized + pad, "base64").toString();
}

function sign(value) {
  return crypto.createHmac("sha256", config.sessionSecret).update(String(value)).digest("hex");
}

function createAuthToken(userId) {
  const exp = Date.now() + config.authTokenTtlDays * 24 * 60 * 60 * 1000;
  const payload = JSON.stringify({ userId: Number(userId), exp });
  const encoded = b64urlEncode(payload);
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== "string") return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = sign(encoded);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch (_) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(encoded));
  } catch (_) {
    return null;
  }
  if (!payload || !payload.userId || !payload.exp || Number(payload.exp) < Date.now()) return null;
  return { userId: Number(payload.userId), exp: Number(payload.exp) };
}

module.exports = { createAuthToken, verifyAuthToken };
