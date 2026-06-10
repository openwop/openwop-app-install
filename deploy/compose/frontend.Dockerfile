# Frontend build → nginx edge for the vendor-neutral compose pack.
#
# Build context is the repo ROOT (see docker-compose.yml `web.build.context`),
# so the React app lives at frontend/react/. The VITE_* values arrive as build
# args and are written to .env.production, which `vite build` (mode=production)
# loads and inlines into the bundle. The result is served by nginx, which also
# proxies /api to the backend with SSE buffering off (see nginx.conf).

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

ARG VITE_OPENWOP_BASE_URL=/api
ARG VITE_OPENWOP_SSE_BASE_URL=
ARG VITE_OPENWOP_AUTH_MODE=cookie
ARG VITE_BRAND_PRODUCT_NAME=

COPY frontend/react/package.json frontend/react/package-lock.json* ./
RUN npm install --include=dev

COPY frontend/react/ ./

# Materialize build-time env. Vite's loadEnv(mode='production') reads this file.
RUN printf '%s\n' \
      "VITE_OPENWOP_BASE_URL=${VITE_OPENWOP_BASE_URL}" \
      "VITE_OPENWOP_SSE_BASE_URL=${VITE_OPENWOP_SSE_BASE_URL}" \
      "VITE_OPENWOP_AUTH_MODE=${VITE_OPENWOP_AUTH_MODE}" \
      "VITE_BRAND_PRODUCT_NAME=${VITE_BRAND_PRODUCT_NAME}" \
      > .env.production \
  && npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY deploy/compose/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
