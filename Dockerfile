# One image for every agent; the role comes from AGENT_ID (sellers) or the command (buyer).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.js ./
COPY data ./data
# State (rate.json, ledgers, runs.json, wallet-txs.json) lives on a volume, never in the image.
ENV STATE_DIR=/app/state NODE_ENV=production
# Only the state folder needs to be writable; chown -R over node_modules would copy every file into a new layer (minutes on Docker Desktop).
RUN mkdir -p /app/state && chown node:node /app/state
USER node
EXPOSE 4000
CMD ["node", "-r", "./tracing.js", "agent-server.js"]
