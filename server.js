require('dotenv').config();
const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ABUSEIPDB_API_KEY;
const DAY_MS = 24 * 60 * 60 * 1000;
const STORE = path.join(__dirname, 'data', 'limits.json');

if (!API_KEY) {
  console.error('Missing ABUSEIPDB_API_KEY in .env');
  process.exit(1);
}

const app = express();
app.use(express.static(__dirname + "/public/"));

// Set TRUST_PROXY=true in .env when running behind Nginx, Cloudflare, Render, etc.
// Without it, req.ip would be the proxy's address and every visitor would share one limit.
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

// ---- Daily limit store: visitor IP -> timestamp of their last lookup ----
fs.mkdirSync(path.dirname(STORE), { recursive: true });
let lastLookup = {};
try {
  lastLookup = JSON.parse(fs.readFileSync(STORE, 'utf8'));
} catch {
  lastLookup = {};
}

function save() {
  const now = Date.now();
  for (const [k, t] of Object.entries(lastLookup)) {
    if (now - t >= DAY_MS) delete lastLookup[k];
  }
  fs.writeFileSync(STORE, JSON.stringify(lastLookup));
}

function limitState(visitor) {
  const t = lastLookup[visitor];
  if (t && Date.now() - t < DAY_MS) {
    return { allowed: false, resetsAt: new Date(t + DAY_MS).toISOString() };
  }
  return { allowed: true, resetsAt: null };
}

// ---- Public site URL (needed for absolute og:image / canonical links) ----
// Set SITE_URL=https://yourdomain.com in .env. If it's missing, it's derived from the request.
function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// ---- Routes ----
app.get('/', (req, res) => {
  res.type('html').send(INDEX_HTML.replace(/\{\{SITE_URL\}\}/g, siteUrl(req)));
});

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
- Each visitor gets one lookup per day.

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

// Express may report IPv4 clients as "::ffff:1.2.3.4"; show the plain IPv4 form.
function cleanIp(ip) {
  return String(ip || '').replace(/^::ffff:/i, '');
}

app.get('/api/status', (req, res) => {
  res.json({ ...limitState(req.ip), ip: cleanIp(req.ip) });
});

app.get('/api/check', async (req, res) => {
  const ip = String(req.query.ip || '').trim();

  if (!net.isIP(ip)) {
    return res.status(400).json({ error: 'Enter a valid IPv4 or IPv6 address.' });
  }

  const visitor = req.ip;
  const state = limitState(visitor);
  if (!state.allowed) {
    return res.status(429).json({
      error: 'You have used today\'s lookup. Come back after the reset time.',
      resetsAt: state.resetsAt,
    });
  }

  // Reserve the slot before calling the API so parallel requests can't bypass the limit.
  lastLookup[visitor] = Date.now();
  save();

  const release = () => {
    delete lastLookup[visitor];
    save();
  };

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
      release(); // a failed lookup shouldn't cost the visitor their daily search
      const detail = body?.errors?.[0]?.detail || 'AbuseIPDB request failed.';
      const status = upstream.status === 429 ? 503 : upstream.status;
      return res.status(status).json({
        error: upstream.status === 429
          ? 'The service has hit its own AbuseIPDB quota. Try again later.'
          : detail,
      });
    }

    res.json({ data: body.data, resetsAt: new Date(lastLookup[visitor] + DAY_MS).toISOString() });
  } catch (err) {
    release();
    console.error(err);
    res.status(502).json({ error: 'Could not reach AbuseIPDB. Try again.' });
  }
});

app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));