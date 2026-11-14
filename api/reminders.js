// NOTE: this file is NOT deployed as its own function. Vercel Hobby allows max 12 serverless functions and we have more, so this endpoint is served by api/router.js (see vercel.json rewrites) and this copy is excluded from deploys via .vercelignore. Edit api/_lib/routes/<name>.js instead.
// /api/reminders — the signed-in user's reminders.
// GET    — { upcoming: [...], due: [...] }. Reminders in `due` are marked
//          notified on return, so each one alerts once in the app.
// DELETE — cancel one reminder (?id=<reminder id>).
const { ObjectId } = require('mongodb');
const { getSession } = require('./_lib/session');
const { getDb } = require('./_lib/mongo');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function shape(r) {
  return {
    id: String(r._id),
    title: r.title,
    note: r.note || '',
    when: r.when instanceof Date ? r.when.toISOString() : r.when,
  };
}

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'Not signed in' });
  const db = await getDb();
  const col = db.collection('reminders');
  const userId = String(session.userId);

  if (req.method === 'GET') {
    const now = new Date();
    const upcoming = await col
      .find({ userId, status: 'pending', when: { $gte: now } })
      .sort({ when: 1 })
      .limit(10)
      .toArray();
    const due = await col
      .find({ userId, status: 'pending', when: { $lte: now }, notifiedAt: null })
      .sort({ when: 1 })
      .limit(10)
      .toArray();
    if (due.length) {
      await col.updateMany(
        { _id: { $in: due.map((d) => d._id) } },
        { $set: { notifiedAt: now } }
      );
    }
    return json(res, 200, { upcoming: upcoming.map(shape), due: due.map(shape) });
  }

  if (req.method === 'DELETE') {
    let id;
    try {
      id = new ObjectId(req.query.id);
    } catch {
      return json(res, 400, { error: 'Bad id' });
    }
    const r = await col.updateOne(
      { _id: id, userId, status: 'pending' },
      { $set: { status: 'cancelled' } }
    );
    if (!r.matchedCount) return json(res, 404, { error: 'Reminder not found' });
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'Method not allowed' });
};
