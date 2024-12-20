# Initial installation
1. Build guacamole server
```shell
https://github.com/apache/guacamole-server.git
docker build -t guacamole-server
```

2. Restart chronyd and wait 5s to secure system clock is up to date

3. Build guacamole client
```shell
https://github.com/apache/guacamole-client.git
docker build -t guacamole-client .
```

3. Create DB init script (if new guacamole instance)
```shell
docker run --rm guacamole-client /opt/guacamole/bin/initdb.sh --postgresql > initdb.sql
```

4. Create DB create user script (if new guacamole instance)
#### create_user.sql
```sql
CREATE USER guacamole_user WITH PASSWORD 'some_password';
GRANT ALL PRIVILEGES ON DATABASE guacamole_db TO guacamole_user;
-- These ensure the user has ongoing access rights over the schema objects
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO guacamole_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO guacamole_user;
```

5. Create network
```shell
docker network create guacamole
```

6. Run postgres container
```shell
docker run \
    —name guacamole-postgres \
    --hostname guacamole-postgres \
    --network guacamole \
    -e POSTGRES_PASSWORD=mysecretpassword \
    -e POSTGRES_DB=guacamole_db \
    -v /var/home/ananchev/guacamole-client/1-initdb.sql:/docker-entrypoint-initdb.d/init.sql:Z \
    -v /var/home/ananchev/guacamole-client/create_user.sql:/docker-entrypoint-initdb.d/2-create_user.sql:Z \
    -v pgdata:/var/lib/postgresql/data:Z \
    -d \
    postgres:16-alpine
```

7. Run guacamole server
```shell
docker run \
    --network guacamole \
    --name guacd \
    --hostname guacamole-guacd \
    -d \
    guacamole-server
```

8. Run guacamole client
```shell
docker run \
    --name guacamole \
    --network guacamole \
    -e GUACD_HOSTNAME=guacamole-guacd \
    -e GUACD_PORT=4822 \
    -e POSTGRESQL_HOSTNAME=guacamole-postgres \
    -e POSTGRESQL_DATABASE=guacamole_db \
    -e POSTGRESQL_USERNAME=guacamole_user \
    -e POSTGRESQL_PASSWORD=some_password \
    -p 8080:8080 \
    -d \
    guacamole-client
```

# Backup
1. Use pg_dumpall to back up global objects like roles and permissions
```shell
docker exec guacamole-postgres pg_dumpall -U postgres --globals-only -f /tmp/postgres_globals.sql
docker cp guacamole-postgres:/tmp/postgres_globals.sql postgres_globals.sql
```

2. Use pg_dump to back up the specific Guacamole database
```shell
docker exec guacamole-postgres pg_dump -U postgres -F p -f /tmp/guacamole_db_backup.sql guacamole_db
docker cp guacamole-postgres:/tmp/guacamole_db_backup.sql guacamole_db_backup.sql
```
# Restore
1. Copy the backups inside the container
```shell
docker cp guacamole_db_backup.sql guacamole-postgres:/tmp/
docker cp postgres_globals.sql guacamole-postgres:/tmp/
```
2. Ensure that all users (including guacamole_user) are recreated with their necessary settings
```shell
docker exec guacamole-postgres psql -U postgres --set ON_ERROR_STOP=off -f /tmp/postgres_globals.sql
```
3. Create the target database
```shell
docker exec guacamole-postgres createdb -U postgres guacamole_db
```
4. Restore the database
```shell
docker exec guacamole-postgres psql -U postgres -d guacamole_db -f /tmp/guacamole_db_backup.sql
```