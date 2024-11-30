* Create backup for the container data
```shell
docker exec -i motioneye /bin/sh -c '
  tar \
     --exclude="source" \
     --exclude="docker-*" \
     --exclude="backup.tar.gz" \
     --exclude="Dockerfile" \
    -czf /tmp/backup.tar.gz -C /etc/motioneye .
'
```

* After the backup is completed, copy the backup file from the container to the host machine.
```shell
docker cp motioneye:/tmp/backup.tar.gz /mnt/docker/motioneye2
```