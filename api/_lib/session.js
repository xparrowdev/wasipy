// Signed-cookie sessions. No session table needed: the cookie itself carries
// { userId, email, name, exp } and is HMAC-signed, so it cannot be forged.
const { sign, verify, b64urlJson, parseB64urlJson } = require('./crypto');

const COOKIE_NAME = 'wasipy_session';
const SESSION_DAYS = 30;

function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieAttrs(maxAgeSeconds) {
  // Secure is always on: Wasipy runs on https (Vercel). SameSite=lax so the
  // Google OAuth redirect back to us still carries the cookie.
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function createSession(res, user) {
  const payload = {
    userId: String(user._id),
    email: user.email,
    name: user.name || '',
    exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 3600,
  };
  const data = b64urlJson(payload);
  const value = `${data}.${sign(data)}`;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; ${cookieAttrs(SESSION_DAYS * 24 * 3600)}`);
  return payload;
}

function getSession(req) {
  try {
    const raw = parseCookies(req)[COOKIE_NAME];
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot === -1) return null;
    const data = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    if (!verify(data, sig)) return null;
    const payload = parseB64urlJson(data);
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.userId) return null;
    return payload;
  } catch {
    return null;
  }
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttrs(0)}`);
}

module.exports = { createSession, getSession, clearSession, parseCookies };
