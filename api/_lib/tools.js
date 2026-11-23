// The AI agent's tools: what it can DO in the user's Google account and
// Facebook Page. Read tools run immediately. Write tools NEVER run from
// chat directly — they create a pending action the user must confirm first
// (Yes/No). Local tools (reminders) run immediately too — they only touch
// Wasipy's own database, never the user's Google account.
const { serviceClient, apiFor } = require('./google');
const { resolvePage, graph } = require('./meta');
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
  {
    name: 'web_search',
    description: 'Search the live web for current information. ALWAYS use this tool when the user asks about news, current events, prices, weather, or anything that changes over time — answer only from search results, never from your own knowledge.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for' } },
      required: ['query'],
    },
  },
  {
    name: 'list_facebook_posts',
    description: 'List recent posts on the user\'s connected Facebook Page, with likes and comment counts.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'How many posts (default 5, max 10)' },
        page: { type: 'string', description: 'Optional Page name or id when several Pages are connected' },
      },
    },
  },
  {
    name: 'list_facebook_comments',
    description: 'List comments on a Facebook Page post. Omit postId to see comments on the latest post.',
    parameters: {
      type: 'object',
      properties: {
        postId: { type: 'string', description: 'Post id from list_facebook_posts (optional — latest post if omitted)' },
        count: { type: 'number', description: 'How many comments (default 10, max 20)' },
        page: { type: 'string', description: 'Optional Page name or id when several Pages are connected' },
      },
    },
  },
  {
    name: 'list_facebook_messages',
    description: 'List recent Messenger conversations on the user\'s connected Facebook Page, with the last message of each.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'How many conversations (default 5, max 10)' },
        page: { type: 'string', description: 'Optional Page name or id when several Pages are connected' },
      },
    },
  },
  {
    name: 'read_facebook_messages',
    description: 'Read the messages of one Messenger conversation on the connected Facebook Page.',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation id from list_facebook_messages' },
        count: { type: 'number', description: 'How many messages (default 10, max 20)' },
        page: { type: 'string', description: 'Optional Page name or id when several Pages are connected' },
      },
      required: ['conversationId'],
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
  {
    name: 'create_facebook_post',
    description: 'Publish a post on the user\'s connected Facebook Page. Needs user confirmation before running.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text of the post' },
        page: { type: 'string', description: 'Optional Page name or id when several Pages are connected' },
      },
      required: ['message'],
    },
  },
  {
    name: 'reply_facebook_comment',
    description: 'Reply to a comment on the user\'s Facebook Page, as the Page. Needs user confirmation before running.',
    parameters: {
      type: 'object',
      properties: {
        commentId: { type: 'string', description: 'Comment id from list_facebook_comments' },
        message: { type: 'string', description: 'Reply text' },
        page: { type: 'string', description: 'Optional Page name or id when several Pages are connected' },
      },
      required: ['commentId', 'message'],
    },
  },
  {
    name: 'reply_facebook_message',
    description: 'Reply to a Messenger conversation on the user\'s Facebook Page, as the Page. Needs user confirmation before running. Meta only allows replies within 24 hours of the person\'s last message.',
    parameters: {
      type: 'object',
      properties: {
        recipientId: { type: 'string', description: 'The other person\'s id (PSID) from list_facebook_messages' },
        message: { type: 'string', description: 'Reply text' },
        page: { type: 'string', description: 'Optional Page name or id when several Pages are connected' },
      },
      required: ['recipientId', 'message'],
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

// Web search via Tavily (a search API built for AI agents). Needs the
// TAVILY_API_KEY env var (free tier: 1,000 searches/month, no card).
// search_depth is pinned to 'basic' (1 credit per search) — Tavily's auto
// mode can silently pick 'advanced' (2 credits).
async function webSearch(userId, args) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    return { text: 'Web search is not set up yet. The site owner needs to add a TAVILY_API_KEY (free from tavily.com) in the Vercel dashboard, then redeploy.', display: null };
  }
  const query = String(args.query || '').trim();
  if (!query) return { text: 'I need something to search for.', display: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let res;
  try {
    res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: 5, include_answer: false }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { text: 'ERROR: web search failed: could not reach the search service.', display: null };
  }
  clearTimeout(timer);
  if (!res.ok) {
    if (res.status === 401) return { text: 'ERROR: web search failed: the Tavily API key is invalid.', display: null };
    if (res.status === 429) return { text: 'ERROR: web search failed: search limit reached for now. Please try again later.', display: null };
    return { text: `ERROR: web search failed (status ${res.status}).`, display: null };
  }
  const data = await res.json();
  const results = (data.results || []).slice(0, 5);
  if (!results.length) return { text: `No web results for "${query}".`, display: null };
  const items = results.map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: String(r.content || '').slice(0, 200),
  }));
  const text = results
    .map((r, i) => `${i + 1}. ${r.title || ''}\n${String(r.content || '').slice(0, 500)}`)
    .join('\n\n');
  return { text, display: { kind: 'search', items } };
}

// ---------- Facebook Page executors (Graph API) ----------

async function requirePage(userId, args) {
  return resolvePage(userId, args.page);
}

async function listFacebookPosts(userId, args) {
  const page = await requirePage(userId, args);
  if (!page) return { text: notConnected('Facebook Page'), display: null };
  const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
  const data = await graph(
    `/${page.pageId}/posts?fields=id,message,created_time,permalink_url,reactions.summary(total_count),comments.summary(total_count)&limit=${count}`,
    page.token
  );
  const posts = data.data || [];
  if (!posts.length) return { text: `No posts on "${page.pageName}" yet.`, display: null };
  const displayItems = posts.map((p) => ({
    id: p.id,
    message: p.message || '',
    created_time: p.created_time || '',
    url: p.permalink_url || '',
    reactions: (p.reactions && p.reactions.summary && p.reactions.summary.total_count) || 0,
    comments: (p.comments && p.comments.summary && p.comments.summary.total_count) || 0,
  }));
  return {
    // NOTE: no URLs in the text — links live only in the display payload.
    text: displayItems
      .map((p) => `- id=${p.id} | ${String(p.message).slice(0, 120)} | ${p.created_time} | ${p.reactions} reactions, ${p.comments} comments`)
      .join('\n'),
    display: { kind: 'fb_posts', pageName: page.pageName, items: displayItems },
  };
}

async function listFacebookComments(userId, args) {
  const page = await requirePage(userId, args);
  if (!page) return { text: notConnected('Facebook Page'), display: null };
  const count = Math.min(Math.max(Number(args.count) || 10, 1), 20);
  let postId = args.postId;
  if (!postId) {
    const posts = await graph(`/${page.pageId}/posts?fields=id&limit=1`, page.token);
    if (!posts.data || !posts.data.length) return { text: `No posts on "${page.pageName}" yet.`, display: null };
    postId = posts.data[0].id;
  }
  const data = await graph(
    `/${postId}/comments?fields=id,from{name},message,created_time&limit=${count}`,
    page.token
  );
  const comments = data.data || [];
  if (!comments.length) return { text: 'No comments on that post yet.', display: null };
  const displayItems = comments.map((c) => ({
    id: c.id,
    from: (c.from && c.from.name) || '?',
    message: c.message || '',
    created_time: c.created_time || '',
  }));
  return {
    text: displayItems
      .map((c) => `- id=${c.id} | ${c.from}: ${String(c.message).slice(0, 200)} | ${c.created_time}`)
      .join('\n'),
    display: { kind: 'fb_comments', postId, items: displayItems },
  };
}

async function listFacebookMessages(userId, args) {
  const page = await requirePage(userId, args);
  if (!page) return { text: notConnected('Facebook Page'), display: null };
  const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
  const data = await graph(
    `/${page.pageId}/conversations?fields=id,participants,updated_time,messages.limit(1){id,message,from,created_time}&limit=${count}`,
    page.token
  );
  const convs = data.data || [];
  if (!convs.length) return { text: `No Messenger conversations on "${page.pageName}" yet.`, display: null };
  const displayItems = convs.map((c) => {
    const others = ((c.participants && c.participants.data) || []).filter(
      (p) => String(p.id) !== String(page.pageId)
    );
    const last = (c.messages && c.messages.data && c.messages.data[0]) || null;
    return {
      id: c.id,
      otherId: others.length ? others[0].id : '',
      otherName: others.length ? others[0].name || '' : '',
      updated_time: c.updated_time || '',
      lastMessage: last ? last.message || '' : '',
      lastFrom: last && last.from ? last.from.name || '' : '',
    };
  });
  return {
    text: displayItems
      .map((c) => `- conversation=${c.id} | with ${c.otherName} (id=${c.otherId}) | last: "${String(c.lastMessage).slice(0, 120)}" | ${c.updated_time}`)
      .join('\n'),
    display: { kind: 'fb_messages', pageName: page.pageName, items: displayItems },
  };
}

async function readFacebookMessages(userId, args) {
  const page = await requirePage(userId, args);
  if (!page) return { text: notConnected('Facebook Page'), display: null };
  const count = Math.min(Math.max(Number(args.count) || 10, 1), 20);
  const data = await graph(
    `/${args.conversationId}/messages?fields=id,message,from,created_time&limit=${count}`,
    page.token
  );
  const msgs = data.data || [];
  if (!msgs.length) return { text: 'No messages in that conversation.', display: null };
  const displayItems = msgs.map((m) => ({
    id: m.id,
    from: (m.from && m.from.name) || '?',
    fromId: (m.from && m.from.id) || '',
    message: m.message || '',
    created_time: m.created_time || '',
  }));
  return {
    text: displayItems
      .map((m) => `- ${m.from}: ${String(m.message).slice(0, 300)} | ${m.created_time}`)
      .join('\n'),
    display: { kind: 'fb_thread', conversationId: args.conversationId, items: displayItems },
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
  web_search: webSearch,
  list_facebook_posts: listFacebookPosts,
  list_facebook_comments: listFacebookComments,
  list_facebook_messages: listFacebookMessages,
  read_facebook_messages: readFacebookMessages,
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

async function createFacebookPost(userId, args) {
  const page = await resolvePage(userId, args.page);
  if (!page) return { ok: false, text: notConnected('Facebook Page') };
  await graph(`/${page.pageId}/feed`, page.token, { method: 'POST', body: { message: args.message } });
  return { ok: true, text: `Posted on "${page.pageName}".`, log: `Posted on Facebook Page "${page.pageName}"` };
}

async function replyFacebookComment(userId, args) {
  const page = await resolvePage(userId, args.page);
  if (!page) return { ok: false, text: notConnected('Facebook Page') };
  await graph(`/${args.commentId}/replies`, page.token, { method: 'POST', body: { message: args.message } });
  return { ok: true, text: 'Reply posted.', log: 'Replied to a Facebook comment' };
}

async function replyFacebookMessage(userId, args) {
  const page = await resolvePage(userId, args.page);
  if (!page) return { ok: false, text: notConnected('Facebook Page') };
  await graph(`/${page.pageId}/messages`, page.token, {
    method: 'POST',
    body: { recipient: { id: args.recipientId }, message: { text: args.message } },
  });
  return { ok: true, text: 'Message sent.', log: 'Replied to a Facebook message' };
}

const WRITE_EXECUTORS = {
  create_calendar_event: createCalendarEvent,
  send_email: sendEmail,
  append_sheet_row: appendSheetRow,
  create_doc: createDoc,
  create_facebook_post: createFacebookPost,
  reply_facebook_comment: replyFacebookComment,
  reply_facebook_message: replyFacebookMessage,
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
    case 'create_facebook_post':
      return `Post on Facebook Page: "${String(args.message || '').slice(0, 120)}"`;
    case 'reply_facebook_comment':
      return `Reply to a Facebook comment: "${String(args.message || '').slice(0, 120)}"`;
    case 'reply_facebook_message':
      return `Reply to a Facebook message: "${String(args.message || '').slice(0, 120)}"`;
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
