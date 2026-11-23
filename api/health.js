// GET /api/health — deployment diagnostics for the site owner.
// Reports only WHETHER things are configured and reachable. Never returns
// secret values. The MongoDB error message is scrubbed of any URI.
const { getDb } = require('./_lib/mongo');

function scrub(text) {
  return String(text || '').replace(/mongodb(\+srv)?:\/\/[^\s'"]+/g, '[redacted-uri]');
}

module.exports = async (req, res) => {
  const out = {
    ok: true,
    // Marker: true when this deployment includes the chat pre-search
    // (runAgent searches the web first for current-info questions).
    preSearch: true,
    env: {
      MONGODB_URI: !!process.env.MONGODB_URI,
      GOOGLE_CLIENT_ID: !!process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      TAVILY_API_KEY: !!process.env.TAVILY_API_KEY,
      META_APP_ID: !!process.env.META_APP_ID,
      META_APP_SECRET: !!process.env.META_APP_SECRET,
    },
    mongo: 'unknown',
  };
  try {
    const db = await getDb();
    await Promise.race([
      db.command({ ping: 1 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('MongoDB ping timed out after 10s')), 10000)
      ),
    ]);
    out.mongo = 'connected';
  } catch (e) {
    out.ok = false;
    out.mongo = 'failed';
    out.mongoError = scrub(e.message).slice(0, 500);
  }
  res.statusCode = out.ok ? 200 : 500;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(out));
};
