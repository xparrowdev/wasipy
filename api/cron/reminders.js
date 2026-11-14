// NOTE: this file is NOT deployed as its own function. Vercel Hobby allows max 12 serverless functions and we have more, so this endpoint is served by api/router.js (see vercel.json rewrites) and this copy is excluded from deploys via .vercelignore. Edit api/_lib/routes/<name>.js instead.
// GET /api/cron/reminders?user=<userId>&token=<token> — send due reminder
// emails. Called by an external scheduler (e.g. cron-job.org, free plan)
// every few minutes, because Vercel's free plan cannot run frequent crons.
// The token is HMAC(userId) from /api/cron/setup — no session needed, and
// only the owner of that URL can trigger their own reminders.
const { getDb } = require('../_lib/mongo');
const { verify } = require('../_lib/crypto');
const { executeWrite } = require('../_lib/tools');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const userId = String(req.query.user || '');
  const token = String(req.query.token || '');
  if (!userId || !verify('cron:' + userId, token)) {
    return json(res, 403, { error: 'Bad token' });
  }

  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: userId });
  if (!user || !user.email) return json(res, 200, { ok: true, sent: 0, note: 'No user email' });

  const due = await db
    .collection('reminders')
    .find({ userId, status: 'pending', when: { $lte: new Date() }, emailedAt: null })
    .sort({ when: 1 })
    .limit(10)
    .toArray();

  let sent = 0;
  for (const r of due) {
    const out = await executeWrite(userId, 'send_email', {
      to: user.email,
      subject: `Reminder: ${r.title}`,
      body: `Hi ${user.name || ''},\n\nThis is your Wasipy reminder:\n\n${r.title}${r.note ? `\n\n${r.note}` : ''}\n\nWasipy`,
    });
    if (out.ok) {
      sent++;
      await db
        .collection('reminders')
        .updateOne({ _id: r._id }, { $set: { emailedAt: new Date() } });
    }
  }
  return json(res, 200, { ok: true, sent, checked: due.length });
};
