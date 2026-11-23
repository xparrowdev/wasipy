// /api/meta/connections
// GET    — list this user's connected Facebook Pages (never includes tokens)
// DELETE — disconnect one Page (?pageId=...). The stored token is deleted
//          and revoked at Meta, so Wasipy loses access at once.
const { getSession } = require('../session');
const { logActivity } = require('../mongo');
const { listPageConnections, deletePageConnection } = require('../meta');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'Not signed in' });

  if (req.method === 'GET') {
    const pages = await listPageConnections(session.userId);
    return json(res, 200, { pages });
  }

  if (req.method === 'DELETE') {
    const pageId = req.query.pageId;
    if (!pageId) return json(res, 400, { error: 'Missing pageId.' });
    const pages = await listPageConnections(session.userId);
    const page = pages.find((p) => String(p.pageId) === String(pageId));
    if (!page) return json(res, 404, { error: 'That Page is not connected.' });
    await deletePageConnection(session.userId, pageId);
    await logActivity(session.userId, `Disconnected Facebook Page "${page.pageName}"`);
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'Method not allowed' });
};
