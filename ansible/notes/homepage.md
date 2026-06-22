# homepage

Dashboard (gethomepage.dev) on `fed`, public at `home.tonio.cc` via NPM +
Cloudflare Access mTLS. Config is file-only (no edit UI); the deploy renders it
from a central registry. One app = one playbook (`applications/homepage.yml`).

## Where the content lives (edit these, not the templates)
- `group_vars/all/homepage.yml` — dashboard registry: groups, service tiles, bookmarks.
- `group_vars/all/app_services.yml` — host + named ports a tile resolves through.
- `group_vars/all/lan_addresses.yml` — host → LAN IP.
- `vault.yml: homepage_secrets.<tile>` — widget API keys / credentials.
- Renders to `fed:/opt/docker/homepage/config/` (mounted `/app/config`).

## Common changes
- Add / move / regroup a tile → `homepage.yml` (app: tiles set `port_name`).
- Service moved host → `app_services.yml` (gate + dashboard both follow).
- Wire a widget → add `homepage_secrets.<exact tile name>` to vault (missing = plain link).
- Add a web bookmark → edit `bookmarks.yaml` live on the host (hot-reloads, no redeploy).

## Backup / restore
- Stateless except `bookmarks.yaml` (host-owned: seeded once, then hand-edited live).
- Backed up via the `homepage` entry in `backup_definitions.yml` (rides ZFS + borg).
- Restore: stage `application_data/homepage/bookmarks.yaml`; the deploy copies it
  (create-only) on a fresh host. Everything else is regenerated from the registry.

## Deploy
`./run-playbook.sh fed homepage ~/.ssh/<key>`

Prereqs (one-time, vaulted/external): `homepage_secrets` in `vault.yml`; a
`homepage` image pin in `app_versions.yml` (else `:latest`); NPM proxy host
`home.tonio.cc` → `fed:3010` behind Cloudflare Access mTLS.
