// POST /api/actions/update — edit a still-pending write action before the
// user answers it (e.g. add a description or guests to a meeting on the
// Yes/No card). Only whitelisted fields per tool, only the action's owner,
// only while it is still pending.
const { getSession } = require('../session');
const { getDb } = require('../mongo');
const { summarizeWrite } = require('../tools');

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

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// Returns the merged args, or an error string.
function mergeArgs(tool, current, patch) {
  const next = { ...current };
  if (tool === 'create_calendar_event') {
    if (patch.description !== undefined) {
      if (typeof patch.description !== 'string' || patch.description.length > 2000) {
        return 'Description is too long.';
      }
      next.description = patch.description;
    }
    if (patch.attendees !== undefined) {
      const list = Array.isArray(patch.attendees) ? patch.attendees : [];
      if (list.length > 20 || list.some((e) => !isEmail(e))) {
        return 'Attendees must be valid email addresses (max 20).';
      }
      next.attendees = list.map((e) => e.trim());
    }
    return next;
  }
  if (tool === 'send_email') {
    if (patch.subject !== undefined) {
      if (typeof patch.subject !== 'string' || patch.subject.length > 500) return 'Subject is too long.';
      next.subject = patch.subject;
    }
    if (patch.body !== undefined) {
      if (typeof patch.body !== 'string' || patch.body.length > 10000) return 'Body is too long.';
      next.body = patch.body;
    }
    return next;
  }
  if (tool === 'create_doc') {
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || patch.title.length > 200) return 'Title is too long.';
      next.title = patch.title;
    }
    if (patch.content !== undefined) {
      if (typeof patch.content !== 'string' || patch.content.length > 10000) return 'Content is too long.';
      next.content = patch.content;
    }
    return next;
  }
  return 'This action cannot be edited.';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'Not signed in' });

  const body = await readBody(req);
  const { actionId, args } = body;
  if (!actionId || !args || typeof args !== 'object') {
    return json(res, 400, { error: 'Missing actionId or args' });
  }

  const db = await getDb();
  const pending = await db.collection('pendingActions').findOne({
    userId: String(session.userId),
    actionId,
    status: 'pending',
  });
  if (!pending) return json(res, 404, { error: 'That action is no longer waiting.' });

  const merged = mergeArgs(pending.tool, pending.args || {}, args);
  if (typeof merged === 'string') return json(res, 400, { error: merged });

  const summary = summarizeWrite(pending.tool, merged);
  await db.collection('pendingActions').updateOne(
    { _id: pending._id },
    { $set: { args: merged, summary } }
  );
  return json(res, 200, { ok: true, summary });
};
