1. Stop Writing to InfluxDB: Ensure that no new data is being written to the InfluxDB instance to prevent data inconsistency during the backup.

2. Use the InfluxDB influxd backup command to create a backup:
```shell
docker exec influxdb influxd backup -portable /backup
```
This stores the backup files into a folder ```backup```. Important to note that the portable backup does not contain any users and privileges definition. These need to be defined again upon restore.

3.  After the backup is completed, copy the backup files from the container to the host machine.
```shell
docker cp influxdb:/backup /mnt/docker/influxdb
```