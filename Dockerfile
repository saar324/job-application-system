FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache su-exec
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY config ./config
COPY docker-entrypoint.sh /usr/local/bin/job-server-entrypoint
RUN chmod 0755 /usr/local/bin/job-server-entrypoint && mkdir -p /app/data && chown -R node:node /app
ENV HOST=0.0.0.0 PORT=4310 JOB_SERVER_DATA=/app/data/state.json
EXPOSE 4310
ENTRYPOINT ["job-server-entrypoint"]
CMD ["node", "src/index.js"]
