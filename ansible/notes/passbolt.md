## Backups

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

* Keep backups only from Alpha (`passbolt` + `mariadb-passbolt`).
* Do not back up Beta (`passbolt-recovery` / `mariadb-passbolt-recovery`).
() Beta is disposable and should be rebuilt from fresh Alpha backups, then replication is reconfigured.

## Disaster recovery process

### Credentials

The recovery playbook writes a root-only env file on both hosts so the recovery process can run without access to the normally stored in Passbolt itself passwords.

```shell
{{ docker_data_root }}/{{ passbolt_dir }}/dr-secrets.env
```

It contains the required DR credentials: `PASSBOLT_MYSQL_ROOT_PASSWORD`, `CLOUDFLARE_TOKEN_USERNAME` and `CLOUDFLARE_API_TOKEN` and needs to be loaded for running the DNS update script

```shell
set -a
source <(sudo cat {{ docker_data_root }}/{{ passbolt_dir }}/dr-secrets.env)
set +a
```

### Fail over to recovery host (Beta)

1) Promote recovery MariaDB and disable read-only:

```shell
docker exec -i mariadb-passbolt-recovery mariadb -uroot -p"${PASSBOLT_MYSQL_ROOT_PASSWORD}" \
    -e "STOP SLAVE; RESET SLAVE ALL; SET GLOBAL read_only=OFF;"
```

2) Start Passbolt on recovery host:

```shell
docker start passbolt-recovery
```

3) Update Cloudflare DNS — run `sudo update-dns.sh` **on Beta** (see [Update public DNS](#update-public-dns)).

### Move back to main host

1) Ensure recovery app is stopped before moving DNS back:

```shell
docker stop passbolt-recovery
docker ps --filter "name=passbolt-recovery"
```

2) Confirm main site is healthy on Alpha.

3) Update Cloudflare DNS — run `sudo update-dns.sh` **on Alpha** (see [Update public DNS](#update-public-dns)).

4) Rebuild recovery instance from fresh backup and reconfigure replication for next standby cycle:

   a) Hard-reset Beta: stop and remove `passbolt-recovery` and `mariadb-passbolt-recovery` containers, then delete `{{ docker_data_root }}/passbolt-recovery/mysql-data`.

   b) Re-deploy Beta by running `passbolt-recovery.yml`.

   c) Get the current master coordinates from Alpha:
      ```shell
      sudo /home/apps/passbolt/show-master-status.sh
      ```
      Note the `File` and `Position` values from the output.

   d) Point Beta at Alpha using the coordinates from step (c):
      ```shell
      sudo /home/apps/passbolt-recovery/set-replication-source.sh <File> <Position>
      ```

   e) Verify replication is running on Beta:
      ```shell
      sudo /home/apps/passbolt-recovery/show-slave-status.sh
      ```
      Confirm `Slave_IO_Running: Yes`, `Slave_SQL_Running: Yes`, `Seconds_Behind_Master: 0`.



### Update public DNS

From whatever host we are switching **TO**, so `PUBLIC_IP` resolves to that machine's public IP.

The deployment playbooks create a ready-to-run script at `{{ host_directory }}/update-dns.sh` on both Alpha and Beta (root-only, `0700`). It sources the credentials env file automatically, so no manual `source` step is needed:

```shell
sudo {{ docker_data_root }}/passbolt-recovery/update-dns.sh
```

Commands to update Cloudflare DNS are as follows:

```shell

AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
DOMAIN="passbolt.tonio.cc"
PUBLIC_IP="$(curl -fsS ifconfig.me)"

ZONE_ID="$(curl -fsS \
    -H "${AUTH_HEADER}" \
    "https://api.cloudflare.com/client/v4/zones?name=tonio.cc&status=active" \
    | jq -r '.result[0].id')"

RECORD_ID="$(curl -fsS \
    -H "${AUTH_HEADER}" \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=A&name=${DOMAIN}" \
    | jq -r '.result[0].id')"

PAYLOAD="$(printf '{"type":"A","name":"%s","content":"%s","ttl":1,"proxied":true}' \
    "${DOMAIN}" "${PUBLIC_IP}")"

curl -fsS -X PUT \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}" \
    -H "${AUTH_HEADER}" \
    -H "Content-Type: application/json" \
    --data "${PAYLOAD}"
```