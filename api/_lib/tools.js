// The AI agent's tools: what it can DO in the user's Google account.
// Read tools run immediately. Write tools NEVER run from chat directly —
// they create a pending action the user must confirm first (Yes/No).
// Local tools (reminders) run immediately too — they only touch Wasipy's
// own database, never the user's Google account.
const { serviceClient, apiFor } = require('./google');
const { getDb } = require('./mongo');

const READ_TOOLS = [
  {
    name: 'list_calendar_events',
    description: 'List upcoming calendar events. Use days=1 for today.',
    parameters: {
      type: 'object',
      properties: { days: { type: 'number', description: 'How many days ahead to look (default 3)' } },
    },
  },
  {
    name: 'list_recent_emails',
    description: 'List recent unread emails from the inbox with sender and subject.',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'How many emails (default 5, max 10)' } },
    },
  },
  {
    name: 'read_email',
    description: 'Read the full body of one email by its message id.',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string', description: 'Gmail message id from list_recent_emails' } },
      required: ['messageId'],
    },
  },
  {
    name: 'list_recent_drive_files',
    description: 'List the user\'s most recently modified Drive files. Use this whenever the user asks about recent files, latest files, or what is in Drive — never say you cannot list recent files.',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'How many files (default 8, max 15)' } },
    },
  },
  {
    name: 'search_drive_files',
    description: 'Search Drive files by name or words in the name. Results are newest first.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to search for, e.g. "invoice"' } },
      required: ['query'],
    },
  },
  {
    name: 'read_sheet',
    description: 'Read the contents of a spreadsheet, found by name.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheetName: { type: 'string', description: 'Name (or part of the name) of the spreadsheet' },
        range: { type: 'string', description: 'Optional A1 range like "A1:D20". Default: first 30 rows.' },
      },
      required: ['spreadsheetName'],
    },
  },
  {
    name: 'read_doc',
    description: 'Read the text of a Google Doc, found by name.',
    parameters: {
      type: 'object',
      properties: { documentName: { type: 'string', description: 'Name (or part of the name) of the document' } },
      required: ['documentName'],
    },
  },
];

const WRITE_TOOLS = [
  {
    name: 'create_calendar_event',
    description: 'Create a calendar event. Needs user confirmation before running.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start time as ISO 8601 with timezone offset, e.g. 2026-11-14T10:00:00+06:00' },
        end: { type: 'string', description: 'End time as ISO 8601 with timezone offset' },
        description: { type: 'string', description: 'Optional notes for the event' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Optional guest email addresses' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email from the user. Needs user confirmation before running.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body (plain text)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'append_sheet_row',
    description: 'Add one row to a spreadsheet, found by name. Needs user confirmation before running.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheetName: { type: 'string', description: 'Name (or part of the name) of the spreadsheet' },
        values: { type: 'array', items: { type: 'string' }, description: 'Cell values for the new row, in column order' },
      },
      required: ['spreadsheetName', 'values'],
    },
  },
  {
    name: 'create_doc',
    description: 'Create a new Google Doc with text content. Needs user confirmation before running.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Text to put in the document' },
      },
      required: ['title', 'content'],
    },
  },
];

const LOCAL_TOOLS = [
  {
    name: 'create_reminder',
    description: 'Set a reminder for the user. Wasipy will notify them at that time (in the app, and by email if email reminders are enabled). Times must be ISO 8601 with the user\'s timezone offset.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What to remind about, e.g. "Call mom"' },
        when: { type: 'string', description: 'When to remind, ISO 8601 with timezone offset, e.g. 2026-11-14T09:00:00+06:00' },
        note: { type: 'string', description: 'Optional extra note' },
      },
      required: ['title', 'when'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List the user\'s upcoming reminders.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a reminder by its title (or part of it).',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Title or part of the title' } },
      required: ['title'],
    },
  },
];

const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, ...LOCAL_TOOLS];
const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));
const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

function notConnected(service) {
  return `NOT_CONNECTED: The user's ${service} is not connected. Ask them to connect ${service} first (button on the right).`;
}

// ---------- read executors ----------

async function requireClient(userId, service) {
  const auth = await serviceClient(userId, service);
  if (!auth) return null;
  return apiFor(service, auth);
}

// Read executors return { text, display }: text goes to the AI model,
// display is an optional structured payload the chat UI renders as rich
// cards (files, emails, events...) instead of raw links and long lists.
async function listCalendarEvents(userId, args) {
  const cal = await requireClient(userId, 'calendar');
  if (!cal) return { text: notConnected('Calendar'), display: null };
  const days = Math.min(Math.max(Number(args.days) || 3, 1), 14);
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 3600 * 1000);
  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 30,
  });
  const items = res.data.items || [];
  if (!items.length) return { text: 'No events in that period.', display: null };
  const displayItems = items.map((e) => ({
    title: e.summary || '(no title)',
    start: e.start.dateTime || e.start.date || '',
    end: e.end.dateTime || e.end.date || '',
    location: e.location || '',
  }));
  return {
    text: displayItems
      .map((e) => `- ${e.title} | ${e.start}${e.location ? ' | ' + e.location : ''}`)
      .join('\n'),
    display: { kind: 'events', items: displayItems },
  };
}

async function listRecentEmails(userId, args) {
  const gmail = await requireClient(userId, 'gmail');
  if (!gmail) return { text: notConnected('Gmail'), display: null };
  const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox',
    maxResults: count,
  });
  const msgs = res.data.messages || [];
  if (!msgs.length) return { text: 'Inbox is empty.', display: null };
  const out = [];
  const displayItems = [];
  for (const m of msgs) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    const h = {};
    for (const header of full.data.payload.headers || []) h[header.name] = header.value;
    const item = { id: m.id, from: h.From || '?', subject: h.Subject || '(no subject)', date: h.Date || '' };
    displayItems.push(item);
    out.push(`- id=${item.id} | From: ${item.from} | Subject: ${item.subject} | ${item.date}`);
  }
  return { text: out.join('\n'), display: { kind: 'emails', items: displayItems } };
}

async function readEmail(userId, args) {
  const gmail = await requireClient(userId, 'gmail');
  if (!gmail) return { text: notConnected('Gmail'), display: null };
  const res = await gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' });
  const h = {};
  for (const header of res.data.payload.headers || []) h[header.name] = header.value;
  const body = extractText(res.data.payload);
  const text = `From: ${h.From}\nSubject: ${h.Subject}\nDate: ${h.Date}\n\n${body.slice(0, 4000)}`;
  return {
    text,
    display: { kind: 'email', from: h.From || '', subject: h.Subject || '', date: h.Date || '', body: body.slice(0, 4000) },
  };
}

function extractText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body && part.body.data) {
    return Buffer.from(part.body.data, 'base64').toString('utf8');
  }
  if (part.parts) {
    for (const p of part.parts) {
      const t = extractText(p);
      if (t) return t;
    }
  }
  return '';
}

async function searchDriveFiles(userId, args) {
  const drive = await requireClient(userId, 'drive');
  if (!drive) return { text: notConnected('Drive'), display: null };
  const q = `name contains '${String(args.query).replace(/'/g, "\\'")}' and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: 10,
  });
  const files = res.data.files || [];
  if (!files.length) return { text: `No files found matching "${args.query}".`, display: null };
  const displayItems = files.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    url: f.webViewLink || '',
  }));
  return {
    // NOTE: no URLs in the text — the model must never see raw links, or it
    // pastes them into its reply. Links live only in the display payload,
    // where the UI renders them as proper file cards.
    text: displayItems
      .map((f) => `- ${f.name} | ${f.mimeType} | modified ${f.modifiedTime}`)
      .join('\n'),
    display: { kind: 'files', items: displayItems },
  };
}

async function listRecentDriveFiles(userId, args) {
  const drive = await requireClient(userId, 'drive');
  if (!drive) return { text: notConnected('Drive'), display: null };
  const count = Math.min(Math.max(Number(args.count) || 8, 1), 15);
  const res = await drive.files.list({
    q: 'trashed = false',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: count,
  });
  const files = res.data.files || [];
  if (!files.length) return { text: 'No files found in Drive yet.', display: null };
  const displayItems = files.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    url: f.webViewLink || '',
  }));
  return {
    text: displayItems
      .map((f) => `- ${f.name} | ${f.mimeType} | modified ${f.modifiedTime}`)
      .join('\n'),
    display: { kind: 'files', items: displayItems },
  };
}

async function findFileByName(userId, mimeType, name) {
  const drive = await requireClient(userId, 'drive');
  if (!drive) return { error: notConnected('Drive') };
  const q = `mimeType = '${mimeType}' and name contains '${String(name).replace(/'/g, "\\'")}' and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 5,
  });
  const files = res.data.files || [];
  if (!files.length) return { error: `No file found with a name like "${name}".` };
  return { file: files[0], others: files.slice(1) };
}

async function readSheet(userId, args) {
  const found = await findFileByName(
    userId,
    'application/vnd.google-apps.spreadsheet',
    args.spreadsheetName
  );
  if (found.error) return { text: found.error, display: null };
  const sheets = await requireClient(userId, 'sheets');
  if (!sheets) return { text: notConnected('Sheets'), display: null };
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: found.file.id,
    range: args.range || 'A1:Z30',
  });
  const rows = res.data.values || [];
  if (!rows.length) return { text: `Spreadsheet "${found.file.name}" is empty.`, display: null };
  return {
    text: `Spreadsheet: ${found.file.name}\n` + rows.map((r) => r.join(' | ')).join('\n'),
    display: { kind: 'sheet', name: found.file.name, rows: rows.slice(0, 12) },
  };
}

async function readDoc(userId, args) {
  const found = await findFileByName(userId, 'application/vnd.google-apps.document', args.documentName);
  if (found.error) return { text: found.error, display: null };
  const docs = await requireClient(userId, 'docs');
  if (!docs) return { text: notConnected('Docs'), display: null };
  const res = await docs.documents.get({ documentId: found.file.id });
  const text = (res.data.body.content || [])
    .flatMap((el) => (el.paragraph ? el.paragraph.elements || [] : []))
    .map((el) => (el.textRun ? el.textRun.content : ''))
    .join('');
  return {
    text: `Document: ${found.file.name}\n\n${text.slice(0, 5000)}`,
    display: { kind: 'doc', name: found.file.name, text: text.slice(0, 5000) },
  };
}

const READ_EXECUTORS = {
  list_calendar_events: listCalendarEvents,
  list_recent_emails: listRecentEmails,
  read_email: readEmail,
  list_recent_drive_files: listRecentDriveFiles,
  search_drive_files: searchDriveFiles,
  read_sheet: readSheet,
  read_doc: readDoc,
};

async function executeReadRich(userId, toolName, args) {
  const fn = READ_EXECUTORS[toolName];
  if (!fn) return { text: `Unknown tool: ${toolName}`, display: null };
  try {
    return await fn(userId, args || {});
  } catch (e) {
    console.error(`tool ${toolName} failed`, e);
    return { text: `ERROR: ${toolName} failed: ${e.message}`, display: null };
  }
}

// Text-only wrapper (used by /api/diag and anything that needs a string).
async function executeRead(userId, toolName, args) {
  const out = await executeReadRich(userId, toolName, args);
  return out.text;
}

// ---------- local executors (reminders — Wasipy's own database) ----------

async function createReminder(userId, args) {
  const title = String(args.title || '').trim();
  const when = new Date(args.when);
  if (!title) return { text: 'I need a title for the reminder.', display: null };
  if (isNaN(when)) {
    return { text: `I couldn't understand the time "${args.when}". Please give a clear date and time.`, display: null };
  }
  if (when.getTime() <= Date.now()) {
    return { text: 'That time is already past. Please pick a future time.', display: null };
  }
  const db = await getDb();
  const doc = {
    userId: String(userId),
    title,
    note: String(args.note || ''),
    when,
    status: 'pending',
    createdAt: new Date(),
  };
  const r = await db.collection('reminders').insertOne(doc);
  const item = { id: String(r.insertedId), title, when: when.toISOString(), note: doc.note };
  return {
    text: `Reminder set: "${title}" at ${when.toISOString()}.`,
    display: { kind: 'reminder', items: [item] },
  };
}

async function listReminders(userId) {
  const db = await getDb();
  const rows = await db
    .collection('reminders')
    .find({ userId: String(userId), status: 'pending', when: { $gte: new Date() } })
    .sort({ when: 1 })
    .limit(10)
    .toArray();
  if (!rows.length) return { text: 'No upcoming reminders.', display: null };
  const items = rows.map((r) => ({
    id: String(r._id),
    title: r.title,
    when: r.when.toISOString(),
    note: r.note || '',
  }));
  return {
    text: items.map((r) => `- "${r.title}" at ${r.when}`).join('\n'),
    display: { kind: 'reminder', items },
  };
}

async function cancelReminder(userId, args) {
  const db = await getDb();
  const q = String(args.title || '').trim();
  if (!q) return { text: 'Which reminder should I cancel? Give me its title.', display: null };
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = await db
    .collection('reminders')
    .findOne(
      { userId: String(userId), status: 'pending', title: { $regex: safe, $options: 'i' } },
      { sort: { when: 1 } }
    );
  if (!row) return { text: `No upcoming reminder found matching "${q}".`, display: null };
  await db.collection('reminders').updateOne({ _id: row._id }, { $set: { status: 'cancelled' } });
  return { text: `Cancelled the reminder "${row.title}".`, display: null };
}

const LOCAL_EXECUTORS = {
  create_reminder: createReminder,
  list_reminders: listReminders,
  cancel_reminder: cancelReminder,
};

async function executeLocal(userId, toolName, args) {
  const fn = LOCAL_EXECUTORS[toolName];
  if (!fn) return { text: `Unknown tool: ${toolName}`, display: null };
  try {
    return await fn(userId, args || {});
  } catch (e) {
    console.error(`local tool ${toolName} failed`, e);
    return { text: `ERROR: ${toolName} failed: ${e.message}`, display: null };
  }
}

// ---------- write executors (only called AFTER user confirms) ----------

async function createCalendarEvent(userId, args) {
  const cal = await requireClient(userId, 'calendar');
  if (!cal) return { ok: false, text: notConnected('Calendar') };
  const res = await cal.events.insert({
    calendarId: 'primary',
    resource: {
      summary: args.summary,
      description: args.description || '',
      start: { dateTime: args.start },
      end: { dateTime: args.end },
      attendees: (args.attendees || []).map((email) => ({ email })),
    },
    sendUpdates: 'all',
  });
  return { ok: true, text: `Event created: "${args.summary}" at ${args.start}.`, log: `Booked "${args.summary}"` };
}

async function sendEmail(userId, args) {
  const gmail = await requireClient(userId, 'gmail');
  if (!gmail) return { ok: false, text: notConnected('Gmail') };
  const raw = Buffer.from(
    `To: ${args.to}\r\nSubject: ${args.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}`
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { ok: true, text: `Email sent to ${args.to}.`, log: `Sent email to ${args.to}` };
}

async function appendSheetRow(userId, args) {
  const found = await findFileByName(
    userId,
    'application/vnd.google-apps.spreadsheet',
    args.spreadsheetName
  );
  if (found.error) return { ok: false, text: found.error };
  const sheets = await requireClient(userId, 'sheets');
  if (!sheets) return { ok: false, text: notConnected('Sheets') };
  await sheets.spreadsheets.values.append({
    spreadsheetId: found.file.id,
    range: 'A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [args.values] },
  });
  return {
    ok: true,
    text: `Added a row to "${found.file.name}": ${args.values.join(' | ')}`,
    log: `Added a row to "${found.file.name}"`,
  };
}

async function createDoc(userId, args) {
  const docs = await requireClient(userId, 'docs');
  if (!docs) return { ok: false, text: notConnected('Docs') };
  const res = await docs.documents.create({ requestBody: { title: args.title } });
  const documentId = res.data.documentId;
  if (args.content) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ insertText: { location: { index: 1 }, text: args.content } }],
      },
    });
  }
  return {
    ok: true,
    text: `Document "${args.title}" created.`,
    log: `Created doc "${args.title}"`,
  };
}

const WRITE_EXECUTORS = {
  create_calendar_event: createCalendarEvent,
  send_email: sendEmail,
  append_sheet_row: appendSheetRow,
  create_doc: createDoc,
};

async function executeWrite(userId, toolName, args) {
  const fn = WRITE_EXECUTORS[toolName];
  if (!fn) return { ok: false, text: `Unknown write tool: ${toolName}` };
  try {
    return await fn(userId, args || {});
  } catch (e) {
    console.error(`write tool ${toolName} failed`, e);
    return { ok: false, text: `Failed: ${e.message}` };
  }
}

// Short human-readable summary of a pending write, shown on the Yes/No card.
function summarizeWrite(toolName, args) {
  switch (toolName) {
    case 'create_calendar_event':
      return `Create event "${args.summary}" — ${args.start} to ${args.end}${args.attendees && args.attendees.length ? ` with ${args.attendees.join(', ')}` : ''}`;
    case 'send_email':
      return `Send email to ${args.to} — subject: "${args.subject}"`;
    case 'append_sheet_row':
      return `Add a row to "${args.spreadsheetName}": ${(args.values || []).join(' | ')}`;
    case 'create_doc':
      return `Create a Google Doc titled "${args.title}"`;
    default:
      return toolName;
  }
}

module.exports = {
  ALL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
  LOCAL_TOOLS,
  WRITE_TOOL_NAMES,
  LOCAL_TOOL_NAMES,
  executeRead,
  executeReadRich,
  executeLocal,
  executeWrite,
  summarizeWrite,
};
