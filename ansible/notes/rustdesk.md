The official rustdesk images (both hbbr and hbbs) are shell-less and shipped only with the RustDesk binaries. In order to keep the backup approach aligned, we create a wrapper image with busy-box

```Dockerfile
FROM busybox:1.36 AS bb
FROM rustdesk/rustdesk-server:1.1.15

# Add busybox
COPY --from=bb /bin/busybox /bin/busybox

# Make tar (and optionally other applets) available as /bin/tar, /bin/sh, etc.
RUN ["/bin/busybox","--install","-s","/bin"]

```
And then build a custom one to use

```shell
docker build -t rustdesk-hbbr:with-tools .

```

* Once the containers are running we can take a backup of the data folder. It is sufficient to take it from only one (any of the two) as same folder is mapped on both:
```shell
docker exec -i rustdesk-hbbr /bin/sh -c '
  tar \
    -czf /tmp/backup.tar.gz -C /root .
'
```

* After the backup is completed, copy the backup file from the container to the host machine.
```shell
docker cp rustdesk-hbbr:/tmp/backup.tar.gz /mnt/zfspool/tmp-backup/rustdesk
```