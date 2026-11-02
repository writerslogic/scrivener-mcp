FROM node:26.12-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS base

WORKDIR /app

FROM rust:1.99.1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b AS c2pa
WORKDIR /app
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY native/c2pa-binding ./native/c2pa-binding
COPY scripts/build-c2pa-binding.mjs ./scripts/
RUN rustup target add wasm32-unknown-unknown && cargo install wasm-pack --version 0.14.0 --locked
RUN node scripts/build-c2pa-binding.mjs

FROM base AS build

RUN node -e "if (process.arch !== 'x64') throw new Error('Narrative Lens requires Linux x64; build with --platform linux/amd64')"
COPY package.json package-lock.json ./
COPY vendor/deepmerge ./vendor/deepmerge
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json README.md LICENSE ./
COPY src ./src
COPY assets ./assets
COPY --from=c2pa /app/assets/c2pa-binding ./assets/c2pa-binding
COPY native/c2pa-binding ./native/c2pa-binding
COPY scripts/check-c2pa-binding.mjs scripts/check-release-candidate.mjs scripts/build-c2pa-binding.mjs ./scripts/
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund
RUN node -e "for (const name of ['narrative-lens', 'bluepencil-node', 'writerslogic-warm']) require(name); const db = new (require('better-sqlite3'))(':memory:'); db.prepare('SELECT 1').get(); db.close()"

FROM base AS runtime

ENV NODE_ENV=production
ENV SCRIVENER_SKIP_POSTINSTALL=true
ENV SCRIVENER_MCP_EAGER_TOOLS=1

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/native ./native
COPY --from=build /app/vendor ./vendor
COPY --from=build /app/package.json /app/package-lock.json /app/README.md /app/LICENSE ./

USER node

ENTRYPOINT ["node", "dist/index.js"]
