FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

# Les manifestes d'abord : tant qu'ils ne changent pas, Docker réutilise le
# cache de l'installation.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/

# --include=dev : vite et tsx sont des devDependencies mais nécessaires au
# build du client et à l'exécution du serveur.
RUN npm ci --include=dev

COPY . .
RUN npm run build && mkdir -p /data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["npm", "run", "start"]
