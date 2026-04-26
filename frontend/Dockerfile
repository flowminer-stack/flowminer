# syntax=docker/dockerfile:1.6
#
# FlowMiner frontend image.
#
# Multi-stage:
#   * Stage 1 (builder) installs npm deps with `npm ci` (which
#     respects package-lock.json exactly — unlike `npm install`
#     which can pick up newer patch versions) and runs the Vite
#     build.
#   * Stage 2 (runtime) copies the static bundle into nginx.
#
# Pinned base-image tags so rebuilds are reproducible.

# ─── Stage 1: builder ──────────────────────────────────────────────
FROM node:20.18-alpine AS builder

WORKDIR /app

# Copy only the manifest + lock first so the npm-ci layer caches
# independently of source edits.
COPY package.json package-lock.json ./

# npm ci is the reproducible installer — it refuses to run if
# package-lock.json is out of sync with package.json, and it
# never writes back to the lock. This is what you want in CI
# and image builds.
RUN npm ci --no-audit --no-fund --prefer-offline

COPY . .
RUN npm run build


# ─── Stage 2: runtime ──────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Drop the default nginx config and ship our own.
RUN rm /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# Healthcheck: the static bundle is served from / — a 200 means
# nginx is up and has access to the html directory.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
