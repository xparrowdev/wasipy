// /api/calendar/upcoming — the signed-in user's upcoming calendar events,
// plus schedule alerts. GET — { ok, connected, events, notify }.
// `events`: up to 10 timed events starting in the next 12 hours, for the
// "Up next" panel. `notify`: events starting within 15 minutes, or just
// started, that have not been alerted yet — each alert is claimed here
// (one row per user + event + start + level), so the website and the
// desktop app can both poll without ever notifying twice. All-day events
// (no start time) are listed but never alerted.
const { getSession } = require('../session');
const { getDb } = require('../mongo');
const { serviceClient, apiFor } = require('../google');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'Not signed in' });
  const userId = String(session.userId);
  const auth = await serviceClient(userId, 'calendar');
  if (!auth) return json(res, 200, { ok: true, connected: false, events: [], notify: [] });
  const cal = apiFor('calendar', auth);
  const now = new Date();
  const end = new Date(now.getTime() + 12 * 3600 * 1000);
  let items = [];
  try {
    const r = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10,
    });
    items = r.data.items || [];
  } catch (e) {
    return json(res, 200, { ok: true, connected: true, events: [], notify: [] });
  }
  const events = items
    .filter((e) => e.start && e.start.dateTime)
    .map((e) => ({
      id: e.id,
      title: e.summary || '(no title)',
      start: e.start.dateTime,
      end: (e.end && e.end.dateTime) || '',
      location: e.location || '',
    }));
  // Claim alerts: '15' = starts within 15 minutes, 'now' = just started.
  const notify = [];
  try {
    const db = await getDb();
    const col = db.collection('eventNotifs');
    await col.deleteMany({ userId, at: { $lt: new Date(now.getTime() - 2 * 24 * 3600 * 1000) } });
    for (const e of events) {
      const mins = (new Date(e.start).getTime() - now.getTime()) / 60000;
      const level = mins <= 0 ? (mins >= -2 ? 'now' : null) : (mins <= 15 ? '15' : null);
      if (!level) continue;
      const r = await col.updateOne(
        { userId, eventId: e.id, start: e.start, level },
        { $setOnInsert: { userId, eventId: e.id, start: e.start, level, at: now } },
        { upsert: true }
      );
      if (r.upsertedCount === 1) notify.push({ id: e.id, title: e.title, start: e.start, level });
    }
  } catch (e) {
    // Alert claiming failed — still return the events for display.
  }
  return json(res, 200, { ok: true, connected: true, events, notify });
};
