// NOTE: this file is NOT deployed as its own function. Vercel Hobby allows max 12 serverless functions and we have more, so this endpoint is served by api/router.js (see vercel.json rewrites) and this copy is excluded from deploys via .vercelignore. Edit api/_lib/routes/<name>.js instead.
// POST /api/auth/desktop/exchange — desktop app only.
// Called by the app after Google redirects back to its loopback address with
// an authorization code. Verifies the signed state, exchanges the code for
// tokens, then:
//  - login: creates/updates the user and returns the signed session value so
//    the app can set the cookie in its own session (the browser that signed
//    in is Chrome, not the app, so a Set-Cookie header would land in the
//    wrong place).
//  - connect: stores that service's encrypted refresh token for this user.
//
// Body: { code, state, session? } — session is the app's current session
// value, needed for connect (the app sends it in the body).
const { verify, parseB64urlJson } = require('../../_lib/crypto');
const { getSession, parseSessionValue, buildSessionValue, COOKIE_NAME } = require('../../_lib/session');
const { getDb, logActivity } = require('../../_lib/mongo');
const { exchangeCode, getUserInfo, saveConnection, SERVICES } = require('../../_lib/google');

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
  const { code, state, session: sessionToken } = body;
  if (!code || !state) {
    return json(res, 400, { ok: false, error: 'Missing code from Google. Please try again.' });
  }

  // Verify signed state (CSRF protection + carries action/service/redirect).
  let stateObj;
  try {
    const dot = String(state).lastIndexOf('.');
    const data = String(state).slice(0, dot);
    const sig = String(state).slice(dot + 1);
    if (!verify(data, sig)) {
      return json(res, 400, { ok: false, error: 'Invalid sign-in state. Please try again.' });
    }
    stateObj = parseB64urlJson(data);
    if (stateObj.exp < Math.floor(Date.now() / 1000)) {
      return json(res, 400, { ok: false, error: 'Sign-in expired. Please try again.' });
    }
  } catch {
    return json(res, 400, { ok: false, error: 'Invalid sign-in state. Please try again.' });
  }

  if (typeof stateObj.redirectUri !== 'string' || !LOOPBACK_RE.test(stateObj.redirectUri)) {
    return json(res, 400, { ok: false, error: 'Invalid desktop redirect. Please try again.' });
  }

  let tokens;
  try {
    tokens = await exchangeCode(code, stateObj.redirectUri);
  } catch (e) {
    console.error('desktop: code exchange failed', e);
    return json(res, 400, {
      ok: false,
      error: 'Could not finish the Google sign-in. If Google showed redirect_uri_mismatch, add http://127.0.0.1:8765/auth/callback to the Wasipy OAuth client in Google Cloud.',
    });
  }

  try {
    if (stateObj.action === 'connect') {
      const session = parseSessionValue(sessionToken) || getSession(req);
      if (!session) {
        return json(res, 401, { ok: false, error: 'Please sign in first, then connect a service.' });
      }
      const service = stateObj.service;
      if (!SERVICES[service]) {
        return json(res, 400, { ok: false, error: 'Unknown service.' });
      }
      let info;
      try {
        info = await getUserInfo(tokens);
      } catch (e) {
        console.error('desktop connect: getUserInfo failed', e);
        return json(res, 400, { ok: false, error: 'Could not read your Google profile. Please try again.' });
      }
      try {
        await saveConnection(session.userId, service, tokens, info.email);
      } catch (e) {
        console.error('desktop connect: saveConnection failed', e);
        return json(res, 400, { ok: false, error: 'Could not save this connection (database error). Please try again.' });
      }
      await logActivity(session.userId, `Connected ${SERVICES[service].label} (${info.email})`);
      return json(res, 200, { ok: true, action: 'connect', service });
    }

    // login
    let info;
    try {
      info = await getUserInfo(tokens);
    } catch (e) {
      console.error('desktop login: getUserInfo failed', e);
      return json(res, 400, { ok: false, error: 'Could not read your Google profile. Please try again.' });
    }
    if (!info.id || !info.email) {
      return json(res, 400, { ok: false, error: 'Google did not return an account. Please try again.' });
    }
    const db = await getDb();
    const user = {
      _id: `google:${info.id}`,
      googleId: info.id,
      email: info.email,
      name: info.name || info.email,
      picture: info.picture || '',
      updatedAt: new Date(),
    };
    try {
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: user, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.error('desktop login: user upsert failed', e);
      return json(res, 400, { ok: false, error: 'Could not save your account (database error). Please try again.' });
    }
    const { value, maxAge } = buildSessionValue(user);
    await logActivity(user._id, `Signed in as ${info.email} (desktop)`);
    return json(res, 200, {
      ok: true,
      action: 'login',
      sessionToken: value,
      cookieName: COOKIE_NAME,
      maxAge,
      user: { email: user.email, name: user.name },
    });
  } catch (e) {
    console.error('desktop exchange failed', e);
    return json(res, 500, { ok: false, error: 'Something went wrong finishing the sign-in. Please try again.' });
  }
};
