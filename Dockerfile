# syntax=docker/dockerfile:1
# One image, several roles: api (default CMD), worker, migrate, seed, demo.
# User interfaces: the web app (web/) is built here and served by the API from the same origin;
# the native desktop client (native/) is built and run on the desktop, not in this image.
# Behind a TLS-inspecting proxy, supply its CA without baking it into the image:
#   docker build --secret id=extra_ca,src=/path/to/ca.pem .
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false sh -c 'if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; npm ci --no-audit --no-fund'
COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY scripts scripts
COPY synthetic synthetic
COPY contracts contracts
RUN npm run build

FROM ${NODE_IMAGE} AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false sh -c 'if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; npm ci --no-audit --no-fund'
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false sh -c 'if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; npm ci --omit=dev --no-audit --no-fund && npm cache clean --force'
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web
ENV WEB_DIR=/app/web
COPY db ./db
COPY contracts ./contracts
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
