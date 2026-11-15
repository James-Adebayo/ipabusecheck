require('dotenv').config();
const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ABUSEIPDB_API_KEY;
const DAILY_LIMIT = Math.max(1, parseInt(process.env.DAILY_LIMIT, 10) || 3);
const LIMIT_PHRASE = DAILY_LIMIT === 1 ? 'one lookup' : `${DAILY_LIMIT} lookups`;
const DAY_MS = 24 * 60 * 60 * 1000;

if (!API_KEY) {
  console.error('Missing ABUSEIPDB_API_KEY in .env');
  process.exit(1);
}

const app = express();
app.use(express.static(__dirname + "/public/"));

// Behind Nginx, Cloudflare, Render, Vercel etc. req.ip would be the proxy's address and every
// visitor would share one limit, so trust the forwarded address. Vercel is detected automatically.
if (process.env.TRUST_PROXY === 'true' || process.env.VERCEL) app.set('trust proxy', 1);

/* ======================================================================
   Daily limit storage. Each visitor IP maps to the timestamps of their
   lookups from the last 24 hours. Two backends:
   - Redis over REST (Upstash / Vercel Marketplace): needed on serverless hosts like Vercel,
     where files and memory don't persist. Used when its env vars are set.
   - A local JSON file: fine on a VPS, Render, Railway, Fly or your own machine.
   Both expose: list(visitor), reserve(visitor, stamp) -> list including stamp, release(visitor, stamp).
   ====================================================================== */
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const redisStore = (() => {
  const key = (v) => `limits:${v}`;
  async function run(commands) {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!r.ok) throw new Error(`Redis request failed (${r.status})`);
    const out = await r.json();
    const bad = out.find((x) => x.error);
    if (bad) throw new Error(`Redis error: ${bad.error}`);
    return out.map((x) => x.result);
  }
  const prune = (v) => ['ZREMRANGEBYSCORE', key(v), '-inf', String(Date.now() - DAY_MS)];
  const members = (v) => ['ZRANGE', key(v), '0', '-1'];
  return {
    name: 'redis',
    async list(v) {
      const res = await run([prune(v), members(v)]);
      return res[1].map(Number);
    },
    async reserve(v, stamp) {
      const res = await run([
        ['ZADD', key(v), String(stamp), String(stamp)],
        ['EXPIRE', key(v), String(Math.ceil(DAY_MS / 1000))],
        prune(v),
        members(v),
      ]);
      return res[3].map(Number);
    },
    async release(v, stamp) {
      await run([['ZREM', key(v), String(stamp)]]);
    },
  };
})();

const fileStore = (() => {
  const STORE = path.join(__dirname, 'data', 'limits.json');
  const lookups = {};
  try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); } catch { /* read-only disk */ }
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      // older versions stored one timestamp per visitor; accept both shapes
      lookups[k] = (Array.isArray(v) ? v : [v]).filter(Number.isFinite);
    }
  } catch { /* first run: nothing stored yet */ }

  function fresh(v) {
    const now = Date.now();
    const list = (lookups[v] || []).filter((t) => now - t < DAY_MS);
    if (list.length) lookups[v] = list;
    else delete lookups[v];
    return list;
  }
  function save() {
    for (const k of Object.keys(lookups)) fresh(k);
    try { fs.writeFileSync(STORE, JSON.stringify(lookups)); } catch { /* keep going in memory */ }
  }
  return {
    name: 'file',
    async list(v) { return fresh(v); },
    async reserve(v, stamp) { (lookups[v] ||= []).push(stamp); save(); return fresh(v); },
    async release(v, stamp) { lookups[v] = (lookups[v] || []).filter((t) => t !== stamp); save(); },
  };
})();

const store = REDIS_URL && REDIS_TOKEN ? redisStore : fileStore;
console.log(`Daily limit: ${LIMIT_PHRASE} per visitor (stored in ${store.name})`);
if (process.env.VERCEL && store.name === 'file') {
  console.warn('WARNING: running on Vercel without Redis. The daily limit will NOT persist between requests. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
}

// Turn a visitor's lookup list into what the page needs.
function stateFrom(list) {
  const remaining = Math.max(0, DAILY_LIMIT - list.length);
  // When none are left, the next one frees up 24 hours after their oldest lookup.
  const resetsAt = remaining === 0 ? new Date(Math.min(...list) + DAY_MS).toISOString() : null;
  return { allowed: remaining > 0, remaining, limit: DAILY_LIMIT, resetsAt };
}

/* ---------- Public site URL (needed for absolute og:image / canonical links) ----------
   Set SITE_URL=https://yourdomain.com. If it's missing, it's derived from the request. */
function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// Express may report IPv4 clients as "::ffff:1.2.3.4"; show the plain IPv4 form.
function cleanIp(ip) {
  return String(ip || '').replace(/^::ffff:/i, '');
}

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

/* ---------- Routes ---------- */
app.get('/', (req, res) => {
  res.type('html').send(
    INDEX_HTML.replace(/\{\{SITE_URL\}\}/g, siteUrl(req)).replace(/\{\{LIMIT_PHRASE\}\}/g, LIMIT_PHRASE)
  );
});

// The static folder would serve the raw file with {{placeholders}} still in it, so send it to "/".
app.get('/index.html', (req, res) => res.redirect(301, '/'));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${siteUrl(req)}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl(req)}/</loc></url>\n</urlset>\n`
  );
});

// llms.txt: a plain-text summary of the site for AI assistants and crawlers
app.get('/llms.txt', (req, res) => {
  res.type('text/plain').send(
`# IP Abuse Check

> A free web tool that checks any IPv4 or IPv6 address against 90 days of community abuse reports from AbuseIPDB and returns an abuse confidence score from 0 to 100.

## What it does
- Takes one IP address and returns the abuse confidence score, country, ISP, usage type, domain, hostnames, Tor status, total reports and the most recent reports with their categories.
- Score bands: 0-24 looks clean, 25-74 suspicious, 75-100 likely abusive.
- Each visitor gets ${LIMIT_PHRASE} per day.

## Use cases
- Reviewing server logs for brute-force, SSH and port-scan attempts
- Checking the address behind a suspicious signup, order or payment
- Investigating the sender of spam or phishing email
- Deciding what to block at a firewall

## Links
- Home: ${siteUrl(req)}/
`);
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/api/status', async (req, res) => {
  try {
    res.json({ ...stateFrom(await store.list(req.ip)), ip: cleanIp(req.ip) });
  } catch (err) {
    console.error(err);
    // Only the display is affected here; /api/check still enforces the limit.
    res.json({ allowed: true, remaining: DAILY_LIMIT, limit: DAILY_LIMIT, resetsAt: null, ip: cleanIp(req.ip) });
  }
});

app.get('/api/check', async (req, res) => {
  const ip = String(req.query.ip || '').trim();

  if (!net.isIP(ip)) {
    return res.status(400).json({ error: 'Enter a valid IPv4 or IPv6 address.' });
  }

  const visitor = req.ip;
  const stamp = Date.now() + Math.random() / 1000; // tiny offset keeps simultaneous stamps unique
  const release = () => store.release(visitor, stamp).catch((e) => console.error(e));

  // Reserve the slot before calling the API so parallel requests can't bypass the limit.
  let list;
  try {
    list = await store.reserve(visitor, stamp);
  } catch (err) {
    console.error(err);
    return res.status(503).json({ error: 'Usage tracking is unavailable right now. Try again shortly.' });
  }

  if (list.length > DAILY_LIMIT) {
    await release();
    const others = list.filter((t) => t !== stamp);
    return res.status(429).json({
      error: 'You have used all of today\'s lookups. Come back after the reset time.',
      remaining: 0,
      limit: DAILY_LIMIT,
      resetsAt: new Date(Math.min(...others) + DAY_MS).toISOString(),
    });
  }

  try {
    const url = new URL('https://api.abuseipdb.com/api/v2/check');
    url.searchParams.set('ipAddress', ip);
    url.searchParams.set('maxAgeInDays', '90');
    url.searchParams.set('verbose', '');

    const upstream = await fetch(url, {
      headers: { Key: API_KEY, Accept: 'application/json' },
    });
    const body = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      await release(); // a failed lookup shouldn't cost the visitor one of their searches
      const detail = body?.errors?.[0]?.detail || 'AbuseIPDB request failed.';
      const status = upstream.status === 429 ? 503 : upstream.status;
      return res.status(status).json({
        error: upstream.status === 429
          ? 'The service has hit its own AbuseIPDB quota. Try again later.'
          : detail,
      });
    }

    const { remaining, resetsAt } = stateFrom(list);
    res.json({ data: body.data, remaining, limit: DAILY_LIMIT, resetsAt });
  } catch (err) {
    await release();
    console.error(err);
    res.status(502).json({ error: 'Could not reach AbuseIPDB. Try again.' });
  }
});

// Vercel imports the app; running "node server.js" locally starts a normal server.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
}
module.exports = app;