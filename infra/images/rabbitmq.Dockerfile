ARG RABBITMQ_IMAGE=rabbitmq:4.3-management@sha256:8e913a7748f808be4ce117c3df11817935775bcd83934d4de92441a7e93e9899
FROM ${RABBITMQ_IMAGE}
USER root
COPY infra/images/rabbitmq-entrypoint.sh /usr/local/bin/fv-rabbitmq
RUN chmod 755 /usr/local/bin/fv-rabbitmq
ENTRYPOINT ["fv-rabbitmq"]
CMD ["rabbitmq-server"]
