# syntax=docker/dockerfile:1.7
#
# Tandem Canvas — single image containing the Go API server with the React
# web bundle baked in. The Go server's spaHandler serves the bundle at /*.
# The MCP gateway is NOT part of this image — it runs as a stdio process
# alongside Claude Code on the user's machine.

# ── Web bundle stage ──────────────────────────────────────────────────────────
# Node 22: pnpm 11+ requires Node 22.13+. Pin pnpm via corepack so the build
# stays reproducible regardless of corepack's "latest" rolling forward.
FROM node:22-alpine AS web-builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

WORKDIR /repo

# Copy lockfile + all workspace package.json files first so the install layer
# caches independently from source changes. pnpm install requires every
# workspace member's package.json even if we only build one of them.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp-gateway/package.json apps/mcp-gateway/package.json
COPY apps/server/package.json apps/server/package.json
COPY internal/shared/package.json internal/shared/package.json

RUN pnpm install --frozen-lockfile

# Now copy sources that the web bundle depends on and build.
COPY internal/shared internal/shared
COPY apps/web apps/web

RUN pnpm --filter @agentcanvas/shared build \
 && pnpm --filter web build

# ── Go API stage ──────────────────────────────────────────────────────────────
# Must track apps/api/go.mod's `go` directive — bumping go.mod without bumping
# this version fails the build with a "requires go >= …" error.
FROM golang:1.25-alpine AS api-builder
WORKDIR /src

COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download

COPY apps/api ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tini \
 && adduser -D -u 10001 tandem
WORKDIR /app

COPY --from=api-builder /out/server /app/server
COPY --from=web-builder /repo/apps/web/dist /app/web/dist

RUN mkdir -p /app/canvas-images && chown -R tandem:tandem /app
USER tandem

ENV PORT=7891 \
    WEB_DIST_PATH=/app/web/dist \
    IMAGE_DIR=/app/canvas-images

EXPOSE 7891
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/server"]
