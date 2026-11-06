FROM node:22-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY frontend/ ./
ENV CI=true
ENV GENERATE_SOURCEMAP=false
# The Content Security Policy blocks inline scripts.
ENV INLINE_RUNTIME_CHUNK=false
RUN npm run build && npm cache clean --force

FROM node:22-alpine

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=80

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force && rm -rf /tmp/*
COPY backend/ ./

RUN apk add --no-cache iputils

COPY --from=frontend-build /app/frontend/build /app/frontend/build

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 80

CMD ["node", "app.js"]
