#!/usr/bin/env python3
"""Add a dashboard include to the existing HTTPS server, preserving other apps."""
import argparse
import datetime
import os
from pathlib import Path
import re
import shutil
import subprocess

SOURCE = Path('/home/brand/apps/cms-smartling/cms-smartling-connector/scripts/newrequestform.conf')
LIVE = Path('/etc/nginx/conf.d/newrequestform.conf')
SNIPPET = Path('/etc/nginx/snippets/optimizelydashboard.locations.conf')
INCLUDE = '  include /etc/nginx/snippets/optimizelydashboard.locations.conf;'
ANCHOR = '  # Root app: newrequestform on :3000'


def add_include(text):
    if text.count(INCLUDE) == 1:
        return text
    if INCLUDE in text or re.search(r'location\s+(?:=\s+|\^~\s+)?/campaign-monitor', text):
        raise ValueError('Existing campaign-monitor configuration needs manual review.')
    if text.count(ANCHOR) != 1:
        raise ValueError('Expected shared Nginx config anchor was not found exactly once.')
    before = text[:text.index(ANCHOR)]
    block = before[before.rfind('server {'):]
    if not re.search(r'listen\s+443\s+ssl', block) or 'server_name usifhqtsagrqt01.melaleuca.net;' not in block:
        raise ValueError('The insertion point is not the expected HTTPS server.')
    return text.replace(ANCHOR, INCLUDE + '\n\n' + ANCHOR, 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', help='Install, validate and reload; otherwise only check.')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo so both Nginx files can be checked.')
    proposed = {file: add_include(file.read_text()) for file in (SOURCE, LIVE)}
    template = Path(__file__).resolve().parent.parent / 'deploy/nginx.locations.conf'
    proposed[SNIPPET] = template.read_text()
    if SNIPPET.exists() and not SNIPPET.read_text().startswith('# Managed by the optimizelydashboard repository.'):
        raise SystemExit('The snippet path is already owned by another configuration.')
    nginx = shutil.which('nginx') or '/usr/sbin/nginx'
    subprocess.run([nginx, '-t'], check=True)
    for file in proposed:
        print('Will update:' if args.apply else 'Checked:', file)
    if not args.apply:
        print('No changes made. Use --apply to install.')
        return
    backup = Path('/var/backups/optimizelydashboard') / datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup.mkdir(parents=True, mode=0o700)
    originals = {}
    for index, file in enumerate(proposed):
        originals[file] = file.read_bytes() if file.exists() else None
        if file.exists():
            shutil.copy2(file, backup / f'{index}-{file.name}')
    print('Backups:', backup)
    try:
        SNIPPET.parent.mkdir(parents=True, exist_ok=True)
        for file, content in proposed.items():
            file.write_text(content)
        SNIPPET.chmod(0o644)
        subprocess.run([nginx, '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    except Exception:
        for file, original in originals.items():
            if original is None:
                file.unlink(missing_ok=True)
            else:
                file.write_bytes(original)
        print('Restored previous files. Checking and reloading the previous configuration.')
        subprocess.run([nginx, '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
        raise
    print('Dashboard route installed. Other application locations were preserved.')


if __name__ == '__main__':
    main()
