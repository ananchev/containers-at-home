* Create backup for the container data
```shell
docker exec -i nginx-proxy-manager /bin/sh -c '
  tar \
    -czf /tmp/backup.tar.gz -C /data -C /etc letsencrypt
'
```

* After the backup is completed, copy the backup file from the container to the host machine.
```shell
docker cp nginx-proxy-manager:/tmp/backup.tar.gz /mnt/docker/nginx-proxy-manager
```