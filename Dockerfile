FROM node:26.12-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec

WORKDIR /app

COPY package.json package-lock.json ./
# postinstall disabled via SCRIVENER_SKIP_POSTINSTALL; scripts skipped intentionally
RUN npm ci --ignore-scripts --no-audit --no-fund

ENV NODE_ENV=production
ENV SCRIVENER_SKIP_POSTINSTALL=true

COPY . .
RUN npm run build

# The server uses progressive tool disclosure by default (token-efficient for
# interactive clients). In the container image — used by registries, inspectors,
# and hosted gateways — advertise the full tool set so introspection sees everything.
ENV SCRIVENER_MCP_EAGER_TOOLS=1

USER node

ENTRYPOINT ["node", "dist/index.js"]
