// GET /api/auth/google/callback — Google redirects back here after the user
// approves (or denies). Verifies the signed state, exchanges the code for
// tokens, then:
//  - login: creates/updates the user, sets the session cookie
//  - connect: stores that service's encrypted refresh token for this user
const { verify, parseB64urlJson } = require('../../_lib/crypto');
const { getSession, createSession } = require('../../_lib/session');
const { getDb, logActivity } = require('../../_lib/mongo');
const { exchangeCode, getUserInfo, saveConnection, SERVICES } = require('../../_lib/google');

function fail(res, message) {
  res.writeHead(302, { Location: `/?error=${encodeURIComponent(message)}` });
  res.end();
}

module.exports = async (req, res) => {
  const { code, state, error } = req.query || {};
  if (error) return fail(res, `Google sign-in was not completed (${error}).`);
  if (!code || !state) return fail(res, 'Missing code from Google. Please try again.');

  // Verify signed state (CSRF protection + carries action/service).
  let stateObj;
  try {
    const dot = String(state).lastIndexOf('.');
    const data = String(state).slice(0, dot);
    const sig = String(state).slice(dot + 1);
    if (!verify(data, sig)) return fail(res, 'Invalid sign-in state. Please try again.');
    stateObj = parseB64urlJson(data);
    if (stateObj.exp < Math.floor(Date.now() / 1000)) {
      return fail(res, 'Sign-in expired. Please try again.');
    }
  } catch {
    return fail(res, 'Invalid sign-in state. Please try again.');
  }

  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch (e) {
    console.error('code exchange failed', e);
    return fail(res, 'Could not finish the Google sign-in. Please try again.');
  }

  try {
    if (stateObj.action === 'connect') {
      const session = getSession(req);
      if (!session) return fail(res, 'Please sign in first, then connect a service.');
      const service = stateObj.service;
      if (!SERVICES[service]) return fail(res, 'Unknown service.');
      const info = await getUserInfo(tokens);
      await saveConnection(session.userId, service, tokens, info.email);
      await logActivity(session.userId, `Connected ${SERVICES[service].label} (${info.email})`);
      res.writeHead(302, { Location: `${stateObj.returnTo}?connected=${service}` });
      return res.end();
    }

    // login
    const info = await getUserInfo(tokens);
    if (!info.id || !info.email) return fail(res, 'Google did not return an account. Please try again.');
    const db = await getDb();
    const user = {
      _id: `google:${info.id}`,
      googleId: info.id,
      email: info.email,
      name: info.name || info.email,
      picture: info.picture || '',
      updatedAt: new Date(),
    };
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: user, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    createSession(res, user);
    await logActivity(user._id, `Signed in as ${info.email}`);
    res.writeHead(302, { Location: stateObj.returnTo || '/' });
    return res.end();
  } catch (e) {
    console.error('callback failed', e);
    return fail(res, 'Something went wrong finishing the sign-in. Please try again.');
  }
};
