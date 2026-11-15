// Google OAuth + per-service API clients.
// Each service (Calendar, Gmail, Drive, Sheets, Docs) connects SEPARATELY:
// its own OAuth flow, its own scopes, its own encrypted refresh token.
// Sign-in itself only asks for basic profile (openid/email/profile).
const { google } = require('googleapis');
const { getDb } = require('./mongo');
const { encrypt, decrypt } = require('./crypto');

const SERVICES = {
  calendar: {
    label: 'Calendar',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  },
  gmail: {
    label: 'Gmail',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  },
  drive: {
    label: 'Drive',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  },
  sheets: {
    label: 'Sheets',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  },
  docs: {
    label: 'Docs',
    scopes: ['https://www.googleapis.com/auth/documents'],
  },
};

const LOGIN_SCOPES = ['openid', 'email', 'profile'];

function redirectUri() {
  return (
    process.env.GOOGLE_REDIRECT_URI ||
    'https://wasipy.vercel.app/api/auth/google/callback'
  );
}

// `redirect` overrides the web callback. The desktop app passes its own
// loopback redirect (http://127.0.0.1:8765/auth/callback) so Google sign-in
// can happen in the user's real browser instead of inside the app window.
function oauthClient(redirect) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirect || redirectUri()
  );
}

function authUrl({ action, service, state, redirectUri: redirect }) {
  const client = oauthClient(redirect);
  const scopes = action === 'connect' ? SERVICES[service].scopes : LOGIN_SCOPES;
  return client.generateAuthUrl({
    access_type: 'offline', // ask Google for a refresh token we can reuse
    prompt: action === 'connect' ? 'consent' : 'select_account',
    include_granted_scopes: true,
    scope: scopes,
    state,
  });
}

async function exchangeCode(code, redirect) {
  const client = oauthClient(redirect);
  const { tokens } = await client.getToken(code);
  return tokens;
}

async function getUserInfo(tokens) {
  const client = oauthClient();
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();
  return data; // { id, email, name, picture, verified_email }
}

async function saveConnection(userId, service, tokens, email) {
  const db = await getDb();
  const doc = {
    userId: String(userId),
    service,
    email: email || '',
    scopes: SERVICES[service].scopes,
    connectedAt: new Date(),
  };
  if (tokens.refresh_token) {
    // Only the refresh token is stored, encrypted. Access tokens are short
    // lived and re-derived from it on every use.
    doc.refreshTokenEnc = encrypt(tokens.refresh_token);
  } else {
    // Google sometimes omits the refresh token on re-authorization. Keep
    // the stored one instead of wiping access — but if there is no stored
    // one either, refuse to save: a row without a token looks "Connected"
    // in the UI while the agent cannot use the service at all.
    const existing = await db
      .collection('googleConnections')
      .findOne({ userId: String(userId), service });
    if (existing && existing.refreshTokenEnc) {
      doc.refreshTokenEnc = existing.refreshTokenEnc;
    } else {
      const err = new Error('Google did not return a refresh token and none is stored');
      err.code = 'NO_REFRESH_TOKEN';
      throw err;
    }
  }
  await db
    .collection('googleConnections')
    .updateOne({ userId: String(userId), service }, { $set: doc }, { upsert: true });
}

async function listConnections(userId) {
  const db = await getDb();
  const rows = await db
    .collection('googleConnections')
    .find({ userId: String(userId) })
    .toArray();
  return rows.map((r) => ({
    service: r.service,
    label: SERVICES[r.service] ? SERVICES[r.service].label : r.service,
    email: r.email || '',
    connectedAt: r.connectedAt,
  }));
}

async function deleteConnection(userId, service) {
  const db = await getDb();
  const row = await db
    .collection('googleConnections')
    .findOne({ userId: String(userId), service });
  if (row && row.refreshTokenEnc) {
    // Best effort: tell Google to revoke the token too.
    try {
      const client = oauthClient();
      await client.revokeToken(decrypt(row.refreshTokenEnc));
    } catch (e) {
      console.error('revoke failed (continuing)', e.message);
    }
  }
  await db
    .collection('googleConnections')
    .deleteOne({ userId: String(userId), service });
}

// Build an authenticated Google API client for one service, for one user.
// Returns null when that service is not connected.
async function serviceClient(userId, service) {
  const db = await getDb();
  const row = await db
    .collection('googleConnections')
    .findOne({ userId: String(userId), service });
  if (!row || !row.refreshTokenEnc) return null;
  const client = oauthClient();
  client.setCredentials({ refresh_token: decrypt(row.refreshTokenEnc) });
  return client;
}

function apiFor(service, auth) {
  switch (service) {
    case 'calendar':
      return google.calendar({ version: 'v3', auth });
    case 'gmail':
      return google.gmail({ version: 'v1', auth });
    case 'drive':
      return google.drive({ version: 'v3', auth });
    case 'sheets':
      return google.sheets({ version: 'v4', auth });
    case 'docs':
      return google.docs({ version: 'v1', auth });
    default:
      throw new Error(`Unknown service: ${service}`);
  }
}

module.exports = {
  SERVICES,
  LOGIN_SCOPES,
  redirectUri,
  oauthClient,
  authUrl,
  exchangeCode,
  getUserInfo,
  saveConnection,
  listConnections,
  deleteConnection,
  serviceClient,
  apiFor,
};
