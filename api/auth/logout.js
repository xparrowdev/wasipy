// POST /api/auth/logout — clears the session cookie. (Connected Google
// services stay connected for next sign-in; use Disconnect per service to
// revoke a service's access.)
const { clearSession } = require('../_lib/session');

module.exports = async (req, res) => {
  clearSession(res);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
};
