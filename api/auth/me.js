// GET /api/auth/me — who is signed in, and which Google services they have
// connected. Used by the page on load.
const { getSession } = require('../_lib/session');
const { getDb } = require('../_lib/mongo');
const { listConnections, SERVICES } = require('../_lib/google');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const session = getSession(req);
  if (!session) {
    return res.end(JSON.stringify({ user: null, connections: [], services: Object.keys(SERVICES) }));
  }
  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: session.userId });
  const connections = await listConnections(session.userId);
  return res.end(
    JSON.stringify({
      user: user
        ? { name: user.name, email: user.email, picture: user.picture || '' }
        : { name: session.name, email: session.email, picture: '' },
      connections,
      services: Object.keys(SERVICES),
    })
  );
};
