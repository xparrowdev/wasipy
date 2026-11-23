// api/router.js — one serverless function serving several endpoints.
//
// WHY: Vercel's Hobby plan allows at most 12 serverless functions per
// deployment, and Wasipy has more endpoints than that. The endpoints below
// live in api/_lib/routes/ (NOT deployed as functions) and are reached
// through this single router via the rewrites in vercel.json, which keep
// every public URL exactly the same. The original files under api/ are
// excluded from deploys via .vercelignore — edit the copies in
// api/_lib/routes/ instead.
//
// To add another endpoint without using up a function slot: add its handler
// to api/_lib/routes/, add one line here, and add one rewrite to vercel.json.
const routes = {
  'reminders': require('./_lib/routes/reminders'),
  'cron-reminders': require('./_lib/routes/cron-reminders'),
  'cron-setup': require('./_lib/routes/cron-setup'),
  'actions-update': require('./_lib/routes/actions-update'),
  'desktop-url': require('./_lib/routes/desktop-url'),
  'desktop-exchange': require('./_lib/routes/desktop-exchange'),
  'mobile-url': require('./_lib/routes/mobile-url'),
  'mobile-exchange': require('./_lib/routes/mobile-exchange'),
  'calendar-upcoming': require('./_lib/routes/calendar-upcoming'),
  'news': require('./_lib/routes/news'),
  'meta-auth': require('./_lib/routes/meta-auth'),
  'meta-callback': require('./_lib/routes/meta-callback'),
  'meta-connections': require('./_lib/routes/meta-connections'),
};

module.exports = async (req, res) => {
  const route = req.query && String(req.query.route || '');
  const handler = routes[route];
  if (!handler) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Unknown route' }));
  }
  return handler(req, res);
};
