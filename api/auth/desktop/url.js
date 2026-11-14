// POST /api/auth/desktop/url — desktop app only.
// Returns the Google sign-in URL for the DESKTOP flow: the app opens it in
// the user's real browser (Chrome) instead of inside the app window, and
// Google redirects back to the app's loopback address
// (http://127.0.0.1:8765/auth/callback).
//
// Body: { action: 'login' | 'connect', service?, redirectUri, session? }
//  - redirectUri must be a loopback address (127.0.0.1) — anything else is
//    rejected, so this endpoint can never be abused to redirect elsewhere.
//  - connect needs a signed-in session (sent in the body, because the app
//    calls this from its main process, not from the web page).
const crypto = require('node:crypto');
const { sign, b64urlJson } = require('../../_lib/crypto');
const { getSession, parseSessionValue } = require('../../_lib/session');
const { SERVICES, authUrl } = require('../../_lib/google');

// Loopback only, fixed path. The port must match exactly what is registered
// in Google Cloud — Web clients match the URI including the port.
const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/;

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
  const body = await readBody(req);
  const { action = 'login', service, redirectUri, session: sessionToken } = body;

  if (typeof redirectUri !== 'string' || !LOOPBACK_RE.test(redirectUri)) {
    return json(res, 400, {
      ok: false,
      error: 'Desktop sign-in needs the loopback redirect (http://127.0.0.1:8765/auth/callback).',
    });
  }

  if (action === 'connect') {
    const session = parseSessionValue(sessionToken) || getSession(req);
    if (!session) {
      return json(res, 401, { ok: false, error: 'Please sign in first, then connect a service.' });
    }
    if (!SERVICES[service]) {
      return json(res, 400, { ok: false, error: `Unknown service: ${service}` });
    }
  } else if (action !== 'login') {
    return json(res, 400, { ok: false, error: `Unknown action: ${action}` });
  }

  // Same signed state as the web flow, plus the loopback redirect so the
  // exchange step uses exactly the URI Google was given.
  const stateObj = {
    action,
    service: service || null,
    redirectUri,
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  };
  const data = b64urlJson(stateObj);
  const state = `${data}.${sign(data)}`;

  const url = authUrl({ action, service, state, redirectUri });
  return json(res, 200, { ok: true, url });
};
