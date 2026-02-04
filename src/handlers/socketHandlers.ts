import { Server, Socket } from "socket.io";
import {
  ServerToClientEvents,
  ClientToServerEvents,
  ChatMessage,
} from "../types/socket.js";
import { RoomManager } from "../services/RoomManager.js";
import { GameTimer } from "../services/GameTimer.js";
import { RedisService } from "../services/RedisService.js";
import { GameSettings } from "../types/game.js";
import { v4 as uuidv4 } from "uuid";

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Helper function to find playerId by socket.id
 */
function findPlayerIdBySocket(
  socketId: string,
  roomManager: RoomManager
): { playerId: string; room: ReturnType<typeof roomManager.getRoomByPlayerId> } | null {
  // Try to find room by checking all rooms for this socket
  for (const [, room] of Array.from(roomManager["rooms"].entries())) {
    // Check if this socket is connected to any player in this room
    for (const player of room.getAllPlayers()) {
      const playerSocketId = room.getSocketId(player.id);
      if (playerSocketId === socketId) {
        return { playerId: player.id, room };
      }
    }
  }
  
  // Fallback: try to find by socket.id directly (for backwards compatibility)
  const room = roomManager.getRoomByPlayerId(socketId);
  if (room) {
    return { playerId: socketId, room };
  }
  
  return null;
}

export function setupSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  roomManager: RoomManager,
  gameTimer: GameTimer,
  redisService: RedisService
): void {
  io.on("connection", (socket: TypedSocket) => {
    console.log(`Client connected: ${socket.id}`);

    // Update user count
    updateUserCount(io);

    // Room: Check Active - Check if player has an active room
    socket.on("room:check-active", async (playerId: string) => {

      try {
        console.log(`Checking active room for player: ${playerId}`);
        const activeRoom = await roomManager.getActiveRoomForPlayer(playerId);
        
        if (activeRoom) {
          const { roomCode, room } = activeRoom;
          const player = room.getPlayer(playerId);
          
          if (player) {
            console.log(`Active room found for player ${playerId}: ${roomCode}`);
            socket.emit("room:active-found", {
              roomCode,
              playerName: player.name,
            });
          } else {
            console.log(`Player ${playerId} not found in room ${roomCode}`);
            socket.emit("room:no-active");
          }
        } else {
          console.log(`No active room found for player: ${playerId}`);
          socket.emit("room:no-active");
        }
      } catch (error) {
        console.error("Error checking active room:", error);
        socket.emit("room:no-active");
      }
    });

    // Room: Check On Entry - Check if player has an active room when entering the app
    socket.on("room:check-on-entry", async (playerId: string) => {
      try {
        console.log(`Checking active room on entry for player: ${playerId}`);
        const activeRoom = await roomManager.getActiveRoomForPlayer(playerId);
        
        if (activeRoom) {
          const { roomCode, room } = activeRoom;
          const player = room.getPlayer(playerId);
          
          if (player) {
            console.log(`Active room found on entry for player ${playerId}: ${roomCode}`);
            socket.emit("room:check-result", {
              hasActiveRoom: true,
              roomCode,
              playerName: player.name,
            });
          } else {
            console.log(`Player ${playerId} not found in room ${roomCode}`);
            socket.emit("room:check-result", {
              hasActiveRoom: false,
            });
          }
        } else {
          console.log(`No active room found on entry for player: ${playerId}`);
          socket.emit("room:check-result", {
            hasActiveRoom: false,
          });
        }
      } catch (error) {
        console.error("Error checking active room on entry:", error);
        socket.emit("room:check-result", {
          hasActiveRoom: false,
        });
      }
    });

    // Room: Create
    socket.on("room:create", async (playerName: string, playerId?: string) => {
      try {
        // Use persistent playerId if provided, otherwise fallback to socket.id
        const persistentPlayerId = playerId || socket.id;
        
        const defaultSettings: GameSettings = {
          nightDuration: parseInt(process.env.NIGHT_DURATION || "30"),
          discussionDuration: parseInt(process.env.DISCUSSION_DURATION || "60"),
          dayDuration: parseInt(process.env.DAY_DURATION || "60"),
          votingDuration: parseInt(process.env.VOTING_DURATION || "30"),
          individualDiscussionDuration: parseInt(
            process.env.INDIVIDUAL_DISCUSSION_DURATION || "15"
          ),
          individualVotingDuration: parseInt(
            process.env.INDIVIDUAL_VOTING_DURATION || "15"
          ),
          mafiaCount: 2,
          hasDoctor: true,
          hasSheriff: true,
          minPlayers: parseInt(process.env.MIN_PLAYERS || "4"),
          maxPlayers: parseInt(process.env.MAX_PLAYERS || "16"),
        };

        const room = await roomManager.createRoom(persistentPlayerId, playerName, defaultSettings);
        room.setSocketConnection(persistentPlayerId, socket.id);
        socket.join(room.getCode());
        socket.emit("room:joined", {
          roomCode: room.getCode(),
          players: room.getAllPlayers(),
          settings: defaultSettings,
          createdAt: room.getCreatedAt(),
        });
      } catch (error) {
        socket.emit("error", error instanceof Error ? error.message : "Ошибка создания комнаты");
      }
    });

    // Room: Join
    socket.on("room:join", async ({ roomCode, playerName, playerId: providedPlayerId }) => {
      try {
        // Validate input
        if (!roomCode || !playerName) {
          socket.emit("error", "Код комнаты и имя игрока обязательны");
          return;
        }

        // Normalize room code (uppercase, remove spaces)
        const normalizedCode = roomCode.toUpperCase().trim();

        // Use provided persistent playerId, or try to find existing player by name, or fallback to socket.id
        let playerId = providedPlayerId;
        let isReconnecting = false;
        
        if (!playerId) {
          // Try to find existing player by name in the room (for reconnection without persistent ID)
          const existingPlayerId = await roomManager.findPlayerByName(normalizedCode, playerName);
          if (existingPlayerId) {
            playerId = existingPlayerId;
            isReconnecting = true;
          } else {
            playerId = socket.id;
          }
        } else {
          // Check if player with this persistent ID already exists in the room (reconnection case)
          console.log(`Checking if player ${playerId} exists in room ${normalizedCode}`);
          const playerExists = await roomManager.findPlayerById(normalizedCode, playerId);
          if (playerExists) {
            console.log(`Player ${playerId} found in room, this is a reconnection`);
            isReconnecting = true;
          } else {
            console.log(`Player ${playerId} not found in room, this is a new join`);
          }
        }

        console.log(`Attempting to join room ${normalizedCode} with playerId: ${playerId}, playerName: ${playerName}, isReconnecting: ${isReconnecting}`);
        
        const roomResult = await roomManager.joinRoom(normalizedCode, playerId, playerName);
        if (!roomResult) {
          socket.emit("error", "Комната не найдена");
          return;
        }

        // Set socket connection using the correct playerId
        roomResult.setSocketConnection(playerId, socket.id);
        socket.join(normalizedCode);
        const roomSettings = roomResult.getSettings();
        
        // Ensure player-room mapping is saved to Redis (for reconnection)
        await redisService.setPlayerRoom(playerId, normalizedCode);
        
        console.log(`Successfully joined room ${normalizedCode}, playerId: ${playerId}, phase: ${roomResult.getPhase()}`);
        
        // If game has started and player was disconnected, notify reconnection
        if (roomResult.getPhase() !== "lobby" || isReconnecting) {
          const player = roomResult.getPlayer(playerId);
          if (player) {
            // Send system message about reconnection
            const reconnectMessage = {
              id: uuidv4(),
              senderId: "system",
              senderName: "Система",
              text: `${player.name} переподключился к игре`,
              timestamp: Date.now(),
              isSystem: true,
            };
            roomResult.addChatMessage("system", "Система", reconnectMessage.text, true);
            io.to(roomResult.getCode()).emit("chat:message", reconnectMessage);
          }
          
          io.to(roomResult.getCode()).emit("room:player-reconnected", {
            playerId: playerId,
          });
          
          // Send complete game state for reconnection
          const playersWithStatus = roomResult.getAllPlayersWithConnectionStatus();
          const discussionState = roomResult.getDiscussionState();
          const chatMessages = roomResult.getChatMessages();
          
          // Send room:joined with all data
          socket.emit("room:joined", {
            roomCode: roomResult.getCode(),
            players: playersWithStatus,
            settings: roomSettings,
            createdAt: roomResult.getCreatedAt(),
          });
          
          // Send game state events
          socket.emit("game:phase-changed", {
            phase: roomResult.getPhase(),
            round: roomResult.getRound(),
            endTime: roomResult.getEndTime()!,
          });
          
          // Send role if assigned
          if (player?.role) {
            socket.emit("game:role-assigned", player.role);
          }
          
          // Send discussion state if exists
          if (discussionState) {
            socket.emit("discussion:started", discussionState);
            if (discussionState.currentSpeakerId) {
              socket.emit("discussion:speaker-changed", {
                currentSpeakerId: discussionState.currentSpeakerId,
                currentSpeakerIndex: discussionState.currentSpeakerIndex,
                endTime: roomResult.getEndTime()!,
              });
            }
          }
          
          // Send all chat messages
          chatMessages.forEach((msg) => {
            socket.emit("chat:message", {
              id: msg.id,
              senderId: msg.senderId,
              senderName: msg.senderName,
              text: msg.text,
              timestamp: msg.timestamp,
              isSystem: msg.isSystem || false,
            });
          });
          
          // Send votes if in voting phase
          if (roomResult.getPhase() === "voting") {
            const roomData = roomResult.toGameRoom();
            // Send vote events for each vote
            if (roomData.votes) {
              Object.entries(roomData.votes).forEach(([voterId, targetId]) => {
                socket.emit("action:vote-received", {
                  voterId: voterId,
                  targetId: targetId,
                });
              });
            }
          }
          
          // Send night actions if in night phase and player is mafia
          if (roomResult.getPhase() === "night" && player?.role === "mafia") {
            const mafiaActions = Array.from(roomResult.getNightActions().entries())
              .filter(([playerId]) => {
                const p = roomResult.getPlayer(playerId);
                return p?.role === "mafia";
              })
              .map(([_, targetId]) => targetId);
            
            const voteCounts: Record<string, number> = {};
            mafiaActions.forEach((targetId) => {
              voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
            });
            
            socket.emit("action:night-action-received" as any, {
              actorId: playerId,
              targetId: "",
              voteCounts,
            });
          }
          
          // Also send updated players list to all players
          io.to(roomResult.getCode()).emit("game:players-updated", {
            players: playersWithStatus,
          });
          
          // Save room state after reconnection
          await redisService.saveRoom(roomResult, 86400);
        } else {
          socket.emit("room:joined", {
            roomCode: roomResult.getCode(),
            players: roomResult.getAllPlayers(),
            settings: roomSettings,
            createdAt: roomResult.getCreatedAt(),
          });
        }

        // Notify other players in the room (only if not reconnecting)
        if (!isReconnecting) {
          socket.to(normalizedCode).emit("room:player-joined", roomResult.getPlayer(playerId)!);
        }

        // Notify about host change if needed
        if (roomResult.getHostId() !== playerId) {
          socket.emit("room:host-changed", roomResult.getHostId());
        }
      } catch (error) {
        socket.emit("error", error instanceof Error ? error.message : "Ошибка входа в комнату");
      }
    });

    // Room: Leave
    socket.on("room:leave", async () => {
      // Get player info before leaving room
      const playerInfo = findPlayerIdBySocket(socket.id, roomManager);
      const roomBeforeLeave = playerInfo?.room;
      const leavingPlayerId = playerInfo?.playerId;
      const leavingPlayer = leavingPlayerId ? roomBeforeLeave?.getPlayer(leavingPlayerId) : null;
      
      if (leavingPlayerId) {
        const room = await roomManager.leaveRoom(leavingPlayerId);
        if (room) {
          socket.leave(room.getCode());
          
          // Notify other players with player name
          if (leavingPlayer) {
            socket.to(room.getCode()).emit("room:player-left", {
              playerId: leavingPlayerId,
              playerName: leavingPlayer.name,
            });
          }

          const newHost = room.getPlayer(room.getHostId());
          if (newHost) {
            io.to(room.getCode()).emit("room:host-changed", room.getHostId());
          }
        }
      }
    });

    // Room: Delete
    socket.on("room:delete", async () => {
      const playerInfo = findPlayerIdBySocket(socket.id, roomManager);
      if (!playerInfo || !playerInfo.room) {
        socket.emit("error", "Вы не в комнате");
        return;
      }
      await roomManager.deleteRoom(playerInfo.room.getCode());
    });

    // Game: Start
    socket.on("game:start", async () => {
      const playerInfo = findPlayerIdBySocket(socket.id, roomManager);
      if (!playerInfo || !playerInfo.room) {
        socket.emit("error", "Вы не в комнате");
        return;
      }
      
      const { playerId, room } = playerInfo;
      const player = room.getPlayer(playerId);
      if (!player?.isHost) {
        socket.emit("error", "Только хост может начать игру");
        return;
      }

      try {
        room.startGame();
        const players = room.getAllPlayers();

        // Send roles to each player with connection status
        const playersWithStatus = room.getAllPlayersWithConnectionStatus();
        players.forEach((p) => {
          const socketId = room.getSocketId(p.id);
          if (socketId) {
            const playerSocket = io.sockets.sockets.get(socketId);
            if (playerSocket) {
              playerSocket.emit("game:role-assigned", p.role!);
              playerSocket.emit("game:started", { players: playersWithStatus });
            }
          }
        });

        // Game starts with discussion phase, emit discussion:started
        const discussionState = room.getDiscussionState();
        if (discussionState) {
          io.to(room.getCode()).emit("discussion:started", discussionState);
        }

        // Notify phase change
        io.to(room.getCode()).emit("game:phase-changed", {
          phase: room.getPhase(),
          round: room.getRound(),
          endTime: room.getEndTime()!,
        });

        // Start game timer
        gameTimer.startTimer(room);
        
        // When game starts, save state to Redis with extended TTL
        // Set to 24 hours (86400 seconds) to keep room alive during the game
        await redisService.saveRoom(room, 86400);
      } catch (error) {
        socket.emit("error", error instanceof Error ? error.message : "Ошибка начала игры");
      }
    });

    // Action: Night Action
    socket.on("action:night-action", async (targetId: string) => {
      const playerInfo = findPlayerIdBySocket(socket.id, roomManager);
      if (!playerInfo || !playerInfo.room) {
        socket.emit("error", "Вы не в комнате");
        return;
      }
      
      const { playerId, room } = playerInfo;
      if (room.getPhase() !== "night") {
        socket.emit("error", "Неверная фаза игры");
        return;
      }

      const player = room.getPlayer(playerId);
      if (!player?.isAlive) {
        socket.emit("error", "Мертвые игроки не могут действовать");
        return;
      }

      room.setNightAction(playerId, targetId);

      // Notify all players about night action (only mafia can see mafia votes)
      if (player.role === "mafia") {
        // Get all mafia night actions to show vote count
        const mafiaActions = Array.from(room.getNightActions().entries())
          .filter(([playerId]) => {
            const p = room.getPlayer(playerId);
            return p?.role === "mafia";
          })
          .map(([_, targetId]) => targetId);
        
        const voteCounts: Record<string, number> = {};
        mafiaActions.forEach((targetId) => {
          voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
        });

        // Emit to all mafia players only
        const mafiaPlayers = room.getAllPlayers().filter((p) => p.role === "mafia");
        mafiaPlayers.forEach((mafiaPlayer) => {
          const mafiaSocketId = room.getSocketId(mafiaPlayer.id);
          if (mafiaSocketId) {
            const mafiaSocket = io.sockets.sockets.get(mafiaSocketId);
            if (mafiaSocket) {
              mafiaSocket.emit("action:night-action-received" as any, {
                actorId: playerId,
                targetId,
                voteCounts,
              });
            }
          }
        });
      }

      // Save room state to Redis after night action
      await redisService.saveRoom(room, 86400);

      // Process night if all have acted (simplified - in real game, use timers)
      // This would typically be handled by a timer
    });

    // Action: Vote
    socket.on("action:vote", async (targetId: string) => {
      const playerInfo = findPlayerIdBySocket(socket.id, roomManager);
      if (!playerInfo || !playerInfo.room) {
        socket.emit("error", "Вы не в комнате");
        return;
      }
      
      const { playerId, room } = playerInfo;
      if (room.getPhase() !== "voting") {
        socket.emit("error", "Неверная фаза игры");
        return;
      }

      const player = room.getPlayer(playerId);
      if (!player?.isAlive) {
        socket.emit("error", "Мертвые игроки не могут голосовать");
        return;
      }

      // Check if it's individual voting phase and if it's current player's turn
      const discussionState = room.getDiscussionState();
      if (discussionState?.isIndividualPhase) {
        if (discussionState.currentSpeakerId !== playerId) {
          socket.emit("error", "Не ваша очередь голосовать");
          return;
        }
      }

      try {
        room.vote(playerId, targetId);
      } catch (error) {
        socket.emit("error", error instanceof Error ? error.message : "Ошибка при голосовании");
        return;
      }

      // Notify all players
      io.to(room.getCode()).emit("action:vote-received", {
        voterId: playerId,
        targetId,
      });

      // Add chat message
      const targetPlayer = room.getPlayer(targetId);
      if (targetPlayer) {
        const alivePlayers = room.getAlivePlayers();
        const voterIndex = alivePlayers.findIndex((p) => p.id === playerId) + 1;
        const targetIndex = alivePlayers.findIndex((p) => p.id === targetId) + 1;
        // Send plain text message without HTML
        const message = `${player.name} (${voterIndex}) проголосовал против ${targetPlayer.name} (${targetIndex})`;
        room.addChatMessage(
          "system",
          "Система",
          message,
          true
        );
        io.to(room.getCode()).emit("chat:message", {
          id: uuidv4(),
          senderId: "system",
          senderName: "Система",
          text: message,
          timestamp: Date.now(),
          isSystem: true,
        });
      }

      // Save room state to Redis after vote
      await redisService.saveRoom(room, 86400);
    });

    // Chat: Send
    socket.on("chat:send", async (text: string) => {
      const playerInfo = findPlayerIdBySocket(socket.id, roomManager);
      if (!playerInfo || !playerInfo.room) {
        socket.emit("error", "Вы не в комнате");
        return;
      }
      
      const { playerId, room } = playerInfo;
      const player = room.getPlayer(playerId);
      if (!player) return;
      
      // Dead players cannot send messages
      if (!player.isAlive) {
        socket.emit("error", "Мертвые игроки не могут писать в чат");
        return;
      }

      // During night phase, only mafia can send messages, and they should only be visible to mafia
      if (room.getPhase() === "night" && player.role === "mafia") {
        // Send message only to mafia players, don't save to room chat
        const message: ChatMessage = {
          id: uuidv4(),
          senderId: playerId,
          senderName: player.name,
          text,
          timestamp: Date.now(),
          isSystem: false,
        };
        
        const mafiaPlayers = room.getAllPlayers().filter((p) => p.role === "mafia");
        mafiaPlayers.forEach((mafiaPlayer) => {
          const mafiaSocketId = room.getSocketId(mafiaPlayer.id);
          if (mafiaSocketId) {
            const mafiaSocket = io.sockets.sockets.get(mafiaSocketId);
            if (mafiaSocket) {
              mafiaSocket.emit("chat:message", message);
            }
          }
        });
        // Don't add to room's chat history - these are private mafia messages
      } else {
        // Normal chat message - add to room and send to all
        const message: ChatMessage = {
          id: uuidv4(),
          senderId: playerId,
          senderName: player.name,
          text,
          timestamp: Date.now(),
          isSystem: false,
        };
        room.addChatMessage(playerId, player.name, text);
        io.to(room.getCode()).emit("chat:message", message);
        // Save room state to Redis after chat message (only for active games)
        if (room.getPhase() !== "lobby") {
          await redisService.saveRoom(room, 86400);
        }
      }
    });

    // Disconnect
    socket.on("disconnect", async () => {
      console.log(`Client disconnected: ${socket.id}`);
      // Get player info before leaving room
      const playerInfo = findPlayerIdBySocket(socket.id, roomManager);
      const roomBeforeLeave = playerInfo?.room;
      const playerId = playerInfo?.playerId;
      
      if (roomBeforeLeave && playerId) {
        // Remove socket connection but keep player in room if game has started
        const removedPlayerId = roomBeforeLeave.removeSocketConnection(socket.id);
        if (removedPlayerId && roomBeforeLeave.getPhase() !== "lobby") {
          // Game has started, don't remove player, just notify about disconnection
          const disconnectedPlayer = roomBeforeLeave.getPlayer(removedPlayerId);
          if (disconnectedPlayer) {
            // Send system message to chat about disconnection
            const disconnectMessage = {
              id: uuidv4(),
              senderId: "system",
              senderName: "Система",
              text: `${disconnectedPlayer.name} отключился от игры`,
              timestamp: Date.now(),
              isSystem: true,
            };
            roomBeforeLeave.addChatMessage("system", "Система", disconnectMessage.text, true);
            io.to(roomBeforeLeave.getCode()).emit("chat:message", disconnectMessage);
          }
          
          io.to(roomBeforeLeave.getCode()).emit("room:player-disconnected", {
            playerId: removedPlayerId,
          });
          // Send updated players list with connection status to all players
          const playersWithStatus = roomBeforeLeave.getAllPlayersWithConnectionStatus();
          io.to(roomBeforeLeave.getCode()).emit("game:players-updated", {
            players: playersWithStatus,
          });
          
          // Save room state to Redis after disconnection
          await redisService.saveRoom(roomBeforeLeave, 86400);
          return;
        }
      }
      
      if (playerId) {
        const leavingPlayer = roomBeforeLeave?.getPlayer(playerId) || { id: playerId, name: "Игрок" };
        const room = await roomManager.leaveRoom(playerId);
        if (room) {
          socket.to(room.getCode()).emit("room:player-left", {
            playerId: playerId,
            playerName: leavingPlayer.name,
          });
          const newHost = room.getPlayer(room.getHostId());
          if (newHost) {
            io.to(room.getCode()).emit("room:host-changed", room.getHostId());
          }
        }
      }
      updateUserCount(io);
    });
  });
}

function updateUserCount(io: Server<ClientToServerEvents, ServerToClientEvents>): void {
  io.emit("users:count", io.sockets.sockets.size);
}
