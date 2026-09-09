# Provider-neutral School-owned continuous runner. The image has no HTTP server or listening port.
# Build from the repository root; the final layer contains only the bundled Node entrypoint.
FROM node:24.14.1-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/admin-cms/package.json apps/admin-cms/package.json

RUN npm ci --ignore-scripts

COPY apps/admin-cms/tsconfig.json apps/admin-cms/tsconfig.json
COPY apps/admin-cms/src apps/admin-cms/src

RUN npm run build:participant-preview-reminder-runner --workspace=apps/admin-cms

FROM node:24.14.1-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=build /app/apps/admin-cms/dist/participant-preview-reminder-runner.cjs ./participant-preview-reminder-runner.cjs

USER node

CMD ["node", "participant-preview-reminder-runner.cjs"]
