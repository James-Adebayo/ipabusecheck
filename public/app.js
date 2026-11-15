/* ======== EDIT THIS: your support details ========
   Each method is a card in the popup. "rows" show a label and a value with a Copy button.
   "link" shows a button that opens that URL (Paystack, Flutterwave, Buy Me a Coffee, etc.). */
const SUPPORT = {
  autoOpenAfterLookup: true, // show the popup once per browser session after a successful lookup
  methods: [
    {
      title: 'Bank transfer',
      rows: [
        ['Bank', 'Opay'],
        ['Account name', 'James Adebayo'],
        ['Account number', '9157756523'],
      ],
    },
    // { title: 'Pay online', link: 'https://paystack.com/pay/your-link', label: 'Open payment page' },
  ],
};
/* ================================================= */

const CATEGORIES = {
  1: 'DNS compromise', 2: 'DNS poisoning', 3: 'Fraud orders', 4: 'DDoS attack', 5: 'FTP brute-force',
  6: 'Ping of death', 7: 'Phishing', 8: 'Fraud VoIP', 9: 'Open proxy', 10: 'Web spam', 11: 'Email spam',
  12: 'Blog spam', 13: 'VPN IP', 14: 'Port scan', 15: 'Hacking', 16: 'SQL injection', 17: 'Spoofing',
  18: 'Brute-force', 19: 'Bad web bot', 20: 'Exploited host', 21: 'Web app attack', 22: 'SSH', 23: 'IoT targeted'
};
const ARC_LEN = Math.PI * 90;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);
const form = $('form'), ipInput = $('ip'), goBtn = $('go'), notice = $('notice');

// Build DOM with textContent only: report comments are written by strangers, never inject them as HTML.
function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node[k] = v;
  for (const kid of kids) node.append(kid);
  return node;
}

function say(msg, isError = false) {
  notice.textContent = msg;
  notice.className = isError ? 'error' : '';
}

function lockUntil(iso) {
  goBtn.disabled = true;
  ipInput.disabled = true;
  say('Your lookup for today is used. Next one opens ' + new Date(iso).toLocaleString() + '.');
}

const scoreColor = (n) => (n >= 75 ? 'var(--bad)' : n >= 25 ? 'var(--warn)' : 'var(--ok)');
const scoreVerdict = (n) => (n >= 75 ? 'Likely abusive' : n >= 25 ? 'Suspicious' : 'Looks clean');

function countUp(el, to) {
  if (REDUCED || to === 0) { el.textContent = to; return; }
  const start = performance.now(), dur = 1000;
  (function tick(now) {
    const t = Math.min((now - start) / dur, 1);
    el.textContent = Math.round(to * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(tick);
  })(start);
}

function render(d) {
  const score = d.abuseConfidenceScore;
  const result = $('result');
  result.classList.remove('show');
  void result.offsetWidth; // restart the entrance animation
  result.classList.add('show');

  const arc = $('arc');
  arc.style.stroke = scoreColor(score);
  arc.style.transition = 'none';
  arc.style.strokeDasharray = ARC_LEN;
  arc.style.strokeDashoffset = ARC_LEN;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    arc.style.transition = REDUCED ? 'none' : 'stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1)';
    arc.style.strokeDashoffset = ARC_LEN * (1 - score / 100);
  }));
  countUp($('scoreNum'), score);
  $('verdict').textContent = scoreVerdict(score);
  $('verdict').style.color = scoreColor(score);
  $('verdictIp').textContent = d.ipAddress;

  const rows = [
    ['Country', d.countryName ? `${d.countryName} (${d.countryCode})` : d.countryCode || 'Unknown'],
    ['ISP', d.isp || 'Unknown'],
    ['Usage type', d.usageType || 'Unknown'],
    ['Domain', d.domain || 'None'],
    ['Hostnames', d.hostnames && d.hostnames.length ? d.hostnames.join(', ') : 'None'],
    ['Tor exit node', d.isTor ? 'Yes' : 'No'],
    ['Allowlisted', d.isWhitelisted ? 'Yes' : 'No'],
    ['Total reports', `${d.totalReports} from ${d.numDistinctUsers} distinct reporters`],
    ['Last reported', d.lastReportedAt ? new Date(d.lastReportedAt).toLocaleString() : 'Never'],
  ];
  const facts = $('facts');
  facts.replaceChildren();
  for (const [k, v] of rows) facts.append(h('dt', { textContent: k }), h('dd', { textContent: String(v) }));

  const list = $('reports');
  list.replaceChildren();
  const reports = (d.reports || []).slice(0, 10);
  if (!reports.length) list.append(h('li', { className: 'empty', textContent: 'No reports in the last 90 days.' }));
  for (const r of reports) {
    const tags = h('div', { className: 'tags' });
    for (const c of r.categories || []) tags.append(h('span', { className: 'tag', textContent: CATEGORIES[c] || 'Category ' + c }));
    const where = r.reporterCountryName ? ' from ' + r.reporterCountryName : '';
    list.append(h('li', {},
      h('div', { className: 'meta', textContent: new Date(r.reportedAt).toLocaleString() + where }),
      r.comment ? h('p', { className: 'comment', textContent: r.comment }) : '',
      tags
    ));
  }
  result.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip = ipInput.value.trim();
  if (!ip) return;
  goBtn.disabled = true;
  document.body.classList.add('scanning'); // radar speeds up while the lookup runs
  say('Scanning…');
  try {
    const res = await fetch('/api/check?ip=' + encodeURIComponent(ip));
    const body = await res.json();
    if (!res.ok) {
      if (res.status === 429 && body.resetsAt) return lockUntil(body.resetsAt);
      goBtn.disabled = false;
      return say(body.error || 'Something went wrong.', true);
    }
    render(body.data);
    lockUntil(body.resetsAt);
    maybeAutoOpenSupport();
  } catch {
    goBtn.disabled = false;
    say('Could not reach the server. Try again.', true);
  } finally {
    document.body.classList.remove('scanning');
  }
});

fetch('/api/status').then(r => r.json()).then(s => {
  if (s.ip && !ipInput.value) ipInput.value = s.ip; // prefill with the visitor's own IP
  if (!s.allowed) lockUntil(s.resetsAt);
}).catch(() => {});

/* ---------- ticker: duplicate the items so the loop is seamless ---------- */
const track = document.querySelector('.track');
track.append(...[...track.children].map((n) => n.cloneNode(true)));
track.querySelectorAll('span').forEach((s, i, all) => { if (i >= all.length / 2) s.setAttribute('aria-hidden', 'true'); });

/* ---------- reveal sections as they scroll into view ---------- */
const revealTargets = document.querySelectorAll(
  '.section .wrap > h2, .section .wrap > .intro, .steps li, .band, .cats div, .uses > div, .faq details, .support'
);
revealTargets.forEach((el) => {
  el.classList.add('reveal');
  const idx = [...el.parentElement.children].indexOf(el);
  el.style.transitionDelay = Math.min(idx, 5) * 90 + 'ms';
});
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
  }, { threshold: 0.15 });
  revealTargets.forEach((el) => io.observe(el));
} else {
  revealTargets.forEach((el) => el.classList.add('in'));
}

/* ---------- support dialog ---------- */
const dialog = $('supportDialog');

function buildMethods() {
  const box = $('methods');
  box.replaceChildren();
  for (const m of SUPPORT.methods) {
    const card = h('div', { className: 'method' }, h('h3', { textContent: m.title }));
    for (const [label, value] of m.rows || []) {
      const copy = h('button', { type: 'button', className: 'ghost small', textContent: 'Copy' });
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(value);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Press and hold to copy';
        }
        setTimeout(() => (copy.textContent = 'Copy'), 1800);
      });
      card.append(h('div', { className: 'row' }, h('span', { textContent: label }), h('b', { textContent: value }), copy));
    }
    if (m.link) card.append(h('a', { className: 'btn small', href: m.link, target: '_blank', rel: 'noopener', textContent: m.label || 'Open' }));
    box.append(card);
  }
}

function openSupport() {
  buildMethods();
  if (!dialog.open) dialog.showModal();
}

document.querySelectorAll('[data-open-support]').forEach((b) => b.addEventListener('click', openSupport));
$('closeSupport').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // click on backdrop

function maybeAutoOpenSupport() {
  if (!SUPPORT.autoOpenAfterLookup) return;
  try {
    if (sessionStorage.getItem('supportShown')) return;
    sessionStorage.setItem('supportShown', '1');
  } catch { /* storage blocked: still show once per page load */ }
  setTimeout(openSupport, 3500);
}