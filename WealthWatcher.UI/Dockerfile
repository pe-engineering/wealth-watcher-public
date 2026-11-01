FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS builder
WORKDIR /app
COPY WealthWatcher.UI/package*.json ./WealthWatcher.UI/
RUN npm ci --prefix WealthWatcher.UI
COPY WealthWatcher.UI/ ./WealthWatcher.UI/
COPY docs/release-notes/ ./docs/release-notes/
COPY scripts/ ./scripts/
RUN npm run build --prefix WealthWatcher.UI

FROM nginx:alpine@sha256:785835ea65db4bba6f021acc0f3be91b0fef76a53fe41f8588c6698d2aed0606
COPY --from=builder /app/WealthWatcher.UI/dist /usr/share/nginx/html
COPY WealthWatcher.UI/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
