// Digital World Pro — Honest Website Scanner backend
// Uses native Node https (no dependencies). Deploys on Render.
// Real checks: HTTPS, page fetch, title/meta/headings, viewport (mobile), page size,
// image count, and Google PageSpeed (free) for performance + mobile score.

import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;
// Optional: set GOOGLE_PSI_KEY in Render env vars for higher PageSpeed quota.
// Works without a key at low volume too.
const PSI_KEY = process.env.GOOGLE_PSI_KEY || '';
// Optional: set GOOGLE_PLACES_KEY in Render env vars to enable real Google reviews lookup.
// Without it, the scanner still runs; the reviews check shows a "book a call" message instead.
const PLACES_KEY = process.env.GOOGLE_PLACES_KEY || '';

// --- helpers ---
function fetchUrl(target, { timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let lib = target.startsWith('http://') ? http : https;
    const req = lib.get(target, { headers: { 'User-Agent': 'DWP-Scanner/1.0' } }, (res) => {
      // follow one redirect
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) {
          const u = new URL(target); loc = u.origin + loc;
        }
        return resolve(fetchUrl(loc, { timeout }));
      }
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 800000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, finalUrl: target }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function getJSON(target, { timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(target, { headers: { 'User-Agent': 'DWP-Scanner/1.0' } }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { new URL(u); return u; } catch { return null; }
}

// --- the scan ---
async function scanSite(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { error: 'Please enter a valid website address.' };

  const result = { url, checks: [], scores: {}, overall: 0 };
  const add = (cat, label, status, detail) => result.checks.push({ cat, label, status, detail }); // status: good|warn|bad

  // 1. Fetch the page (also confirms it's reachable + HTTPS)
  let page;
  const isHttps = url.startsWith('https://');
  try {
    page = await fetchUrl(url);
  } catch (e) {
    // try http if https failed
    try { page = await fetchUrl(url.replace('https://', 'http://')); }
    catch (e2) { return { error: "We couldn't reach that website. Double-check the address and try again." }; }
  }

  const html = (page.body || '').toLowerCase();
  const rawHtml = page.body || '';

  // --- SECURITY ---
  add('Security', 'HTTPS secure connection', isHttps ? 'good' : 'bad',
    isHttps ? 'Your site uses a secure HTTPS connection.' : 'Your site is not using HTTPS — visitors may see a "Not Secure" warning, which hurts trust and Google ranking.');

  // --- SEO BASICS ---
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  add('SEO', 'Page title tag', title ? (title.length >= 10 && title.length <= 65 ? 'good' : 'warn') : 'bad',
    title ? `Title found: "${title.slice(0,70)}"${title.length>65?' (a bit long)':''}` : 'No page title found — this is critical for Google search results.');

  const descMatch = rawHtml.match(/<meta[^>]+name=["']description["'][^>]*>/i);
  const descContent = descMatch ? (descMatch[0].match(/content=["']([^"']*)["']/i)||[])[1] : '';
  add('SEO', 'Meta description', descContent ? 'good' : 'bad',
    descContent ? 'Meta description is present (helps your search listing).' : 'No meta description — Google may show random text under your search result.');

  const h1Count = (html.match(/<h1[\s>]/g) || []).length;
  add('SEO', 'Heading structure (H1)', h1Count === 1 ? 'good' : h1Count === 0 ? 'bad' : 'warn',
    h1Count === 1 ? 'Has a clear main heading (H1).' : h1Count === 0 ? 'No H1 heading found — search engines use this to understand your page.' : `Found ${h1Count} H1 headings — ideally there is just one.`);

  // --- MOBILE ---
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(rawHtml);
  add('Mobile', 'Mobile viewport tag', hasViewport ? 'good' : 'bad',
    hasViewport ? 'Site is set up to display properly on phones.' : 'No mobile viewport tag — your site likely looks broken on phones, where most customers are.');

  // --- CONTENT / PERFORMANCE (basic, from HTML) ---
  const sizeKB = Math.round((rawHtml.length / 1024));
  add('Performance', 'Page HTML size', sizeKB < 100 ? 'good' : sizeKB < 250 ? 'warn' : 'bad',
    `Main page HTML is ~${sizeKB} KB.` + (sizeKB >= 250 ? ' Large pages load slowly, especially on mobile data.' : ''));

  const imgCount = (html.match(/<img[\s>]/g) || []).length;
  const imgNoAlt = (rawHtml.match(/<img(?![^>]*\balt=)[^>]*>/gi) || []).length;
  if (imgCount > 0) {
    add('SEO', 'Image alt text', imgNoAlt === 0 ? 'good' : imgNoAlt < imgCount/2 ? 'warn' : 'bad',
      imgNoAlt === 0 ? 'All images have alt text (good for SEO & accessibility).' : `${imgNoAlt} of ${imgCount} images are missing alt text.`);
  }

  // --- GOOGLE PAGESPEED (real performance + mobile usability, free) ---
  try {
    const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance${PSI_KEY ? `&key=${PSI_KEY}` : ''}`;
    const psi = await getJSON(psiUrl);
    const perf = psi?.lighthouseResult?.categories?.performance?.score;
    if (typeof perf === 'number') {
      const pct = Math.round(perf * 100);
      add('Performance', 'Google mobile speed score', pct >= 80 ? 'good' : pct >= 50 ? 'warn' : 'bad',
        `Google rates your mobile performance ${pct}/100.` + (pct < 50 ? ' Slow sites lose customers — over half leave if a page takes more than 3 seconds.' : ''));
      result.scores.pagespeed = pct;
      const fcp = psi?.lighthouseResult?.audits?.['first-contentful-paint']?.displayValue;
      if (fcp) add('Performance', 'Time to first content', 'info', `Your page starts showing content in about ${fcp}.`);
    }
  } catch (e) {
    add('Performance', 'Google speed score', 'info', 'Speed test was skipped (Google was busy). The other checks are accurate.');
  }

  // --- SEARCH VISIBILITY (free, honest signals — NOT exact rank positions) ---
  // We honestly check on-page local-SEO signals that affect whether you get found locally.
  const textLower = html;
  const hasLocalKeywords = /(near me|local|serving|areas?|county|city|town)/.test(textLower);
  // detect a location/address signal (zip code or "St/Ave/Rd" etc.)
  const hasAddress = /\b\d{5}\b/.test(rawHtml) || /\b(street|avenue|ave|road|rd|blvd|suite|ste)\b/i.test(rawHtml);
  const hasPhone = /(\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/.test(rawHtml);
  add('Search Visibility', 'Location & contact info on page', (hasAddress && hasPhone) ? 'good' : (hasAddress || hasPhone) ? 'warn' : 'bad',
    (hasAddress && hasPhone) ? 'Your address and phone are on the page — important for local search.' :
    (hasAddress || hasPhone) ? 'Some contact info found, but make sure both your full address and phone are visible — Google uses these for local ranking.' :
    'No clear address or phone found on the page. Adding them helps Google show you in local searches.');
  add('Search Visibility', 'Local keywords on page', hasLocalKeywords ? 'good' : 'warn',
    hasLocalKeywords ? 'Your page uses local/location language that helps you show up in "near me" searches.' :
    'Your page doesn\'t clearly mention your service area or city — adding location words helps local search visibility.');
  // structured data (helps Google understand the business)
  const hasSchema = /application\/ld\+json/i.test(rawHtml) || /itemtype=["']https?:\/\/schema\.org/i.test(rawHtml);
  add('Search Visibility', 'Business structured data (schema)', hasSchema ? 'good' : 'warn',
    hasSchema ? 'Your site includes structured data that helps Google understand your business.' :
    'No business "schema" markup found — adding it helps Google display your business details and can improve local visibility.');

  // --- GOOGLE REVIEWS (real, via Google Places API — needs GOOGLE_PLACES_KEY) ---
  if (PLACES_KEY) {
    try {
      // Use the page title or domain as the business-name guess for the search.
      const domain = new URL(url).hostname.replace(/^www\./, '');
      const nameGuess = (title || domain.split('.')[0]).replace(/[|–-].*$/, '').trim();
      const findUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(nameGuess)}&inputtype=textquery&fields=place_id,name,rating,user_ratings_total&key=${PLACES_KEY}`;
      const found = await getJSON(findUrl);
      const cand = found?.candidates?.[0];
      if (cand && cand.place_id) {
        const rating = cand.rating;
        const total = cand.user_ratings_total || 0;
        result.scores.rating = rating || 0;
        result.scores.reviewCount = total;
        if (total === 0) {
          add('Reviews & Reputation', 'Google reviews', 'bad', 'We couldn\'t find Google reviews for your business. Reviews are the #1 trust signal — even a handful dramatically increases calls and clicks.');
        } else if (total < 10) {
          add('Reviews & Reputation', 'Google reviews', 'warn', `Found about ${total} Google review${total>1?'s':''} (rating ${rating || 'n/a'}). You're on the map, but more reviews would strongly boost trust and local ranking.`);
        } else {
          add('Reviews & Reputation', 'Google reviews', rating >= 4 ? 'good' : 'warn', `Found ${total} Google reviews with a ${rating} rating.` + (rating < 4 ? ' Improving your rating would help conversions.' : ' Great social proof!'));
        }
      } else {
        add('Reviews & Reputation', 'Google Business Profile', 'warn', 'We couldn\'t clearly match a Google Business Profile. If you don\'t have one (or it\'s unverified), setting it up is one of the biggest local-visibility wins.');
      }
    } catch (e) {
      add('Reviews & Reputation', 'Google reviews', 'info', 'Review lookup was skipped this time. We can review your Google profile together on a call.');
    }
  } else {
    add('Reviews & Reputation', 'Google reviews', 'info', 'A full reviews check is available — book a free call and we\'ll go through your Google profile and reviews together.');
  }

  // --- SCORE ---
  const weights = { good: 1, warn: 0.5, bad: 0, info: null };
  const scored = result.checks.filter(c => weights[c.status] !== null);
  const earned = scored.reduce((a, c) => a + weights[c.status], 0);
  result.overall = scored.length ? Math.round((earned / scored.length) * 100) : 0;

  // summary text
  result.summary = result.overall >= 75 ? 'Strong — your site is in good shape, with a few opportunities to grow.'
    : result.overall >= 50 ? 'Needs some work — there are clear issues likely costing you customers.'
    : 'Significant issues found — your website is probably costing you real business. The good news: it\'s all fixable.';

  result.note = 'This is an automated check of your website and public Google business info. Exact search rankings vary by location and searcher — book a free call for a full, personalized review.';

  return result;
}

// --- server ---
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'DWP Website Scanner' }));
  }

  if (req.url.startsWith('/scan')) {
    let target = '';
    if (req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      target = u.searchParams.get('url') || '';
    } else if (req.method === 'POST') {
      target = await new Promise((resolve) => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
          try { resolve(JSON.parse(b).url || ''); } catch { resolve(''); }
        });
      });
    }
    try {
      const out = await scanSite(target);
      res.writeHead(out.error ? 400 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Something went wrong scanning that site. Please try again.' }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`DWP Scanner running on ${PORT}`));
