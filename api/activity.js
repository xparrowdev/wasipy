// GET /api/activity — the user's recent activity log (sign-ins, connections,
// actions the agent completed). Per user, newest first.
const { getSession } = require('./_lib/session');
const { getDb } = require('./_lib/mongo');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const session = getSession(req);
  if (!session) return res.end(JSON.stringify({ activity: [] }));
  const db = await getDb();
  const rows = await db
    .collection('actionLog')
    .find({ userId: String(session.userId) })
    .sort({ createdAt: -1 })
    .limit(12)
    .toArray();
  res.end(
    JSON.stringify({
      activity: rows.map((r) => ({ text: r.text, at: r.createdAt })),
    })
  );
};
