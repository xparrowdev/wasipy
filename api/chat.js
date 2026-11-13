// /api/chat — the agent conversation (one thread per user, chatId "main").
// GET    — recent message history
// POST   — { message, timezone } → runs the agent, saves both messages,
//          returns { reply, pendingAction? }
// DELETE — clear this user's chat history (fresh start)
const { getSession } = require('./_lib/session');
const { getDb } = require('./_lib/mongo');
const { runAgent } = require('./_lib/ai');
const { listConnections } = require('./_lib/google');

const CHAT_ID = 'main';

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
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'Not signed in' });
  const db = await getDb();
  const messages = db.collection('messages');

  if (req.method === 'GET') {
    const rows = await messages
      .find({ userId: String(session.userId), chatId: CHAT_ID })
      .sort({ createdAt: 1 })
      .limit(50)
      .toArray();
    return json(res, 200, {
      messages: rows.map((r) => ({ role: r.role, content: r.content, display: r.display || null })),
    });
  }

  if (req.method === 'DELETE') {
    await messages.deleteMany({ userId: String(session.userId), chatId: CHAT_ID });
    return json(res, 200, { ok: true });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = await readBody(req);
  const text = typeof body.message === 'string' ? body.message.trim() : '';
  if (!text) return json(res, 400, { error: 'Empty message' });
  if (text.length > 4000) return json(res, 400, { error: 'Message too long' });

  const userId = String(session.userId);
  await messages.insertOne({
    userId,
    chatId: CHAT_ID,
    role: 'user',
    content: text,
    createdAt: new Date(),
  });

  const history = await messages
    .find({ userId, chatId: CHAT_ID })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();
  history.reverse();

  // Tell the agent which services are actually connected, so it never guesses
  // ("please connect Gmail" when Gmail is already connected).
  const connections = await listConnections(userId);

  const out = await runAgent({
    userId,
    userMessage: text,
    history: history.map((m) => ({ role: m.role, content: m.content })),
    timezone: body.timezone || 'UTC',
    connectedServices: connections.map((c) => c.service),
  });

  await messages.insertOne({
    userId,
    chatId: CHAT_ID,
    role: 'assistant',
    content: out.reply,
    display: out.display || null,
    createdAt: new Date(),
  });

  return json(res, 200, { reply: out.reply, pendingAction: out.pendingAction || null, display: out.display || null });
};
