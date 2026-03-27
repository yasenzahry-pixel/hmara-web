FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DOWNLOAD_DIR=/app/.runtime/completed

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build \
  && npm prune --omit=dev \
  && mkdir -p /app/.runtime/completed /app/.runtime/work

EXPOSE 3000

CMD ["node", "server.js"]
