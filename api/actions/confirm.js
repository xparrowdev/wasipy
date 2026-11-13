// POST /api/actions/confirm — the Yes/No answer to a pending write action.
// { actionId, confirm: true } runs the write (only now, only once).
// { actionId, confirm: false } cancels it — nothing is written.
const { getSession } = require('../_lib/session');
const { getDb, logActivity } = require('../_lib/mongo');
const { executeWrite } = require('../_lib/tools');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'Not signed in' });

  const body = await readBody(req);
  const { actionId, confirm } = body;
  if (!actionId) return json(res, 400, { error: 'Missing actionId' });

  const db = await getDb();
  const pending = await db.collection('pendingActions').findOne({
    userId: String(session.userId),
    actionId,
    status: 'pending',
  });
  if (!pending) return json(res, 404, { error: 'That action is no longer waiting (already answered or expired).' });

  if (!confirm) {
    await db.collection('pendingActions').updateOne(
      { _id: pending._id },
      { $set: { status: 'cancelled', answeredAt: new Date() } }
    );
    return json(res, 200, { ok: true, cancelled: true, result: 'Cancelled — nothing was changed.' });
  }

  // Mark executed BEFORE running, so a double-click cannot run it twice.
  await db.collection('pendingActions').updateOne(
    { _id: pending._id },
    { $set: { status: 'executed', answeredAt: new Date() } }
  );

  const result = await executeWrite(session.userId, pending.tool, pending.args);
  if (result.ok) {
    await logActivity(session.userId, result.log || pending.summary);
    await db.collection('messages').insertOne({
      userId: String(session.userId),
      chatId: 'main',
      role: 'assistant',
      content: `Done ✓\n${result.text}`,
      createdAt: new Date(),
    });
    return json(res, 200, { ok: true, result: `Done ✓\n${result.text}` });
  }
  return json(res, 200, { ok: false, result: result.text });
};
