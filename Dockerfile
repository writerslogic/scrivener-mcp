FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV SCRIVENER_SKIP_POSTINSTALL=true

ENTRYPOINT ["node", "dist/index.js"]
