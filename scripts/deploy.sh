#!/usr/bin/env bash
set -euo pipefail
REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "${REPO_DIR}"
if [[ $(id -un) != brand ]]; then
  printf 'Run as brand, without sudo. Only the Nginx step uses sudo.\n' >&2
  exit 1
fi
for tool in node pm2 curl python3 sudo; do
  command -v "${tool}" >/dev/null || { printf 'Missing command: %s\n' "${tool}" >&2; exit 1; }
done
if [[ ! -f .env ]]; then
  printf 'Create .env from .env.example and set OPTIMIZELY_TOKEN before deploying.\n' >&2
  exit 1
fi
chmod 600 .env
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<19))throw Error("Node 22.19+ required")'
node -e 'const fs=require("fs");const m=fs.readFileSync(".env","utf8").match(/^\s*OPTIMIZELY_TOKEN\s*=\s*(.+)$/m);if(!m||!m[1].trim().replace(/["\x27]/g,"")||m[1].includes("your-token-here"))throw Error("Set OPTIMIZELY_TOKEN in .env")'
# Fail before changing Nginx if the configured port belongs to an unrelated app.
if ! pm2 describe optimizely-dashboard >/dev/null 2>&1; then
  node -e 'const s=require("net").createServer();s.on("error",()=>{console.error("Port 17821 is occupied; review before deploying.");process.exit(1)});s.listen(17821,"127.0.0.1",()=>s.close())'
fi
node --test test/*.test.js
python3 -m unittest discover -s test -p test_nginx.py
sudo python3 scripts/install-nginx.py
pm2 startOrReload ecosystem.config.cjs --only optimizely-dashboard --update-env
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent http://127.0.0.1:17821/api/projects >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ ${healthy} != true ]]; then
  printf 'Dashboard did not become healthy. Nginx has not been changed.\n' >&2
  exit 1
fi
# Confirm the actual data endpoints, not just the running process. No values are printed.
project_ids=$(curl --fail --silent --show-error http://127.0.0.1:17821/api/projects |
  node -e 'let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>{const d=JSON.parse(text);if(!d.projects?.length||d.projects.some(p=>!/^\d+$/.test(p.id)))throw Error("Invalid project list");console.log(d.projects.map(p=>p.id).join("\n"))})')
for project in ${project_ids}; do
  curl --fail --silent --show-error --max-time 180 "http://127.0.0.1:17821/api/dashboard?project_id=${project}" |
    node -e 'let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>{const d=JSON.parse(text);if(!Array.isArray(d.items)||d.sync?.error)throw Error("Project sync failed; inspect dashboard sync status before publishing")})'
done
sudo python3 scripts/install-nginx.py --apply
pm2 save
printf 'Deployed: https://usifhqtsagrqt01.melaleuca.net/campaign-monitor/\n'
printf 'Verify all projects have completed their first Optimizely sync in the browser.\n'
