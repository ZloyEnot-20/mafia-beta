# Docker Setup Guide

## Prerequisites

- Docker and Docker Compose installed

## Quick Start

### Using Docker Compose (Recommended)

1. Create `.env` file in `server/` directory:
```env
PORT=3001
NODE_ENV=production
CORS_ORIGIN=http://localhost:5173
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
```

2. Build and start all services:
```bash
cd server
docker-compose up -d
```

3. View logs:
```bash
docker-compose logs -f
```

4. Stop services:
```bash
docker-compose down
```

5. Stop and remove volumes (clean data):
```bash
docker-compose down -v
```

## Services

### Redis
- **Port**: 6379
- **Volume**: `redis-data` (persistent storage)
- **Health check**: Enabled

### Server
- **Port**: 3001
- **Depends on**: Redis
- **Health check**: Enabled

## Environment Variables

All environment variables can be set in `.env` file or in `docker-compose.yml`.

## Development with Docker

For development, you can mount the source code:

```yaml
volumes:
  - ./src:/app/src
  - ./package.json:/app/package.json
```

Then use `npm run dev` inside the container.
