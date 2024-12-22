## Redis
* Perform  dump of the latest dataset.
```shell
docker exec -it authelia-redis-1 redis-cli save
```

* Copy the backup file from the container to the host machine.
```shell
docker cp authelia-redis-1:/data/dump.rdb /mnt/docker/authelia
```

## Authelia
* Create backup for the container data
```shell
docker exec -it authelia-authelia-1 /bin/sh -c '
  tar \
    -czf /tmp/backup.tar.gz -C /config .
'
```

* After the backup is completed, copy the backup file from the container to the host machine.
```shell
docker cp authelia-authelia-1:/tmp/backup.tar.gz /mnt/docker/authelia
```
