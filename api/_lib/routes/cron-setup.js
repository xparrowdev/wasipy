// GET /api/cron/setup — signed-in users only. Returns this user's personal
// cron URL for email reminders: paste it into a free scheduler
// (e.g. cron-job.org) set to every 5 minutes, and due reminders arrive by
// email even when the Wasipy tab is closed. The URL carries an HMAC token
// that only works for this user.
const { getSession } = require('../session');
const { sign } = require('../crypto');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const session = getSession(req);
  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'Not signed in' }));
  }
  const host = req.headers.host || 'wasipy.vercel.app';
  const userId = String(session.userId);
  const token = sign('cron:' + userId);
  const cronUrl = `https://${host}/api/cron/reminders?user=${encodeURIComponent(userId)}&token=${token}`;
  return res.end(JSON.stringify({ cronUrl }));
};
