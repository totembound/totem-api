# TotemBound API — local development image (baked source, run directly).
# Built and run via totem-api/docker/docker-compose.yml as the `totem-api` service.
# Talks to the other compose services by hostname (e.g. DYNAMODB_ENDPOINT=http://dynamodb-local:8000).
FROM node:22-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Bake the source (see .dockerignore for what's excluded).
COPY . .

EXPOSE 3001

# DynamoDB Local runs in-memory, so (re)create the tables on every startup,
# then launch the server. depends_on: service_healthy gates this on Dynamo being up.
CMD ["sh", "-c", "node scripts/init-tables.js && node src/local-server.js"]
