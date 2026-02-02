import Redis from "ioredis";
import { Room } from "../models/Room.js";
import { GameRoom } from "../types/game.js";

export class RedisService {
  private client: Redis;
  private subscriber: Redis;
  private publisher: Redis;

  constructor() {
    const redisConfig = {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379"),
      password: process.env.REDIS_PASSWORD || undefined,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    };

    this.client = new Redis(redisConfig);
    this.subscriber = new Redis(redisConfig);
    this.publisher = new Redis(redisConfig);

    this.client.on("error", (err) => {
      console.error("Redis Client Error:", err);
    });

    this.client.on("connect", () => {
      console.log("✅ Redis connected");
    });

    this.client.on("ready", () => {
      console.log("✅ Redis ready");
    });
  }

  // Room operations
  async saveRoom(room: Room, ttlSeconds: number = 300): Promise<void> {
    const roomData = JSON.stringify(room.toGameRoom());
    await this.client.setex(`room:${room.getCode()}`, ttlSeconds, roomData); // Default 5 minutes TTL
  }

  async getRoom(roomCode: string): Promise<GameRoom | null> {
    const data = await this.client.get(`room:${roomCode}`);
    return data ? JSON.parse(data) : null;
  }

  async deleteRoom(roomCode: string): Promise<void> {
    await this.client.del(`room:${roomCode}`);
  }

  async roomExists(roomCode: string): Promise<boolean> {
    const exists = await this.client.exists(`room:${roomCode}`);
    return exists === 1;
  }

  // Player to room mapping
  async setPlayerRoom(playerId: string, roomCode: string): Promise<void> {
    await this.client.setex(`player:${playerId}:room`, 3600, roomCode);
  }

  async getPlayerRoom(playerId: string): Promise<string | null> {
    return await this.client.get(`player:${playerId}:room`);
  }

  async removePlayerRoom(playerId: string): Promise<void> {
    await this.client.del(`player:${playerId}:room`);
  }

  // Chat messages
  async addChatMessage(roomCode: string, message: any): Promise<void> {
    await this.client.lpush(`room:${roomCode}:messages`, JSON.stringify(message));
    await this.client.ltrim(`room:${roomCode}:messages`, 0, 99); // Keep last 100 messages
    await this.client.expire(`room:${roomCode}:messages`, 3600);
  }

  async getChatMessages(roomCode: string, limit: number = 50): Promise<any[]> {
    const messages = await this.client.lrange(`room:${roomCode}:messages`, 0, limit - 1);
    return messages.map((msg) => JSON.parse(msg)).reverse();
  }

  // Game state
  async setGameState(roomCode: string, state: any): Promise<void> {
    await this.client.setex(`room:${roomCode}:state`, 3600, JSON.stringify(state));
  }

  async getGameState(roomCode: string): Promise<any | null> {
    const data = await this.client.get(`room:${roomCode}:state`);
    return data ? JSON.parse(data) : null;
  }

  // Pub/Sub for real-time updates
  async publish(channel: string, message: any): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, callback: (message: any) => void): Promise<void> {
    await this.subscriber.subscribe(channel);
    this.subscriber.on("message", (ch, msg) => {
      if (ch === channel) {
        callback(JSON.parse(msg));
      }
    });
  }

  // Health check
  async ping(): Promise<string> {
    return await this.client.ping();
  }

  // Cleanup
  async disconnect(): Promise<void> {
    await this.client.quit();
    await this.subscriber.quit();
    await this.publisher.quit();
  }
}
