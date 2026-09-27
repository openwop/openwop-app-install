# ADR 0757 — the GitHub Copilot sidecar. Runs next to the backend container in the
# same Cloud Run service (shared localhost); it binds 127.0.0.1 only.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
ENV OPENWOP_COPILOT_SIDECAR_PORT=8791
CMD ["node", "src/bin.js"]
