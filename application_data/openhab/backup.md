* There is a backup script in ```/openhab/runtime/bin```, but it is problematic to run under docker due to expected environment variables to be set. 
* Below script is based on the ```/openhab/runtime/bin/backup```, removing some of the logic and purely creating a backup of userdata and conf folders and storing it under ```${OPENHAB_USERDATA}/backup/backup.tar.gz```

```shell
OPENHAB_USERDATA='/openhab/userdata'
OPENHAB_CONF='/openhab/conf'
BACKUP_DIR="$OPENHAB_USERDATA/backups"
BACKUP_FILE="$BACKUP_DIR/backup.tar.gz"
# Ensure the backup directory exists
mkdir -p "$BACKUP_DIR"
# Remove existing backup file if it exists
if [ -f "$BACKUP_FILE" ]; then
  echo "Removing existing backup file: $BACKUP_FILE"
  rm -f "$BACKUP_FILE"
fi
# Create a new backup, excluding the tmp and cache directories
echo "Creating new backup at $BACKUP_FILE..."
tar \
 --exclude="userdata/backups" \
 --exclude="userdata/tmp" \
 --exclude="userdata/cache" \
 -czvf "$BACKUP_FILE" -C "$OPENHAB_USERDATA/.." "userdata" -C "$OPENHAB_CONF/.." "conf"
echo "Backup created successfully at $BACKUP_FILE"
```


* Run  the backup script as follows
```shell
docker exec -i openhab bash < backup
```

* After the backup is completed, copy the backup file from the container to the host machine.
```shell
docker cp openhab:/openhab/userdata/backup /mnt/docker/openhab
```
