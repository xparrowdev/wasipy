// /api/connections
// GET    — list this user's connected services
// DELETE — disconnect one service (?service=calendar). The stored token is
//          deleted and revoked at Google, so Wasipy loses access at once.
const { getSession } = require('./_lib/session');
const { logActivity } = require('./_lib/mongo');
const { listConnections, deleteConnection, SERVICES } = require('./_lib/google');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'Not signed in' });

  if (req.method === 'GET') {
    const connections = await listConnections(session.userId);
    return json(res, 200, { connections });
  }

  if (req.method === 'DELETE') {
    const service = req.query.service;
    if (!SERVICES[service]) return json(res, 400, { error: `Unknown service: ${service}` });
    await deleteConnection(session.userId, service);
    await logActivity(session.userId, `Disconnected ${SERVICES[service].label}`);
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'Method not allowed' });
};
