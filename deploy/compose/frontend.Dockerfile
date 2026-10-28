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
ARG VITE_BRAND_MARK_PRE=
ARG VITE_BRAND_MARK_EMPHASIS=
ARG VITE_BRAND_MARK_SUB=
ARG VITE_BRAND_TAGLINE=
ARG VITE_BRAND_FOOTER_TEXT=
ARG VITE_BRAND_ASSISTANT_NAME=
ARG VITE_BRAND_MARK_SRC=
ARG VITE_BRAND_MARK_SRC_DARK=
ARG VITE_BRAND_LOCKUP_SRC=
ARG VITE_BRAND_LOCKUP_SRC_DARK=
ARG VITE_BRAND_LOGO_SRC=
ARG VITE_BRAND_FAVICON_SRC=
ARG VITE_BRAND_DOCUMENT_TITLE=
ARG VITE_BRAND_DESCRIPTION=
ARG VITE_BRAND_FONTS_HREF=
ARG VITE_BRAND_PRIMARY_DOMAIN=
ARG VITE_BRAND_INSTANCE_NAME=
ARG VITE_BRAND_HOME_URL=
ARG VITE_BRAND_REPO_URL=
ARG VITE_BRAND_THEME_COLOR=
ARG VITE_BRAND_DEFAULT_THEME=
ARG VITE_BRAND_APP_GATE_MODE=
ARG VITE_BRAND_APP_GATE_PASSWORD=
ARG VITE_BRAND_PRIVACY_URL=

# `npm ci`, NOT `npm install` — npm >= 11.5 prunes the transitive deps of an
# optionalDependency during `npm install`, and `npm ci` installs exactly the
# lockfile instead. The root Dockerfile carries the measured A/B; this image was
# left behind when that one was fixed, and nothing was watching until
# scripts/check-build-installs.mjs. The lockfile is REQUIRED (npm ci errors
# without one) — that is the intended loud failure.
COPY frontend/react/package.json frontend/react/package-lock.json* ./
RUN npm ci --include=dev

COPY frontend/react/ ./

# Materialize build-time env. Vite's loadEnv(mode='production') reads this file.
RUN printf '%s\n' \
      "VITE_OPENWOP_BASE_URL=${VITE_OPENWOP_BASE_URL}" \
      "VITE_OPENWOP_SSE_BASE_URL=${VITE_OPENWOP_SSE_BASE_URL}" \
      "VITE_OPENWOP_AUTH_MODE=${VITE_OPENWOP_AUTH_MODE}" \
      "VITE_BRAND_PRODUCT_NAME=${VITE_BRAND_PRODUCT_NAME}" \
      "VITE_BRAND_MARK_PRE=${VITE_BRAND_MARK_PRE}" \
      "VITE_BRAND_MARK_EMPHASIS=${VITE_BRAND_MARK_EMPHASIS}" \
      "VITE_BRAND_MARK_SUB=${VITE_BRAND_MARK_SUB}" \
      "VITE_BRAND_TAGLINE=${VITE_BRAND_TAGLINE}" \
      "VITE_BRAND_FOOTER_TEXT=${VITE_BRAND_FOOTER_TEXT}" \
      "VITE_BRAND_ASSISTANT_NAME=${VITE_BRAND_ASSISTANT_NAME}" \
      "VITE_BRAND_MARK_SRC=${VITE_BRAND_MARK_SRC}" \
      "VITE_BRAND_MARK_SRC_DARK=${VITE_BRAND_MARK_SRC_DARK}" \
      "VITE_BRAND_LOCKUP_SRC=${VITE_BRAND_LOCKUP_SRC}" \
      "VITE_BRAND_LOCKUP_SRC_DARK=${VITE_BRAND_LOCKUP_SRC_DARK}" \
      "VITE_BRAND_LOGO_SRC=${VITE_BRAND_LOGO_SRC}" \
      "VITE_BRAND_FAVICON_SRC=${VITE_BRAND_FAVICON_SRC}" \
      "VITE_BRAND_DOCUMENT_TITLE=${VITE_BRAND_DOCUMENT_TITLE}" \
      "VITE_BRAND_DESCRIPTION=${VITE_BRAND_DESCRIPTION}" \
      "VITE_BRAND_FONTS_HREF=${VITE_BRAND_FONTS_HREF}" \
      "VITE_BRAND_PRIMARY_DOMAIN=${VITE_BRAND_PRIMARY_DOMAIN}" \
      "VITE_BRAND_INSTANCE_NAME=${VITE_BRAND_INSTANCE_NAME}" \
      "VITE_BRAND_HOME_URL=${VITE_BRAND_HOME_URL}" \
      "VITE_BRAND_REPO_URL=${VITE_BRAND_REPO_URL}" \
      "VITE_BRAND_THEME_COLOR=${VITE_BRAND_THEME_COLOR}" \
      "VITE_BRAND_DEFAULT_THEME=${VITE_BRAND_DEFAULT_THEME}" \
      "VITE_BRAND_APP_GATE_MODE=${VITE_BRAND_APP_GATE_MODE}" \
      "VITE_BRAND_APP_GATE_PASSWORD=${VITE_BRAND_APP_GATE_PASSWORD}" \
      "VITE_BRAND_PRIVACY_URL=${VITE_BRAND_PRIVACY_URL}" \
      > .env.production \
  && npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY deploy/compose/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
