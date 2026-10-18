# syntax=docker/dockerfile:1

# Version and multi-platform digest pins make both stages reviewable and repeatable.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS build
WORKDIR /workspace
ENV CI=true \
    TURBO_TELEMETRY_DISABLED=1

RUN npm install --global pnpm@11.9.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/job-service/package.json ./apps/job-service/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY packages/opportunities/package.json ./packages/opportunities/package.json
COPY packages/source-adapters/package.json ./packages/source-adapters/package.json
RUN pnpm install --frozen-lockfile

COPY apps/web ./apps/web
COPY apps/job-service ./apps/job-service
COPY packages/core ./packages/core
COPY packages/storage ./packages/storage
COPY packages/opportunities ./packages/opportunities
COPY packages/source-adapters ./packages/source-adapters
COPY config/geography/countries.json ./config/geography/countries.json
COPY config/sources/catalog.json ./config/sources/catalog.json
COPY config/geography/china-administrative/catalog.json config/geography/china-administrative/source-manifest.json config/geography/china-administrative/text-aliases.json ./config/geography/china-administrative/
COPY docker/collect-licenses.mjs ./docker/collect-licenses.mjs
COPY docker/license-overrides ./docker/license-overrides
# The container is served at /; Pages has its own /better-me/ build in CI.
RUN pnpm build \
    && test -s apps/web/dist/legal/geography/NOTICE.md \
    && test -s apps/web/dist/legal/geography/NATURAL-EARTH-LICENSE.md \
    && test -s apps/web/dist/legal/geography/manifest.json \
    && test -s apps/web/dist/legal/geography/dots-manifest.json \
    && node docker/collect-licenses.mjs /tmp/better-me-dependency-licenses

FROM nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5 AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="BetterMe static workspace" \
    org.opencontainers.image.description="Local-first resume workspace; job/browser APIs require the local development service." \
    org.opencontainers.image.source="https://github.com/nanfengovo/better-me" \
    org.opencontainers.image.revision=$VCS_REF

RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/mime.types /etc/nginx/better-me.mime.types
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
COPY templates/licenses /usr/share/nginx/html/legal/templates/licenses
COPY templates/README.md templates/CATALOG.md templates/catalog.json /usr/share/nginx/html/legal/templates/
COPY --from=build /workspace/apps/web/src/components/templates /usr/share/nginx/html/legal/adapted-source/templates
COPY --from=build /tmp/better-me-dependency-licenses /usr/share/nginx/html/legal/dependencies
COPY docker/legal.html /usr/share/nginx/html/legal/index.html

USER nginx
EXPOSE 8080
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1

# Skip the upstream entrypoint's configuration rewrites on a read-only filesystem.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
