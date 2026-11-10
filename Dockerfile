FROM node:26.13-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS base

WORKDIR /app

FROM rust:1.99.1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c AS c2pa
ENV RUSTUP_TOOLCHAIN=1.96.0
WORKDIR /app
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY native/c2pa-binding ./native/c2pa-binding
COPY scripts/build-c2pa-binding.mjs ./scripts/
RUN rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal --target wasm32-unknown-unknown && cargo install wasm-pack --version 0.14.0 --locked
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
RUN node -e "for (const name of ['narrative-lens', 'bluepencil-node', 'writerslogic-warm']) require(name); const db = new (require('@photostructure/sqlite').DatabaseSync)(':memory:'); db.prepare('SELECT 1').get(); db.close()"

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
