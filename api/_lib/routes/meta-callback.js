// GET /api/auth/meta/callback — Meta redirects back here after the user
// approves (or denies) the Page connection. Verifies the signed state,
// exchanges the code for a long-lived user token, fetches the Pages the
// user shared in the dialog, and stores one encrypted Page token per Page.
const { verify, parseB64urlJson } = require('../../_lib/crypto');
const { getSession } = require('../../_lib/session');
const { logActivity } = require('../../_lib/mongo');
const {
  exchangeCode,
  exchangeLongLivedToken,
  listPages,
  savePageConnection,
} = require('../../_lib/meta');

function fail(res, message) {
  res.writeHead(302, { Location: `/?error=${encodeURIComponent(message)}` });
  res.end();
}

module.exports = async (req, res) => {
  const { code, state, error, error_description } = req.query || {};
  if (error) {
    return fail(res, `Facebook connect was not completed (${error_description || error}).`);
  }
  if (!code || !state) return fail(res, 'Missing code from Facebook. Please try again.');

  // Verify signed state (CSRF protection + carries returnTo).
  let stateObj;
  try {
    const dot = String(state).lastIndexOf('.');
    const data = String(state).slice(0, dot);
    const sig = String(state).slice(dot + 1);
    if (!verify(data, sig)) return fail(res, 'Invalid sign-in state. Please try again.');
    stateObj = parseB64urlJson(data);
    if (stateObj.exp < Math.floor(Date.now() / 1000)) {
      return fail(res, 'Sign-in expired. Please try again.');
    }
  } catch {
    return fail(res, 'Invalid sign-in state. Please try again.');
  }

  const session = getSession(req);
  if (!session) return fail(res, 'Please sign in first, then connect a Facebook Page.');

  let userToken;
  try {
    const shortToken = await exchangeCode(code);
    userToken = await exchangeLongLivedToken(shortToken);
  } catch (e) {
    console.error('meta code exchange failed', e);
    return fail(res, 'Could not finish the Facebook connect. Please try again.');
  }

  let pages;
  try {
    pages = await listPages(userToken);
  } catch (e) {
    console.error('meta listPages failed', e);
    return fail(res, 'Could not read your Facebook Pages. Please try again.');
  }
  if (!pages.length) {
    return fail(res, 'No Facebook Page was shared. Please create a Page first, or pick an account that manages one, and make sure to select the Page in the Facebook dialog.');
  }

  try {
    for (const page of pages) {
      if (page.access_token) await savePageConnection(session.userId, page);
    }
  } catch (e) {
    console.error('meta savePageConnection failed', e);
    return fail(res, 'Could not save this connection (database error). Please try again.');
  }

  const first = pages[0];
  await logActivity(
    session.userId,
    pages.length === 1
      ? `Connected Facebook Page "${first.name}"`
      : `Connected ${pages.length} Facebook Pages (first: "${first.name}")`
  );
  res.writeHead(302, { Location: `${stateObj.returnTo || '/'}?connected=facebook` });
  res.end();
};
