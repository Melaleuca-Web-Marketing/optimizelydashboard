function publicOrigin(value = '') {
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('DASHBOARD_PUBLIC_URL must be an HTTPS URL without credentials, query or fragment.');
  return url.origin;
}
function sameOrigin(req, allowedOrigin = '') {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    return origin.origin === req.headers.origin && (origin.origin === allowedOrigin || origin.host === req.headers.host && origin.protocol === 'http:');
  } catch { return false; }
}
module.exports = { publicOrigin, sameOrigin };
