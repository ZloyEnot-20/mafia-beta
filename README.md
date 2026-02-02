# Mafia Chat Lounge - Backend Server

Backend server for Mafia Chat Lounge game built with Node.js, Express, TypeScript, and Socket.IO.

## Features

- Real-time multiplayer game server
- Room management (create, join, leave)
- Game state management (phases, rounds, voting)
- Socket.IO for real-time communication
- TypeScript for type safety

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
PORT=3001
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

## Development

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Production

```bash
npm start
```

## Docker

### Using Docker Compose (Recommended)

```bash
# Build and start all services (server + Redis)
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Stop and remove volumes
docker-compose down -v
```

### Using Docker only

```bash
# Build image
docker build -t mafia-server .

# Run container
docker run -p 3001:3001 --env-file .env mafia-server
```

**Note:** When using Docker, make sure Redis is accessible. Use `redis` as hostname when running with docker-compose, or `localhost` when running Redis separately.

## Project Structure

```
server/
├── src/
│   ├── types/          # TypeScript type definitions
│   ├── models/         # Data models (Room, Player, etc.)
│   ├── services/       # Business logic services
│   ├── handlers/       # Socket.IO event handlers
│   └── index.ts        # Entry point
├── package.json
├── tsconfig.json
└── .env.example
```

## API Endpoints

- `GET /health` - Health check endpoint

## Socket.IO Events

### Client to Server

- `room:create` - Create a new game room
- `room:join` - Join an existing room
- `room:leave` - Leave current room
- `game:start` - Start the game (host only)
- `action:vote` - Vote for a player
- `action:night-action` - Perform night action
- `chat:send` - Send chat message

### Server to Client

- `room:joined` - Room joined confirmation
- `room:player-joined` - Player joined notification
- `room:player-left` - Player left notification
- `game:started` - Game started
- `game:phase-changed` - Game phase changed
- `action:vote-received` - Vote received notification
- `action:vote-result` - Voting result
- `chat:message` - Chat message received
- `error` - Error message

## Game Flow

1. **Lobby** - Players join and wait for game start
2. **Night** - Special roles perform actions
3. **Discussion** - Players discuss (individual turns, then general)
4. **Voting** - Players vote (individual turns)
5. **Result** - Player elimination and game end check
6. Repeat from Night or end game

## License

ISC
