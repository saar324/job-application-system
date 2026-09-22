FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY worker ./worker
COPY worker/docker-entrypoint.sh /usr/local/bin/application-worker-entrypoint
RUN chmod 0755 /usr/local/bin/application-worker-entrypoint \
    && mkdir -p /app/artifacts \
    && chown -R pwuser:pwuser /app
ENV WORKER_HOST=0.0.0.0 WORKER_PORT=4320
EXPOSE 4320
ENTRYPOINT ["application-worker-entrypoint"]
CMD ["node", "worker/server.js"]
