// /api/reminders — the signed-in user's reminders.
// GET    — { upcoming: [...], due: [...] }. `due` holds reminders that
//          became due in the last 12 hours. It is NOT claimed here:
//          every open client (website, desktop app, phone) notifies
//          once locally, because a server-side claim meant only the
//          first poller — often a background tab or the hidden desktop
//          app — ever showed the notification, and other clients saw
//          nothing. (Found by a live test on 2026-11-22.)
// DELETE — cancel one reminder (?id=<reminder id>).
const { ObjectId } = require('mongodb');
const { getSession } = require('../session');
const { getDb } = require('../mongo');

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
      .find({ userId, status: 'pending', when: { $lte: now, $gte: new Date(now.getTime() - 12 * 3600 * 1000) } })
      .sort({ when: 1 })
      .limit(10)
      .toArray();
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
