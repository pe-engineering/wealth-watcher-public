FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS builder
WORKDIR /app
COPY WealthWatcher.UI/package*.json ./WealthWatcher.UI/
RUN npm ci --prefix WealthWatcher.UI
COPY WealthWatcher.UI/ ./WealthWatcher.UI/
COPY docs/release-notes/ ./docs/release-notes/
COPY scripts/ ./scripts/
RUN npm run build --prefix WealthWatcher.UI

FROM nginx:alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2
COPY --from=builder /app/WealthWatcher.UI/dist /usr/share/nginx/html
COPY WealthWatcher.UI/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
