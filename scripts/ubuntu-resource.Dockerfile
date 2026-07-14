FROM node:22.19-bookworm AS node
FROM ubuntu:24.04
COPY --from=node /usr/local /usr/local
ENV DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY . .
RUN npm ci && npm run build
CMD ["npm", "run", "eval:resources:ubuntu"]
