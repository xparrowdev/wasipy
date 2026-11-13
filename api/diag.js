// GET /api/diag?service=gmail — signed-in diagnostics for one service.
// Runs a tiny real read against that service and returns the raw outcome,
// so the owner can see the exact Google error instead of the agent's guess.
// Only works for the signed-in user, and only for their own account.
const { getSession } = require('./_lib/session');
const { executeRead } = require('./_lib/tools');
const { SERVICES } = require('./_lib/google');

const PROBES = {
  gmail: { tool: 'list_recent_emails', args: { count: 1 } },
  calendar: { tool: 'list_calendar_events', args: { days: 1 } },
  drive: { tool: 'search_drive_files', args: { query: 'a' } },
};

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const session = getSession(req);
  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: 'Not signed in' }));
  }
  const service = req.query.service;
  if (!SERVICES[service]) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: `Unknown service: ${service}` }));
  }
  const probe = PROBES[service];
  if (!probe) {
    return res.end(
      JSON.stringify({ ok: true, service, note: 'No probe for this service yet.' })
    );
  }
  const result = await executeRead(session.userId, probe.tool, probe.args);
  const failed = typeof result === 'string' && result.startsWith('ERROR');
  res.statusCode = failed ? 500 : 200;
  res.end(
    JSON.stringify({
      ok: !failed,
      service,
      tool: probe.tool,
      result: String(result).slice(0, 1000),
    })
  );
};
