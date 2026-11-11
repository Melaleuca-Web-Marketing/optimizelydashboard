# Server deployment

Public URL: `https://usifhqtsagrqt01.melaleuca.net/campaign-monitor/`.
PM2 process: `optimizely-dashboard`, running as `brand` on `127.0.0.1:17821`.
Port 3002 is reserved by the existing Content QA proxy route and must not be reused.

## First deployment

Run in the existing SSH session as `brand`:

```bash
cd /home/brand/apps/optimizelydashboard
git pull --ff-only
cp -n .env.example .env
chmod 600 .env
vi .env
```

Add `OPTIMIZELY_TOKEN=...` to `.env` privately; do not paste its value into chat or terminal output. PM2 supplies port 17821 and the exact HTTPS public origin from `ecosystem.config.cjs`. The `.env` port is only used when starting `node server.js` directly; do not use it to change the deployed port without updating PM2 and Nginx together.

Then run:

```bash
bash scripts/deploy.sh
```

There are no npm dependencies or build step. Node 22.19+, Python 3.8+, PM2, curl, and sudo access to Nginx are required. The script runs tests, checks the existing Nginx configuration, starts/reloads only the named PM2 process, verifies both project data endpoints, installs the proxy route, validates Nginx, reloads Nginx, and saves the PM2 process list. A sync failure stops deployment before changing Nginx. Existing PM2 apps are not restarted. Verify the host's PM2 boot service separately if restart-on-reboot has not been configured.

## Shared Nginx configuration

The current CMS Smartling deploy script replaces `/etc/nginx/conf.d/newrequestform.conf` from its repository source. A separate top-level server block for this same hostname would conflict with that shared server. Instead, the dashboard installer maintains its own location snippet at `/etc/nginx/snippets/optimizelydashboard.locations.conf` and adds one include inside the existing HTTPS server in BOTH:

- `/etc/nginx/conf.d/newrequestform.conf`
- `/home/brand/apps/cms-smartling/cms-smartling-connector/scripts/newrequestform.conf`

The source-file include must also be committed to the CMS repository through its normal workflow, so a future checkout or reset does not remove it. Other application locations are preserved. The installer expects the inspected server layout and stops for manual review if it differs, or a campaign-monitor route already exists. Backups are retained under `/var/backups/optimizelydashboard/`. If validation or reload fails, previous files are restored and the old configuration is reloaded.

To inspect the installation plan without changing files:

```bash
sudo python3 scripts/install-nginx.py
```

Nginx redirects the bare `/campaign-monitor` URL to `/campaign-monitor/`, strips that prefix when forwarding, and sets the upstream Host to `127.0.0.1:17821`. Static files and browser API requests are relative, so they resolve under the prefix. The app still binds to loopback and rejects other upstream Host headers. Refresh/edit requests accept only the configured public HTTPS origin or the matching localhost origin. Forwarded headers do not determine the allowed origin. Access follows the shared host's existing server-level controls; the app does not add a separate login.

## Verification and updates

After deployment, check:

```bash
curl --fail --silent --show-error https://usifhqtsagrqt01.melaleuca.net/campaign-monitor/api/projects
pm2 status optimizely-dashboard
```

Open the public URL and verify US/CA and MX, Campaigns/Analytics selection after refresh, static styling, Sync now, and exports. Use normal corporate CA trust if curl or Node reports a certificate trust failure; do not disable certificate verification.

For updates, run `git pull --ff-only` and `bash scripts/deploy.sh`. Tokens, snapshots, and saved fallback edits remain in ignored local files. Back up `data/` separately if local edits must be recoverable.
