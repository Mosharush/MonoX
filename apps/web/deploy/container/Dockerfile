FROM nginx:stable-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5

RUN rm -rf /usr/share/nginx/html/*
COPY apps/web/public/ /usr/share/nginx/html/
COPY apps/web/deploy/container/nginx.conf /etc/nginx/conf.d/default.conf

ARG SOURCE_COMMIT
RUN test "${#SOURCE_COMMIT}" -eq 40 && \
    case "$SOURCE_COMMIT" in *[!0-9a-f]*) exit 1 ;; esac && \
    printf '{"commit":"%s"}\n' "$SOURCE_COMMIT" > /usr/share/nginx/html/deployment.json

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
