import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[1] / 'scripts/install-nginx.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class NginxIncludeTests(unittest.TestCase):
    def test_preserves_existing_apps_and_is_idempotent(self):
        source = '''server {
  listen 80;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl http2;
  server_name usifhqtsagrqt01.melaleuca.net;
  # Root app: newrequestform on :3000
  location / { proxy_pass http://127.0.0.1:3000; }
  location /content-qa/ { proxy_pass http://127.0.0.1:3002/; }
}
'''
        updated = installer.add_include(source)
        self.assertEqual(updated.replace(installer.INCLUDE + '\n\n', ''), source)
        self.assertEqual(installer.add_include(updated), updated)
        self.assertEqual(updated.count(installer.INCLUDE), 1)

    def test_unexpected_layout_or_existing_route_is_rejected(self):
        for source in ['', installer.ANCHOR, installer.INCLUDE * 2,
                       'location = /campaign-monitor { return 404; }']:
            with self.assertRaises(ValueError):
                installer.add_include(source)


if __name__ == '__main__':
    unittest.main()
