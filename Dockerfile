FROM node:26.7.0-slim@sha256:4ebb5ace66f15a24c14c492e01a8beeed4fddf970a856109f5126e703e5fe503

WORKDIR /app

COPY package.json package-lock.json ./
# postinstall disabled via SCRIVENER_SKIP_POSTINSTALL; scripts skipped intentionally
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV SCRIVENER_SKIP_POSTINSTALL=true
# The server uses progressive tool disclosure by default (token-efficient for
# interactive clients). In the container image — used by registries, inspectors,
# and hosted gateways — advertise the full tool set so introspection sees everything.
ENV SCRIVENER_MCP_EAGER_TOOLS=1

USER node

ENTRYPOINT ["node", "dist/index.js"]
