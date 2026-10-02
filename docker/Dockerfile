# The bunvex self-hosted server (STUDY-38): `bunvex start` in a container, as Convex's convex-backend image
# runs convex-local-backend. Build from the repository root:
#   docker build -f docker/Dockerfile -t bunvex-backend .
FROM oven/bun:1.4.2-slim AS install
WORKDIR /src
# The whole workspace, so the lockfile matches; only the production dependencies of `bunvex` (the package an
# app installs) and the packages it uses.
COPY . .
RUN bun install --frozen-lockfile --production --filter bunvex
# The database drivers (optional peers of @bunvex/persistence), so POSTGRES_URL / MYSQL_URL / PERSISTENCE=mongodb
# work in the image as Convex's image supports its databases; at the versions the drivers are tested with.
RUN mkdir /drivers && cd /drivers && echo '{}' > package.json && bun add postgres@^3.4.9 mysql2@^3.24.4 mongodb@^7.7.0

FROM oven/bun:1.4.2-slim
LABEL org.opencontainers.image.source=https://github.com/bunvex/bunvex
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /bunvex
COPY --from=install /src/package.json ./package.json
COPY --from=install /src/node_modules ./node_modules
COPY --from=install /drivers/node_modules ./node_modules
COPY --from=install /src/packages ./packages
COPY docker/run_backend.sh docker/generate_admin_key.sh ./
RUN chmod +x run_backend.sh generate_admin_key.sh
VOLUME /bunvex/data
EXPOSE 3210 3211
STOPSIGNAL SIGINT
ENTRYPOINT ["./run_backend.sh"]
