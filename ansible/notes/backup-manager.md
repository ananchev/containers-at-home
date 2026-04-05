The backup-manager is a backup orchestration application that creates ZFS snapshots and syncs them to my Unraid array with retention policies to clean older backups. It works in combination with the containers-backup application. 

- it creates daily ZFS snapshots
- syncs snapshots to Unraid array using rsync
- manages retention (daily/weekly/monthly) on both ZFS and Unraid sides
- runs borg backups to a remote borg host over SSH
- creates a ZFS snapshot on the remote borg host after each borg run incl. zfs retention policy

**Deploy**
Run the Ansible playbook from the control node.
```bash
# DRY RUN: view intended snapshot/rsync/delete actions without changes
./run-playbook.sh vm backup-manager ~/.ssh/id_rsa_fed -e "dry_run=true"
```

```bash
# PRODUCTION: execute the backup and rotation logic
./run-playbook.sh vm backup-manager ~/.ssh/id_rsa_fed -e "dry_run=false"
```

**Access ZFS snapshots (fast recovery)**
Snapshots are stored on the zfspool and are the fastest way to recover a single file or a whole app directory. They are located in the hidden `.zfs` directory.

```bash
# list all available snapshots
zfs list -t snapshot -r zfspool/containers-backup

# browse files inside a specific snapshot
ls -la /mnt/zfspool/containers-backup/.zfs/snapshot/auto-daily-2026-01-27/
```


**Access array backups (long-term archive)**
These are the rsync-copied versions of the ZFS snapshots stored on the standard Unraid array disks and follow the Grandfather-Father-Son retention policy.

```bash
# list all archived dates
ls -l /mnt/user/backup/containers-backup/

# verify contents of a specific archive
du -sh /mnt/user/backup/containers-backup/2026-01-27/*
```

**Check container logs**
Since the manager runs on a cron schedule inside the container, the Docker logs provide the transfer progress.

```bash
# view the last run and follow new output
docker logs -f zfs-manager
```

**Useful ZFS commands**
To list snapshots, use the zfs list command with the -t snapshot flag. Without the flag, ZFS only shows active datasets.
```bash
# see every snapshot on every pool
zfs list -t snapshot
```

```bash
# see the snapshots for specific pool
zfs list -t snapshot -r zfspool/containers-backup
```

```bash
# see the snapshots in the order they were actually taken
zfs list -t snapshot -s creation -r zfspool/containers-backup
```

```bash
# all snapshots from January
zfs list -t snapshot | grep "2026-01"
```

```bash
# space uniquely consumed vs. the data size
zfs list -t snapshot -o name,creation,used,refer
```

```bash
# log of the commands that modified the pool
zpool history zfspool | grep "containers-backup" | tail -n 20

```


**Troubleshooting "Busy" snapshots**
If the cleanup step fails because a dataset is "busy," it is usually due to a kernel mount hang or a shell being open in that directory.

```bash
# force unmount the snapshot
umount -l /mnt/zfspool/containers-backup/.zfs/snapshot/auto-daily-<DATE>

# manually destroy if the script skipped it
zfs destroy zfspool/containers-backup@auto-daily-<DATE>
```


**Borg backups (offsite)**
After the Unraid sync, the backup-manager runs borg backups to the remote borg host over SSH. The repos and their sources are defined in `global_vars.yml`.

| Repo | Source 

Repos are auto-initialised on the first run and subsequent runs create a new dated archive with `lz4` compression. Deduplication is handled by borg — only changed blocks are transferred.

After each `borg create`, a `borg prune` runs immediately on that repo with `--keep-daily=7 --keep-weekly=4 --keep-monthly=6  ` retention:
* Keep the latest archive for each of the last 7 days
* Keep the latest archive for each of the last 4 weeks
* Keep the latest archive for each of the last 6 months

Credentials are stored inside the backup-manager container at `/etc/backup-manager/` based on the definitions in the `vault.yml`.

```bash
# list archives in a repo from inside the container
docker exec zfs-manager borg list \
  ssh://<borg_remote_user>@<borg_remote_host>/backups-pool/containers-backup

# check the most recent archive
docker exec zfs-manager borg info \
  "ssh://<borg_remote_user>@<borg_remote_host>/backups-pool/containers-backup::$(date +%Y-%m-%d)"
```

**Remote ZFS snapshot (borg host)**
After all borg backups complete, the a ZFS snapshot is created of the `backups-pool` dataset. 
Any old snapshots are cleand using the `ZFS_RETENTION_DAYS` value as for the local ZFS retention.

Snapshots are named `backups-pool@borg-YYYY-MM-DD`.

```bash
# list all borg snapshots on the remote host
ssh <borg_remote_user>@<borg_remote_host> "zfs list -t snapshot -s creation -r backups-pool"

# manually destroy a specific remote snapshot
ssh <borg_remote_user>@<borg_remote_host> "zfs destroy backups-pool@borg-<DATE>"
```