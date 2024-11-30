* Create backup for the container data
```shell
docker exec -i grafana /bin/sh -c '
  tar \
    -czf /tmp/backup.tar.gz -C /var/lib/grafana .
'
```

* After the backup is completed, copy the backup file from the container to the host machine.
```shell
docker cp grafana:/tmp/backup.tar.gz /mnt/docker/grafana
```