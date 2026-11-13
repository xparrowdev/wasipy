// GET /api/auth/google?action=login | action=connect&service=calendar
// Starts the Google OAuth flow. "login" only asks for basic profile.
// "connect" asks for one service's scopes (Calendar, Gmail, Drive, Sheets,
// Docs — each separately) and needs the user to be signed in already.
const crypto = require('node:crypto');
const { sign, b64urlJson } = require('../_lib/crypto');
const { getSession } = require('../_lib/session');
const { SERVICES, authUrl } = require('../_lib/google');

module.exports = async (req, res) => {
  const { action = 'login', service, returnTo = '/' } = req.query || {};

  if (action === 'connect') {
    const session = getSession(req);
    if (!session) {
      res.writeHead(302, { Location: '/?signin=required' });
      return res.end();
    }
    if (!SERVICES[service]) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: `Unknown service: ${service}` }));
    }
  }

  const stateObj = {
    action,
    service: service || null,
    returnTo: typeof returnTo === 'string' && returnTo.startsWith('/') ? returnTo : '/',
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  };
  const data = b64urlJson(stateObj);
  const state = `${data}.${sign(data)}`;

  const url = authUrl({ action, service, state });
  res.writeHead(302, { Location: url });
  res.end();
};
