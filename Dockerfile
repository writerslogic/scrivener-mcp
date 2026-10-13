FROM node:26.11-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0

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
