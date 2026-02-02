import { Room } from "../models/Room.js";
import { GameSettings } from "../types/game.js";
import { RedisService } from "./RedisService.js";

export class RoomManager {
  private rooms: Map<string, Room>;
  private playerToRoom: Map<string, string>; // playerId -> roomCode
  private redis: RedisService;

  constructor(redis?: RedisService) {
    this.rooms = new Map();
    this.playerToRoom = new Map();
    this.redis = redis || new RedisService();
  }


  async createRoom(hostId: string, hostName: string, settings: GameSettings): Promise<Room> {
    const room = new Room(hostId, hostName, settings);
    this.rooms.set(room.getCode(), room);
    this.playerToRoom.set(hostId, room.getCode());
    // Save room with 5 minutes TTL (300 seconds)
    await this.redis.saveRoom(room, 300);
    await this.redis.setPlayerRoom(hostId, room.getCode());
    return room;
  }

  getRoom(roomCode: string): Room | undefined {
    return this.rooms.get(roomCode);
  }

  getRoomByPlayerId(playerId: string): Room | undefined {
    const roomCode = this.playerToRoom.get(playerId);
    return roomCode ? this.rooms.get(roomCode) : undefined;
  }

  async findPlayerByName(roomCode: string, playerName: string): Promise<string | null> {
    // Try to get room from memory first
    let room = this.rooms.get(roomCode);
    
    // If not in memory, try to load from Redis
    if (!room) {
      const roomData = await this.redis.getRoom(roomCode);
      if (roomData) {
        room = Room.fromGameRoom(roomData);
        this.rooms.set(roomCode, room);
        // Restore player-to-room mappings
        room.getAllPlayers().forEach((player) => {
          this.playerToRoom.set(player.id, roomCode);
        });
      }
    }
    
    if (!room) {
      return null;
    }
    
    const player = room.getAllPlayers().find(p => p.name === playerName);
    return player ? player.id : null;
  }

  async findPlayerById(roomCode: string, playerId: string): Promise<boolean> {
    // Try to get room from memory first
    let room = this.rooms.get(roomCode);
    
    // If not in memory, try to load from Redis
    if (!room) {
      const roomData = await this.redis.getRoom(roomCode);
      if (roomData) {
        room = Room.fromGameRoom(roomData);
        this.rooms.set(roomCode, room);
        // Restore player-to-room mappings
        room.getAllPlayers().forEach((player) => {
          this.playerToRoom.set(player.id, roomCode);
        });
      }
    }
    
    if (!room) {
      return false;
    }
    
    const player = room.getPlayer(playerId);
    return player !== undefined;
  }

  /**
   * Get active room for a player by their persistent ID
   * Checks Redis first, then memory
   */
  async getActiveRoomForPlayer(playerId: string): Promise<{ roomCode: string; room: Room } | null> {
    // First check Redis mapping
    const roomCode = await this.redis.getPlayerRoom(playerId);
  console.log(this.rooms + " rooms");
  console.log(roomCode + " roomCode");

    if (roomCode) {
      // Try to get room from memory
      let room = this.rooms.get(roomCode);
      
      // If not in memory, load from Redis
      if (!room) {
        const roomData = await this.redis.getRoom(roomCode);
        if (roomData) {
          room = Room.fromGameRoom(roomData);
          this.rooms.set(roomCode, room);
          // Restore player-to-room mappings
          room.getAllPlayers().forEach((player) => {
            this.playerToRoom.set(player.id, roomCode);
          });
        }
      }
      
      // Verify player is still in the room
      if (room) {
        const player = room.getPlayer(playerId);
        if (player) {
          return { roomCode, room };
        } else {
          // Player not in room, clean up mapping
          await this.redis.removePlayerRoom(playerId);
          this.playerToRoom.delete(playerId);
        }
      }
    }
    
    // Fallback: check memory mapping
    const memoryRoomCode = this.playerToRoom.get(playerId);
    if (memoryRoomCode) {
      const room = this.rooms.get(memoryRoomCode);
      if (room) {
        const player = room.getPlayer(playerId);
        if (player) {
          return { roomCode: memoryRoomCode, room };
        }
      }
    }
    
    return null;
  }

  async joinRoom(roomCode: string, playerId: string, playerName: string): Promise<Room | null> {
    // Check if player is already in a room
    const existingRoomCode = this.playerToRoom.get(playerId);
    if (existingRoomCode) {
      if (existingRoomCode === roomCode) {
        // Player is already in this room - might be reconnecting
        const existingRoom = this.rooms.get(roomCode);
        if (existingRoom) {
          return existingRoom;
        }
        // Room not in memory, try to load from Redis
        const roomData = await this.redis.getRoom(roomCode);
        if (roomData) {
          const room = Room.fromGameRoom(roomData);
          this.rooms.set(roomCode, room);
          // Restore player-to-room mappings
          room.getAllPlayers().forEach((player) => {
            this.playerToRoom.set(player.id, roomCode);
          });
          return room;
        }
        // If room doesn't exist, allow rejoin
        this.playerToRoom.delete(playerId);
      } else {
        throw new Error("Вы уже находитесь в другой комнате");
      }
    }

    // Validate room code format (6 uppercase alphanumeric characters)
    if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
      throw new Error("Неверный формат кода комнаты");
    }

    let room = this.rooms.get(roomCode);
    
    // Try to load from Redis if not in memory
    if (!room) {
      const roomData = await this.redis.getRoom(roomCode);
      if (roomData) {
        // Reconstruct room from Redis data
        room = Room.fromGameRoom(roomData);
        this.rooms.set(roomCode, room);
        // Restore player-to-room mappings
        room.getAllPlayers().forEach((player) => {
          this.playerToRoom.set(player.id, roomCode);
        });
      }
    }

    if (!room) {
      throw new Error("Комната не найдена");
    }

    // Check if player already exists in room (reconnection case)
    const existingPlayer = room.getPlayer(playerId);
    if (existingPlayer) {
      // Player is reconnecting, restore mapping and return the room
      this.playerToRoom.set(playerId, roomCode);
      await this.redis.setPlayerRoom(playerId, roomCode);
      return room;
    }

    // Check if room is in lobby phase (only for new players)
    if (room.getPhase() !== "lobby") {
      throw new Error("Игра уже началась, нельзя присоединиться");
    }

    // Check if room is full
    const maxPlayers = room.toGameRoom().maxPlayers || 16;
    if (room.getAllPlayers().length >= maxPlayers) {
      throw new Error(`Комната переполнена (максимум ${maxPlayers} игроков)`);
    }

    // Check if player with same name already exists
    const playerWithSameName = room.getAllPlayers().find(p => p.name === playerName);
    if (playerWithSameName) {
      throw new Error("Игрок с таким именем уже находится в комнате");
    }

    room.addPlayer(playerId, playerName);
    this.playerToRoom.set(playerId, roomCode);
    // Update TTL to 5 minutes when player joins (refresh the timer)
    await this.redis.saveRoom(room, 300);
    await this.redis.setPlayerRoom(playerId, roomCode);
    return room;
  }

  async leaveRoom(playerId: string): Promise<Room | null> {
    const room = this.getRoomByPlayerId(playerId);
    if (!room) return null;

    room.removePlayer(playerId);
    this.playerToRoom.delete(playerId);
    await this.redis.removePlayerRoom(playerId);

    // Remove room if empty
    if (room.getAllPlayers().length === 0) {
      this.rooms.delete(room.getCode());
      await this.redis.deleteRoom(room.getCode());
    } else {
      // Save room state to Redis
      await this.redis.saveRoom(room, room.getPhase() !== "lobby" ? 86400 : 300);
    }

    return room;
  }
  
  async saveRoomState(room: Room): Promise<void> {
    // Save room state to Redis with appropriate TTL
    const ttl = room.getPhase() !== "lobby" ? 86400 : 300; // 24 hours for active game, 5 minutes for lobby
    await this.redis.saveRoom(room, ttl);
  }

  removeRoom(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (room) {
      room.getAllPlayers().forEach((player) => {
        this.playerToRoom.delete(player.id);
      });
      this.rooms.delete(roomCode);
    }
  }

  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  getRoomCount(): number {
    return this.rooms.size;
  }
}
