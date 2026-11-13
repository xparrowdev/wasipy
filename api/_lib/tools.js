// The AI agent's tools: what it can DO in the user's Google account.
// Read tools run immediately. Write tools NEVER run from chat directly —
// they create a pending action the user must confirm first (Yes/No).
const { serviceClient, apiFor } = require('./google');

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
    name: 'search_drive_files',
    description: 'Search Drive files by name or words in the name.',
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

const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

function notConnected(service) {
  return `NOT_CONNECTED: The user's ${service} is not connected. Ask them to connect ${service} first (button on the right).`;
}

// ---------- read executors ----------

async function requireClient(userId, service) {
  const auth = await serviceClient(userId, service);
  if (!auth) return null;
  return apiFor(service, auth);
}

async function listCalendarEvents(userId, args) {
  const cal = await requireClient(userId, 'calendar');
  if (!cal) return notConnected('Calendar');
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
  if (!items.length) return 'No events in that period.';
  return items
    .map((e) => {
      const start = e.start.dateTime || e.start.date;
      return `- ${e.summary || '(no title)'} | ${start}${e.location ? ' | ' + e.location : ''}`;
    })
    .join('\n');
}

async function listRecentEmails(userId, args) {
  const gmail = await requireClient(userId, 'gmail');
  if (!gmail) return notConnected('Gmail');
  const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox',
    maxResults: count,
  });
  const msgs = res.data.messages || [];
  if (!msgs.length) return 'Inbox is empty.';
  const out = [];
  for (const m of msgs) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    const h = {};
    for (const header of full.data.payload.headers || []) h[header.name] = header.value;
    out.push(`- id=${m.id} | From: ${h.From || '?'} | Subject: ${h.Subject || '(no subject)'} | ${h.Date || ''}`);
  }
  return out.join('\n');
}

async function readEmail(userId, args) {
  const gmail = await requireClient(userId, 'gmail');
  if (!gmail) return notConnected('Gmail');
  const res = await gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' });
  const h = {};
  for (const header of res.data.payload.headers || []) h[header.name] = header.value;
  const body = extractText(res.data.payload);
  return `From: ${h.From}\nSubject: ${h.Subject}\nDate: ${h.Date}\n\n${body.slice(0, 4000)}`;
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
  if (!drive) return notConnected('Drive');
  const q = `name contains '${String(args.query).replace(/'/g, "\\'")}' and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: 10,
  });
  const files = res.data.files || [];
  if (!files.length) return `No files found matching "${args.query}".`;
  return files
    .map((f) => `- ${f.name} | ${f.mimeType} | modified ${f.modifiedTime}${f.webViewLink ? ' | ' + f.webViewLink : ''}`)
    .join('\n');
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
  if (found.error) return found.error;
  const sheets = await requireClient(userId, 'sheets');
  if (!sheets) return notConnected('Sheets');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: found.file.id,
    range: args.range || 'A1:Z30',
  });
  const rows = res.data.values || [];
  if (!rows.length) return `Spreadsheet "${found.file.name}" is empty.`;
  return `Spreadsheet: ${found.file.name}\n` + rows.map((r) => r.join(' | ')).join('\n');
}

async function readDoc(userId, args) {
  const found = await findFileByName(userId, 'application/vnd.google-apps.document', args.documentName);
  if (found.error) return found.error;
  const docs = await requireClient(userId, 'docs');
  if (!docs) return notConnected('Docs');
  const res = await docs.documents.get({ documentId: found.file.id });
  const text = (res.data.body.content || [])
    .flatMap((el) => (el.paragraph ? el.paragraph.elements || [] : []))
    .map((el) => (el.textRun ? el.textRun.content : ''))
    .join('');
  return `Document: ${found.file.name}\n\n${text.slice(0, 5000)}`;
}

const READ_EXECUTORS = {
  list_calendar_events: listCalendarEvents,
  list_recent_emails: listRecentEmails,
  read_email: readEmail,
  search_drive_files: searchDriveFiles,
  read_sheet: readSheet,
  read_doc: readDoc,
};

async function executeRead(userId, toolName, args) {
  const fn = READ_EXECUTORS[toolName];
  if (!fn) return `Unknown tool: ${toolName}`;
  try {
    return await fn(userId, args || {});
  } catch (e) {
    console.error(`tool ${toolName} failed`, e);
    return `ERROR: ${toolName} failed: ${e.message}`;
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
  WRITE_TOOL_NAMES,
  executeRead,
  executeWrite,
  summarizeWrite,
};
