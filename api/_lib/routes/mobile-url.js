// POST /api/auth/mobile/url — Android app only.
// Returns the Google sign-in URL for the MOBILE flow: the app opens it in
// the user's real browser (Chrome Custom Tab) instead of its WebView,
// because Google blocks sign-in inside embedded browsers. Google redirects
// back to the normal web callback, which hands the code to the app through
// its deep link (wasipy://auth/callback).
//
// Body: { action: 'login' | 'connect', service? }
//  - connect needs a signed-in session (sent in the body, or as the
//    session cookie — the app's WebView sends cookies with its requests).
const crypto = require('node:crypto');
const { sign, b64urlJson } = require('../crypto');
const { getSession, parseSessionValue } = require('../session');
const { SERVICES, authUrl, redirectUri } = require('../google');

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
  const { action = 'login', service, session: sessionToken } = body;

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

  // Same signed state as the web flow, plus platform:'mobile' so the web
  // callback knows to hand the code back to the app instead of exchanging
  // it. The redirect is the normal web callback — Google redirects there,
  // and the callback bounces to the app's deep link.
  const redirect = redirectUri();
  const stateObj = {
    action,
    service: service || null,
    platform: 'mobile',
    redirectUri: redirect,
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  };
  const data = b64urlJson(stateObj);
  const state = `${data}.${sign(data)}`;

  const url = authUrl({ action, service, state, redirectUri: redirect });
  return json(res, 200, { ok: true, url });
};
