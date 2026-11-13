// Crypto helpers for Wasipy.
// Key idea: we do NOT ask the owner for extra secrets. The encryption and
// session-signing keys are derived (HKDF) from GOOGLE_CLIENT_SECRET, which is
// already set in Vercel and stable across deploys. Different "info" strings
// give independent keys for encryption vs. session signing.
const crypto = require('node:crypto');

function masterSecret() {
  const s = process.env.GOOGLE_CLIENT_SECRET || process.env.SESSION_SECRET || '';
  if (!s) throw new Error('Missing GOOGLE_CLIENT_SECRET (needed to derive app keys)');
  return s;
}

function deriveKey(info) {
  return crypto.hkdfSync('sha256', masterSecret(), 'wasipy-v1', info, 32);
}

// --- Authenticated encryption (AES-256-GCM), for Google refresh tokens ---
function encrypt(plaintext) {
  const key = deriveKey('wasipy-encrypt-v1');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decrypt(encoded) {
  const key = deriveKey('wasipy-encrypt-v1');
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// --- HMAC signing (sessions + OAuth state) ---
function sign(data) {
  const key = deriveKey('wasipy-sign-v1');
  return crypto.createHmac('sha256', key).update(data).digest('base64url');
}

function verify(data, signature) {
  const expected = sign(data);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function parseB64urlJson(str) {
  return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
}

module.exports = { encrypt, decrypt, sign, verify, b64urlJson, parseB64urlJson };
