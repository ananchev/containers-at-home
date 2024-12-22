* Create backup for the container data
```shell
docker exec -it zigbee2mqtt /bin/sh -c '
  tar \
    -czf /tmp/backup.tar.gz -C /app/data .
'
```

* After the backup is completed, copy the backup file from the container to the host machine.
```shell
docker cp zigbee2mqtt:/tmp/backup.tar.gz /mnt/docker/zigbee2mqtt
```