## Backups

### Database (`immich-postgres`)

The DB backup follows the [official Immich guide](https://immich.app/docs/administration/backup-and-restore) and produces a single compressed SQL file.

```shell
docker exec -t immich-postgres pg_dump \
  --clean --if-exists \
  --dbname=immich --username=postgres \
  -f /tmp/immich_db.sql \
&& docker exec immich-postgres gzip -f /tmp/immich_db.sql \
&& docker cp immich-postgres:/tmp/immich_db.sql.gz /path/to/backup/
```

### Media storage (`immich-server`)

The media directory (`/data` inside the container, mapped to `{{ docker_data_root }}/immich/media/` on the host) is backed up via rsync over SSH to the NAS on its dedicated 2.5Gbit interface.

```shell
rsync -a --delete \
  -e "ssh -i ~/.ssh/immich_backup_key -o StrictHostKeyChecking=no" \
  {{ docker_data_root }}/immich/media/ \
  {{ backup_user }}@{{ large_backups_host }}:{{ large_backups_location }}/immich
```

* Both backups are automated via `ansible/backups/take_backups.yml` — the DB via `backup_commands` on `immich-postgres`, the media via `host_commands` on the `immich-server` definition in `backup_definitions.yml`
* The SSH key (`~/.ssh/immich_backup_key`) is deployed to the host by the `immich.yml` playbook from the `{{ backup_private_key }}` vault variable

### Restore

See the restore block in `ansible/applications/immich.yml`. In short:

```shell
gunzip --stdout /tmp/immich_db.sql.gz \
| sed "s/SELECT pg_catalog.set_config('search_path', '', false);/SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', true);/g" \
| docker exec -i immich-postgres psql \
    --dbname=immich --username=postgres \
    --single-transaction --set ON_ERROR_STOP=on
```

The `sed` step is required — without it the `pgvecto.rs` extension breaks due to an empty `search_path` in the dump.

## Versioning & updates

### How to approach updates

* The versions of all Immich containers are pinned in `app_versions.yml`, but even if DIUN will notify for each new one released, only `immich-server` should be considered
* Whenever updating immich, alayway fetch the releted official [docker-compose file](https://github.com/immich-app/immich/releases/latest/download/docker-compose.yml) and from it determine the bundled additional containers
* **DO NOT** update containers independently

### Image name pattern in DIUN's watchlist
* `app_versions.yml` for immich lists the versions with the `ghcr.io` registry prefix
* The image name is passed as-is into the DIUN watchlist. Without `ghcr.io/`, DIUN would default to Docker Hub and look for e.g. immich-app or immich-server there — which does not exist. The full registry prefix is what tells DIUN to query `ghcr.io` instead.

### Image tags
* The "Recent tagged versions" on that page defaults to showing all tags including commit SHAs and PR builds. The versioned releases are not visible
* The [crane](https://github.com/google/go-containerregistry) package can be used to list all tags from the registry and filter with the same regex used in diun_include_pattern

    For immich-server:
    ```bash
    crane ls ghcr.io/immich-app/immich-server \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V
    ```

    For immich-postgres:
    ```bash
    crane ls ghcr.io/immich-app/postgres \
    | grep -E '^\d+-vectorchord[0-9]+\.[0-9]+\.[0-9]+-pgvectors[0-9]+\.[0-9]+\.[0-9]+$'
    ```