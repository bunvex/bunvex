# The bunvex self-hosted backend (STUDY-38, STUDY-40 L2), as Convex's convex-backend image: the compiled
# bunvex-local-backend and Convex's scripts around it. Build from the repository root:
#   docker build -f docker/Dockerfile -t bunvex-backend .
FROM oven/bun:1.4.2-slim AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
ARG BUNVEX_VERSION=docker
RUN bun build --compile --minify-syntax --define "BUNVEX_BUILD_VERSION=\"${BUNVEX_VERSION}\"" \
  packages/bunvex/bin/local-backend.ts --outfile /bunvex-local-backend

FROM debian:bookworm-slim
LABEL org.opencontainers.image.source=https://github.com/bunvex/bunvex
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /bunvex
COPY --from=build /bunvex-local-backend ./bunvex-local-backend
COPY docker/run_backend.sh docker/read_credentials.sh docker/generate_admin_key.sh ./
RUN chmod +x run_backend.sh read_credentials.sh generate_admin_key.sh
VOLUME /bunvex/data
EXPOSE 3210 3211
STOPSIGNAL SIGINT
ENTRYPOINT ["./run_backend.sh"]
