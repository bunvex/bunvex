# The bunvex dashboard (STUDY-149 PR 7, DV-475), its own image as Convex's convex-dashboard
# (self-hosted/docker-build/Dockerfile.dashboard): the app's static build (apps/dashboard) and
# `bunvex dashboard serve` compiled to serve it, on 6791. BUNVEX_DEPLOYMENT_URL / BUNVEX_ADMIN_KEY prefill the
# sign-in page (Convex's NEXT_PUBLIC_DEPLOYMENT_URL / NEXT_PUBLIC_ADMIN_KEY). Build from the repository root:
#   docker build -f docker/dashboard.Dockerfile -t bunvex-dashboard .
FROM oven/bun:1.4.2-slim AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/dashboard build
RUN bun build --compile --minify-syntax packages/cli/bin/bunvex-dashboard.ts --outfile /bunvex-dashboard

FROM gcr.io/distroless/cc-debian12:nonroot
LABEL org.opencontainers.image.source=https://github.com/bunvex/bunvex
WORKDIR /app
COPY --from=build /bunvex-dashboard ./bunvex-dashboard
COPY --from=build /src/apps/dashboard/dist ./public
EXPOSE 6791
STOPSIGNAL SIGINT
ENTRYPOINT ["/app/bunvex-dashboard", "--hostname", "0.0.0.0", "--port", "6791", "--dir", "/app/public"]
