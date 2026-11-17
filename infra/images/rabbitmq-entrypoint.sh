#!/bin/sh
set -eu
cp /run/fv/definitions.json /etc/rabbitmq/definitions.json
chown rabbitmq:rabbitmq /etc/rabbitmq/definitions.json
chmod 600 /etc/rabbitmq/definitions.json
exec docker-entrypoint.sh "$@"
