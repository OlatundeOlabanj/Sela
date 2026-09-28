// lib/originGuard.js
//
// Light abuse guard shared by the RPC functions. It accepts requests
// whose Origin or Referer hostname belongs to this site, and rejects
// browsers on other sites. It cannot stop a determined script (headers
// can be spoofed outside a browser), it only blocks casual reuse of the
// RPC key's quota from other web pages. Real rate limiting is the next
// step if abuse shows up.
//
// Hostnames are parsed and compared exactly. A plain substring check
// would let "evil.example/localhost" through.
//
// Extra hosts can be added with the ALLOWED_ORIGINS env var, a comma
// separated list of hostnames. Netlify's own URL and DEPLOY_PRIME_URL
// env vars are trusted automatically.
//
// Made by TJS Code

const DEFAULT_HOSTS = [
  'selaaa.netlify.app',
  'veilpay-tjscode.netlify.app',
  'veilpay.store',
  'localhost',
  '127.0.0.1',
];

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function allowedHosts() {
  const hosts = new Set(DEFAULT_HOSTS);
  for (const v of [process.env.URL, process.env.DEPLOY_PRIME_URL]) {
    const h = hostOf(v || '');
    if (h) hosts.add(h);
  }
  for (const h of (process.env.ALLOWED_ORIGINS || '').split(',')) {
    const t = h.trim().toLowerCase();
    if (t) hosts.add(t);
  }
  return hosts;
}

// Returns true when the request may proceed. A request with no Origin
// and no Referer (curl, server to server) is allowed, same as before.
function isAllowedOrigin(headers) {
  const raw = (headers && (headers.origin || headers.referer)) || '';
  if (!raw) return true;
  const host = hostOf(raw);
  if (!host) return false;
  const hosts = allowedHosts();
  if (hosts.has(host)) return true;
  // Netlify deploy previews look like "deploy-preview-3--selaaa.netlify.app".
  for (const h of hosts) {
    if (host.endsWith('--' + h)) return true;
  }
  return false;
}

module.exports = { isAllowedOrigin };
