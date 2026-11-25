# Збірка з кореня репозиторію:  docker build -f server/Dockerfile -t devbridge-relay .
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY shared ./shared
COPY server/relay-server.js ./server/
RUN mkdir -p /app/server/data && chown -R node:node /app/server/data
WORKDIR /app/server
ENV NODE_ENV=production PORT=7000 HOST=0.0.0.0
EXPOSE 7000
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:7000/_devbridge/health || exit 1
CMD ["node", "relay-server.js"]
