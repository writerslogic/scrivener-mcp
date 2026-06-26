FROM node:26.3.1-slim

WORKDIR /app

COPY package.json package-lock.json ./
# postinstall disabled via SCRIVENER_SKIP_POSTINSTALL; scripts skipped intentionally
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV SCRIVENER_SKIP_POSTINSTALL=true
# Advertise the full tool set on startup so registries/inspectors (Glama, MCP
# Inspector) can introspect every tool without first opening a project.
ENV SCRIVENER_MCP_EAGER_TOOLS=1

USER node

ENTRYPOINT ["node", "dist/index.js"]
