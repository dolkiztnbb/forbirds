# Tor/I2P: read-only access and automatic write restrictions

## Deployment (migration 007)

Back up the SQLite database and storage consistently; pause application writes.
Update all PHP/JS files together, then run as the PHP service user with the same
`FORBIRDS_STORAGE` as the HTTP application:

```sh
php bin/console.php migrate
```

For the existing Docker layout:

```sh
docker exec -u www-data -w /var/www/forbirds forbirds-php php bin/console.php migrate
```

**Installing the migration alone does not detect Tor exits or unknown I2P gateways.**
Import current network lists and/or configure a trusted ingress marker below.
There is no universal reliable Tor Browser fingerprint or complete I2P gateway list.

## Operator-managed network lists

```sh
php bin/console.php import-network-list tor /path/to/tor-exits.txt
php bin/console.php import-network-list i2p /path/to/known-i2p-gateways.txt
php bin/console.php network-status
```

Tor format: one IPv4 or IPv6 **address** per line (not consensus/descriptor files).
I2P format: one IPv4/IPv6 address or CIDR per line. Blank lines and `#` comments
are allowed; duplicates are removed. Each import replaces only that source's list
in one transaction. Invalid, empty, unreadable or oversized files leave the
previous list intact. Limits: 16 MiB, 100,000 unique entries. No HTTP API uploads.

For example, an operator can download the Tor Project bulk exit list on the host:

```sh
curl --fail --show-error --silent --proto '=https' \
  https://check.torproject.org/torbulkexitlist -o /tmp/tor-exits.txt
```

Import **only if the download succeeded**. With Docker, copy the file into the
container (it must be readable by www-data) and import there:

```sh
docker cp /tmp/tor-exits.txt forbirds-php:/tmp/tor-exits.txt
docker exec -u www-data -w /var/www/forbirds forbirds-php \
  php bin/console.php import-network-list tor /tmp/tor-exits.txt
```

Schedule successful download + import at least hourly using your host's cron or
systemd timer, monitor failures and `network-status`. The site does **not** make
external requests on visits. It keeps using the last good list during an update
failure; unknown/new exits may therefore bypass classification. `network-status`
warns if a list is missing or older than 24 hours. Lists are not bundled and no
cron job is installed automatically. I2P gateways must be supplied by the operator.

## Trusted I2P/Tor ingress marker

For an operator-controlled .i2p/.onion tunnel, mark its **dedicated server block /
listener** with a server-side FastCGI parameter, inside the PHP location after
including the normal FastCGI parameters:

```nginx
fastcgi_param FORBIRDS_ACCESS_NETWORK i2p;
# use tor for a dedicated onion ingress
```

Or set `FORBIRDS_ACCESS_NETWORK=i2p` in a dedicated PHP pool/container environment.
An environment value applies to **all** traffic handled by that process; do not
set it globally on a PHP service shared with the ordinary public site.

Never derive this parameter from `$http_*`, a browser header, query string or
unvalidated Host header. Keep an ingress listener dedicated to the tunnel; restrict
its reachability at the proxy/firewall. Public client headers named
`ForBirds-Access-Network`, `X-Tor`, `X-I2P-DestHash`, `X-Forwarded-For`, etc. are
ignored by this feature. IP classification uses only `REMOTE_ADDR`. If nginx
sits behind a trusted reverse proxy, configure nginx real_ip with an explicit
trusted-proxy allowlist. PHP does not parse forwarded client addresses.

## Policy and automatic ban list

- Detected Tor/I2P requests may read pages, feeds, search and authorized media.
- **Every POST is denied**, including registration/login/logout, PoW issuance,
  reactions, profile changes, uploads and moderation. No staff-role exemption.
- `GET /api/session` includes only the current visitor's `read_only` boolean;
  no IP, browser hash or network list is exposed. The UI hides the composer and
  disables writes; search, language choice and reading remain available.
- Passive GET/HEAD requests do not add bans. A valid CSRF-protected POST attempt
  adds an automatic persistent write ban for the signed browser cookie and, if
  already authenticated, its account ID. This avoids adding bans from cross-site
  requests with no valid token. Duplicates do not produce repeated event rows.
- The signed cookie is stored as a site-keyed HMAC, not as its raw value. The
  shared Tor exit IP is **not** permanently added to the ordinary IP ban list.
- After leaving Tor/I2P, these bans still deny writes. A user ban also prevents
  login from a fresh browser after correct password verification. Public reading
  remains possible without login. Invalid credentials do not reveal ban status.
- This is not a hardware ban: deleting cookies and using another account/network
  can evade association. UA strings or a shared Tor fingerprint cannot safely
  identify an individual. Unknown I2P gateways/VPNs are not reliably detectable.
- Bans last until explicitly removed. `network_ban_events` keeps add/remove events
  with source, kind, HMAC/account ID, reason, time and nullable actor (system/CLI);
  it does not store raw client IPs. These events are separate from the old audit
  table, whose actor is required. They are retained until operator maintenance.

## Review and recovery

Administrators get an **Автоблокировки Tor/I2P** / **Tor/I2P automatic restrictions**
page in the dashboard. Enable the existing IP/identity privacy checkbox to list
or remove bans. Moderators cannot manage these restrictions. Removal requires a
reason and is recorded. Events are available via the admin-only API.

Each affected signed-in visitor normally has **two records** (browser + account);
remove both to restore writes. If the connection is still Tor/I2P, the current
request is denied regardless of removals and another write attempt adds bans again.

If an administrator restricts their own account, recover through the local CLI
with the correct storage/service user, not through a Tor connection:

```sh
php bin/console.php network-status
# Prints list freshness and private active ban records with IDs.
php bin/console.php remove-network-ban 12 'Appeal accepted after review'
# Repeat for each associated browser/account record. Do not delete the database.
```

No change is made to ordinary account `is_banned` or to existing manually-created
IP/browser/fingerprint bans. Removing a network restriction does not remove those.
