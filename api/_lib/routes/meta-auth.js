// GET /api/auth/meta — start the Facebook Page connect flow.
// The user must already be signed in to Wasipy. Redirects to Meta's
// login dialog, where they pick which Page(s) to share. Their Facebook
// password never reaches Wasipy — Meta returns only a code.
const crypto = require('node:crypto');
const { sign, b64urlJson } = require('../crypto');
const { getSession } = require('../session');
const { authUrl } = require('../meta');

module.exports = async (req, res) => {
  const { returnTo = '/' } = req.query || {};
  const session = getSession(req);
  if (!session) {
    res.writeHead(302, { Location: '/?signin=required' });
    return res.end();
  }
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Facebook connect is not set up yet (missing META_APP_ID / META_APP_SECRET).' }));
  }

  const stateObj = {
    action: 'connect-meta',
    returnTo: typeof returnTo === 'string' && returnTo.startsWith('/') ? returnTo : '/',
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  };
  const data = b64urlJson(stateObj);
  const state = `${data}.${sign(data)}`;

  res.writeHead(302, { Location: authUrl(state) });
  res.end();
};
