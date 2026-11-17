ARG POSTGRES_IMAGE=pgvector/pgvector:0.8.7-pg17-trixie@sha256:89947206f52eac3a9df9b663df7e76987cbdc623be6576b3a524953d568700d7
FROM ${POSTGRES_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends pgbackrest=2.60.0-1.pgdg13+1 && rm -rf /var/lib/apt/lists/*
COPY infra/images/postgres-entrypoint.sh /usr/local/bin/fv-postgres
RUN chmod 755 /usr/local/bin/fv-postgres
ENTRYPOINT ["fv-postgres"]
CMD ["postgres","-c","wal_level=replica","-c","archive_mode=on","-c","archive_timeout=60s","-c","archive_command=pgbackrest --stanza=main archive-push %p","-c","max_connections=128","-c","password_encryption=scram-sha-256","-c","log_statement=none","-c","log_min_error_statement=panic","-c","log_parameter_max_length_on_error=0"]
