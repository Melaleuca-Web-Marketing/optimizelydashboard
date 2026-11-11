const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { publicOrigin, sameOrigin } = require('../deployment');

test('proxy requests allow only the exact configured HTTPS origin, with local use preserved', () => {
  const origin = publicOrigin('https://usifhqtsagrqt01.melaleuca.net/campaign-monitor/');
  const req = value => ({ headers: { host: '127.0.0.1:17821', origin: value } });
  assert.equal(sameOrigin(req(origin), origin), true);
  for (const value of ['https://evil.example', 'http://usifhqtsagrqt01.melaleuca.net', origin + '.evil.example', origin + '/campaign-monitor']) assert.equal(sameOrigin(req(value), origin), false);
  assert.equal(sameOrigin({ headers: { ...req(origin).headers, 'sec-fetch-site': 'cross-site' } }, origin), false);
  assert.equal(sameOrigin(req('http://127.0.0.1:17821')), true);
  assert.equal(sameOrigin(req(origin)), false);
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?secret=x']) assert.throws(() => publicOrigin(value));
});

test('browser assets and API endpoints resolve under a subpath and at localhost root', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.doesNotMatch(html, /(?:src|href)="\/(?:app\.js|style\.css|analytics\.css)"/);
  assert.doesNotMatch(app, /fetch\('\/api\//);
  for (const base of ['https://example.com/campaign-monitor/', 'http://localhost:3002/']) {
    const url = new URL('./api/dashboard?project_id=1', base);
    assert.ok(url.pathname.startsWith(new URL(base).pathname));
  }
});

test('HTTP server accepts proxied HTTPS edits without relaxing the upstream Host check', async t => {
  process.env.DASHBOARD_PUBLIC_URL = 'https://usifhqtsagrqt01.melaleuca.net/campaign-monitor/';
  process.env.OPTIMIZELY_TOKEN = '';
  const { server } = require('../server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const origin = 'https://usifhqtsagrqt01.melaleuca.net';
  let r = await fetch(base + '/api/projects');
  assert.equal(r.status, 200);assert.equal((await r.json()).projects.length, 3);
  r = await fetch(base + '/api/refresh', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 202);
  r = await fetch(base + '/api/refresh', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    require('node:http').get(base + '/api/projects', { headers: { Host: 'other.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  for (const resource of ['/', '/app.js', '/style.css', '/analytics.css']) assert.equal((await fetch(base + resource)).status, 200);
});
