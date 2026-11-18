// GET /api/news — latest international news via Tavily.
// Public: no sign-in needed (news is public). Cached 1 hour in memory
// so the free Tavily tier (1,000 searches/month) is never stressed:
// at most ~24 searches a day even if the panel is opened constantly.
let cache = { at: 0, items: null };

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed' });
  const now = Date.now();
  if (cache.items && now - cache.at < 3600000) {
    return json(res, 200, {
      ok: true,
      cached: true,
      updatedAt: new Date(cache.at).toISOString(),
      items: cache.items,
    });
  }
  const key = process.env.TAVILY_API_KEY;
  if (!key) return json(res, 503, { ok: false, error: 'News is not set up yet.' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let r;
  try {
    r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query: 'latest international news',
        topic: 'news',
        time_range: 'day',
        search_depth: 'basic',
        max_results: 10,
        include_answer: false,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return json(res, 502, { ok: false, error: 'Could not reach the news service. Please try again.' });
  }
  clearTimeout(timer);
  if (!r.ok) {
    return json(res, 502, { ok: false, error: 'News is unavailable right now. Please try again later.' });
  }
  const data = await r.json();
  const items = (data.results || [])
    .slice(0, 10)
    .map((x) => ({
      title: x.title || '',
      url: x.url || '',
      snippet: String(x.content || '').slice(0, 220),
      source: hostOf(x.url || ''),
      publishedAt: x.published_date || null,
    }))
    .filter((x) => x.title && x.url);
  cache = { at: now, items };
  return json(res, 200, {
    ok: true,
    cached: false,
    updatedAt: new Date(now).toISOString(),
    items,
  });
};
