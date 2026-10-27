# syntax=docker/dockerfile:1

# The browser build, served as static files. Nothing to configure: the reader
# asks for your FreshRSS address on its own connect screen, like the desktop app.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

# Dependencies first, so a source change does not reinstall them.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
