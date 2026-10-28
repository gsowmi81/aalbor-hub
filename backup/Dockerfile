# Nightly copy of the database to a bucket outside Render (Cloudflare R2).
FROM postgres:16-alpine
RUN apk add --no-cache aws-cli
COPY backup.sh /backup.sh
RUN chmod +x /backup.sh
ENTRYPOINT ["/backup.sh"]
