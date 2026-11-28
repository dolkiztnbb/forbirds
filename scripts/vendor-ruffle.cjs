// Keep production PHP-only: commit the pinned runtime, not node_modules or source maps.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.dirname(require.resolve('@ruffle-rs/ruffle/package.json'));
const pkg = require(path.join(root, 'package.json'));
const destination = 'public/vendor/ruffle';
fs.mkdirSync(destination, { recursive: true });
const files = fs.readdirSync(root).filter(name => name === 'ruffle.js' || /^ruffle_web[\w.-]+\.wasm$/.test(name) || name.startsWith('LICENSE_')).sort();
const sums = [];
for (const name of files) {
  const data = fs.readFileSync(path.join(root, name));
  fs.writeFileSync(path.join(destination, name), data);
  sums.push(crypto.createHash('sha256').update(data).digest('hex') + '  ' + name);
}
fs.writeFileSync(path.join(destination, 'README.txt'), `Ruffle ${pkg.version}, @ruffle-rs/ruffle (https://github.com/ruffle-rs/ruffle)\nLicense: MIT OR Apache-2.0; see LICENSE_MIT and LICENSE_APACHE.\nRebuild: npm ci && npm run vendor:ruffle\nOnly JS, WASM and licenses are shipped; no CDN requests are needed.\n\nSHA-256\n${sums.join('\n')}\n`);
