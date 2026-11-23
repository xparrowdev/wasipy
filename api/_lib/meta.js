// Meta (Facebook Page) OAuth + Graph API client.
//
// Mirrors google.js: per-user connections, tokens encrypted, every record
// carrying userId. A user connects with Facebook Login, picks their Page(s)
// in Meta's own dialog (their password never reaches Wasipy), and Wasipy
// stores one LONG-LIVED Page token per Page. Page tokens obtained from a
// long-lived user token do not expire unless the user removes the app or
// changes their password.
//
// Scopes are the current granular Page permissions — the old manage_pages /
// publish_pages names were removed by Meta and must never be requested
// (the Graph API Explorer still asks for manage_pages and errors on it).
const { getDb } = require('./mongo');
const { encrypt, decrypt } = require('./crypto');

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// What the Page connection asks for (shown in Meta's dialog):
//  pages_show_list         list the Pages the user manages
//  pages_read_engagement   read Page posts, comments, insights
//  pages_read_user_content read posts visitors publish on the Page
//  pages_manage_posts      publish posts as the Page
//  pages_manage_engagement reply to comments as the Page
//  pages_messaging         read and reply to Page (Messenger) messages
const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_posts',
  'pages_manage_engagement',
  'pages_messaging',
];

function redirectUri() {
  return (
    process.env.META_REDIRECT_URI ||
    'https://wasipy.vercel.app/api/auth/meta/callback'
  );
}

function authUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID || '',
    redirect_uri: redirectUri(),
    state,
    scope: META_SCOPES.join(','),
    response_type: 'code',
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

// One Graph API call. Returns the parsed JSON, or throws an Error carrying
// Meta's own message (error.error.message) so the agent can quote it.
async function graph(path, token, { method = 'GET', body = null } = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  if (token) url.searchParams.set('access_token', token);
  const res = await fetch(url.toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = (data.error && data.error.message) || `Meta request failed (status ${res.status})`;
    const err = new Error(msg);
    err.metaCode = data.error && data.error.code;
    throw err;
  }
  return data;
}

// Exchange the login code for a short-lived user token (~1-2 hours).
async function exchangeCode(code) {
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set('client_id', process.env.META_APP_ID || '');
  url.searchParams.set('client_secret', process.env.META_APP_SECRET || '');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('code', code);
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new Error((data.error && data.error.message) || 'Meta did not return a token.');
  }
  return data.access_token;
}

// Swap a short-lived user token for a long-lived one (~60 days). Page
// tokens fetched with a long-lived user token do not expire.
async function exchangeLongLivedToken(shortToken) {
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', process.env.META_APP_ID || '');
  url.searchParams.set('client_secret', process.env.META_APP_SECRET || '');
  url.searchParams.set('fb_exchange_token', shortToken);
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new Error((data.error && data.error.message) || 'Meta did not return a long-lived token.');
  }
  return data.access_token;
}

// Pages the user granted in the login dialog, each with its own Page token.
// Also returns any linked Instagram Business account (Phase 4 uses it).
async function listPages(userToken) {
  const data = await graph(
    '/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}',
    userToken
  );
  return data.data || [];
}

async function getUserProfile(userToken) {
  return graph('/me?fields=id,name', userToken);
}

async function savePageConnection(userId, page) {
  const db = await getDb();
  const ig = page.instagram_business_account || null;
  const doc = {
    userId: String(userId),
    pageId: String(page.id),
    pageName: page.name || '',
    pageTokenEnc: encrypt(page.access_token),
    igBusinessId: ig ? String(ig.id) : '',
    igUsername: ig ? ig.username || '' : '',
    scopes: META_SCOPES,
    connectedAt: new Date(),
  };
  await db
    .collection('metaConnections')
    .updateOne(
      { userId: String(userId), pageId: String(page.id) },
      { $set: doc },
      { upsert: true }
    );
}

// This user's connected Pages — never includes tokens.
async function listPageConnections(userId) {
  const db = await getDb();
  const rows = await db
    .collection('metaConnections')
    .find({ userId: String(userId) })
    .toArray();
  return rows.map((r) => ({
    pageId: r.pageId,
    pageName: r.pageName || '',
    igBusinessId: r.igBusinessId || '',
    igUsername: r.igUsername || '',
    connectedAt: r.connectedAt,
  }));
}

async function deletePageConnection(userId, pageId) {
  const db = await getDb();
  const row = await db
    .collection('metaConnections')
    .findOne({ userId: String(userId), pageId: String(pageId) });
  if (row && row.pageTokenEnc) {
    // Best effort: tell Meta to revoke the Page token too.
    try {
      await graph(`/${row.pageId}/permissions`, decrypt(row.pageTokenEnc), { method: 'DELETE' });
    } catch (e) {
      console.error('meta revoke failed (continuing)', e.message);
    }
  }
  await db
    .collection('metaConnections')
    .deleteOne({ userId: String(userId), pageId: String(pageId) });
}

// Pick a Page for this user: no hint = the first connected Page; a hint
// matches a Page id exactly or a Page name (case-insensitive substring).
// Returns { pageId, pageName, token } or null when nothing is connected.
async function resolvePage(userId, hint) {
  const db = await getDb();
  const rows = await db
    .collection('metaConnections')
    .find({ userId: String(userId) })
    .toArray();
  if (!rows.length) return null;
  let row = rows[0];
  if (hint) {
    const h = String(hint).trim().toLowerCase();
    row =
      rows.find((r) => String(r.pageId) === h) ||
      rows.find((r) => (r.pageName || '').toLowerCase().includes(h)) ||
      rows[0];
  }
  if (!row.pageTokenEnc) return null;
  return { pageId: row.pageId, pageName: row.pageName || '', token: decrypt(row.pageTokenEnc) };
}

module.exports = {
  GRAPH_VERSION,
  META_SCOPES,
  redirectUri,
  authUrl,
  graph,
  exchangeCode,
  exchangeLongLivedToken,
  listPages,
  getUserProfile,
  savePageConnection,
  listPageConnections,
  deletePageConnection,
  resolvePage,
};
