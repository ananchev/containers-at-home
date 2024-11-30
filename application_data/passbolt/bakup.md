* Create backup of the database
```shell
docker exec -i passbolt-db-1 bash -c \
'mysqldump -u${MYSQL_USER} -p${MYSQL_PASSWORD} ${MYSQL_DATABASE} \
> /tmp/passbolt-db.sql'
```
Be sure to use simple-quotes for the bash ```-c``` argument to be able to use ```MYSQL_USER```, ```MYSQL_PASSWORD``` and ```MYSQL_DATABASE``` environment variables.




* Backup the server keys and the ssl certificates
```shell
docker exec -i passbolt-passbolt-1 /bin/sh -c '
mkdir -p /tmp/backup/cert /tmp/backup/gpg &&
cp /etc/ssl/certs/certificate.crt /tmp/backup/cert/ &&
cp /etc/ssl/certs/certificate.key /tmp/backup/cert/ &&
cp /etc/passbolt/gpg/serverkey.asc /tmp/backup/gpg/ &&
cp /etc/passbolt/gpg/serverkey_private.asc /tmp/backup/gpg/ &&
tar -czvf /tmp/backup.tar.gz -C /tmp/backup .
'
```

* After the backup is completed, copy the backup file from the container to the host machine.
```shell
docker cp passbolt-passbolt-1:/tmp/backup.tar.gz /mnt/docker/passbolt \
&& \
docker cp passbolt-db-1:/tmp/passbolt-db.sql /mnt/docker/passbolt
```

mysqldump -upassbolt -pP4ssb0lt passbolt > /tmp/passbolt-db.sql         