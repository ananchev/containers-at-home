* Copy the mosquitto.db file from the container to the host machine.
```shell
docker cp mosquitto:/mosquitto/data/mosquitto.db /mnt/docker/mosquitto
```