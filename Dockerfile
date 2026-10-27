# syntax=docker/dockerfile:1

# The browser build, served by nginx. Two stages so the image carries the built
# page and not a toolchain: the app is static files plus a proxy.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

# Dependencies first, so a source change does not reinstall them.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM nginx:1.27-alpine

# FRESHRSS_URL is the only thing to set: the server this reader talks to.
# 127.0.0.1 on purpose — an unconfigured container answers its own requests
# instead of proxying somewhere on the internet by accident.
ENV FRESHRSS_URL=http://127.0.0.1:80

COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
