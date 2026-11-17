#!/bin/sh
set -eu
mkdir -p /var/lib/pgbackrest /etc/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest
cp /run/fv/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
chmod 600 /etc/pgbackrest/pgbackrest.conf
chown -R postgres:postgres /etc/pgbackrest /var/lib/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest
cp /run/fv/init.sql /docker-entrypoint-initdb.d/10-fv.sql
chmod 644 /docker-entrypoint-initdb.d/10-fv.sql
exec docker-entrypoint.sh "$@"
