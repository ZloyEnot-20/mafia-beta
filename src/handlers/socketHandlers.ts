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
import { t, type Language } from "../i18n/index.js";

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

const socketLang = new Map<string, Language>();

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
    socket.on("room:create", async (playerName: string, playerId?: string, lang?: Language) => {
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

        const playerLang = lang === "ru" ? "ru" : "uz";
        socketLang.set(socket.id, playerLang);

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
        const playerLang = socketLang.get(socket.id) ?? "uz";
        socket.emit("error", error instanceof Error ? error.message : t(playerLang, "errorCreateRoom"));
      }
    });

    // Room: Join
    socket.on("room:join", async ({ roomCode, playerName, playerId: providedPlayerId, lang: clientLang }) => {
      try {
        const playerLang = clientLang === "ru" ? "ru" : "uz";
        socketLang.set(socket.id, playerLang);

        // Validate input
        if (!roomCode || !playerName) {
          socket.emit("error", t(playerLang, "roomCodeAndNameRequired"));
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
          socket.emit("error", t(playerLang, "roomNotFound"));
          return;
        }

        // Set socket connection using the correct playerId
        // Check if player was connected before (for reconnection detection) - MUST check BEFORE setting connection
        const wasConnected = roomResult.isPlayerConnected(playerId);
        roomResult.setSocketConnection(playerId, socket.id);
        socket.join(normalizedCode);
        const roomSettings = roomResult.getSettings();
        
        // Ensure player-room mapping is saved to Redis (for reconnection)
        await redisService.setPlayerRoom(playerId, normalizedCode);
        
        console.log(`Successfully joined room ${normalizedCode}, playerId: ${playerId}, phase: ${roomResult.getPhase()}, wasConnected: ${wasConnected}, isReconnecting: ${isReconnecting}`);
        
        // If game has started and player was disconnected (not left), notify reconnection
        // Only send reconnection message if:
        // 1. Game has started (not lobby)
        // 2. Player exists in room (isReconnecting = true)
        // 3. Player was NOT connected before (wasConnected = false) - means they were disconnected, not left
        if (roomResult.getPhase() !== "lobby" && isReconnecting && !wasConnected) {
          const player = roomResult.getPlayer(playerId);
          if (player) {
            // Send system message about reconnection only if player was disconnected
            const reconnectMessage: ChatMessage = {
              id: uuidv4(),
              senderId: "system",
              senderName: t(playerLang, "system"),
              text: t(playerLang, "playerReconnected", player.name),
              timestamp: Date.now(),
              isSystem: true,
              translationKey: "playerReconnected",
              translationParams: [player.name],
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
          
          // Send game:started if game has started (to restore game state)
          if (roomResult.getPhase() !== "lobby" && roomResult.getPhase() !== "ended") {
            socket.emit("game:started", {
              players: playersWithStatus,
            });
          }
          
          // Send discussion state FIRST (before phase change) to ensure it's set before phase change
          // For voting phase, discussionState is actually voting state
          if (discussionState) {
            // Always send discussion:started to restore the state
            socket.emit("discussion:started", discussionState);
            if (discussionState.currentSpeakerId) {
              socket.emit("discussion:speaker-changed", {
                currentSpeakerId: discussionState.currentSpeakerId,
                currentSpeakerIndex: discussionState.currentSpeakerIndex,
                endTime: roomResult.getEndTime()!,
              });
            }
          }
          
          // Send votes BEFORE phase change to prevent them from being cleared
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
          
          // Send night actions BEFORE phase change
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
            
            // Check if current player has performed night action
            const hasPerformedAction = roomResult.getNightActions().has(playerId);
            
            socket.emit("action:night-action-received" as any, {
              actorId: hasPerformedAction ? playerId : "",
              targetId: "",
              voteCounts,
            });
          }
          
          // Send game state events AFTER votes and discussion state
          socket.emit("game:phase-changed", {
            phase: roomResult.getPhase(),
            round: roomResult.getRound(),
            endTime: roomResult.getEndTime()!,
          });
          
          // Send role if assigned
          if (player?.role) {
            socket.emit("game:role-assigned", player.role);
          }
          
          // Send night result if we're in discussion phase after night
          if (roomResult.getPhase() === "discussion" && roomResult.getRound() > 1) {
            // Get last night result from room if available
            const lastNightResult = roomResult.getLastNightResult();
            if (lastNightResult) {
              socket.emit("action:night-result", lastNightResult);
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
        const playerLang = socketLang.get(socket.id) ?? "uz";
        socket.emit("error", error instanceof Error ? error.message : t(playerLang, "errorJoinRoom"));
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
        // Remove player-room mapping from Redis to prevent auto-reconnection
        await redisService.removePlayerRoom(leavingPlayerId);
        
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
      const playerLang = socketLang.get(socket.id) ?? "uz";
      if (!playerInfo || !playerInfo.room) {
        socket.emit("error", t(playerLang, "errorRoomRequired"));
        return;
      }
      await roomManager.deleteRoom(playerInfo.room.getCode());
    });

    // Game: Start
    socket.on("game:start", async () => {
      const playerInfo = findPlayerIdBySocket(socket.id, roomManager);
      const playerLang = socketLang.get(socket.id) ?? "uz";
      if (!playerInfo || !playerInfo.room) {
        socket.emit("error", t(playerLang, "errorRoomRequired"));
        return;
      }
      
      const { playerId, room } = playerInfo;
      const player = room.getPlayer(playerId);
      if (!player?.isHost) {
        socket.emit("error", t(playerLang, "errorHostOnly"));
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
        socket.emit("error", error instanceof Error ? error.message : t(playerLang, "errorHostOnly"));
      }
    });

    // Action: Night Action
    socket.on("action:night-action", async (targetId: string) => {
      const playerInfo = findPlayerIdBySocket(socket.id, roomManager);
      const playerLang = socketLang.get(socket.id) ?? "uz";
      if (!playerInfo || !playerInfo.room) {
        socket.emit("error", t(playerLang, "errorRoomRequired"));
        return;
      }
      
      const { playerId, room } = playerInfo;
      if (room.getPhase() !== "night") {
        socket.emit("error", t(playerLang, "errorInvalidPhase"));
        return;
      }

      const player = room.getPlayer(playerId);
      if (!player?.isAlive) {
        socket.emit("error", t(playerLang, "errorDeadCannotAct"));
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
      const playerLang = socketLang.get(socket.id) ?? "uz";
      if (!playerInfo || !playerInfo.room) {
        socket.emit("error", t(playerLang, "errorRoomRequired"));
        return;
      }
      
      const { playerId, room } = playerInfo;
      if (room.getPhase() !== "voting") {
        socket.emit("error", t(playerLang, "errorInvalidPhase"));
        return;
      }

      const player = room.getPlayer(playerId);
      if (!player?.isAlive) {
        socket.emit("error", t(playerLang, "errorDeadCannotVote"));
        return;
      }

      // Check if it's individual voting phase and if it's current player's turn
      const discussionState = room.getDiscussionState();
      if (discussionState?.isIndividualPhase) {
        if (discussionState.currentSpeakerId !== playerId) {
          socket.emit("error", t(playerLang, "errorNotYourTurn"));
          return;
        }
      }

      try {
        room.vote(playerId, targetId);
      } catch (error) {
        socket.emit("error", error instanceof Error ? error.message : t(playerLang, "errorVoting"));
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
          const messageText = t(playerLang, "votedAgainstFull", player.name, voterIndex, targetPlayer.name, targetIndex);
          room.addChatMessage(
            "system",
            "Система",
            messageText,
            true
          );
          io.to(room.getCode()).emit("chat:message", {
            id: uuidv4(),
            senderId: "system",
            senderName: t(playerLang, "system"),
            text: messageText,
            timestamp: Date.now(),
            isSystem: true,
            translationKey: "votedAgainstFull",
            translationParams: [player.name, voterIndex, targetPlayer.name, targetIndex],
          });
        }

      // If it's individual voting phase, move to next voter immediately after vote
      // Reuse discussionState from above (line 559)
      if (discussionState?.isIndividualPhase && discussionState.currentSpeakerId === playerId) {
        const hasNext = room.nextVoter();
        if (hasNext) {
          const newState = room.getDiscussionState();
          if (newState && newState.currentSpeakerId) {
            // Move to next voter
            io.to(room.getCode()).emit("discussion:speaker-changed", {
              currentSpeakerId: newState.currentSpeakerId,
              currentSpeakerIndex: newState.currentSpeakerIndex,
              endTime: room.getEndTime()!,
            });
            // Restart timer for next voter
            gameTimer.startTimer(room);
          } else {
            // Edge case: hasNext but no valid next state — stop timer and process
            gameTimer.stopTimer(room.getCode());
            // No more voters, process voting
            const result = room.processVoting();
            io.to(room.getCode()).emit("action:vote-result", {
              eliminatedId: result.eliminatedId,
              votes: result.votes,
              isTie: result.isTie,
            });

            if (result.eliminatedId) {
              const eliminatedPlayer = room.getPlayer(result.eliminatedId);
              io.to(room.getCode()).emit("game:player-eliminated", {
                playerId: result.eliminatedId,
                role: eliminatedPlayer?.role,
              });
            }

            // Check for game end
            const winner = room.checkGameEnd();
            if (winner) {
              // Store last voting result before ending game
              room.setLastVotingResult({
                eliminatedId: result.eliminatedId,
                isTie: result.isTie,
                votes: result.votes,
              });
              // Emit last voting result before game end
              io.to(room.getCode()).emit("game:last-voting-result", {
                eliminatedId: result.eliminatedId,
                isTie: result.isTie,
                votes: result.votes,
              });
              // Wait a bit before ending game to show voting result modal
              setTimeout(async () => {
                await gameTimer.endGame(room, winner);
              }, 5000);
              return;
            }

            // Send system message about night starting
            const hostPlayer = room.getPlayer(room.getHostId());
            const hostLang = hostPlayer ? (socketLang.get(room.getSocketId(hostPlayer.id) ?? "") ?? "uz") : "uz";
            const nightText = t(hostLang, "nightFalls");
            const nightMessage: ChatMessage = {
              id: uuidv4(),
              senderId: "system",
              senderName: t(hostLang, "system"),
              text: nightText,
              timestamp: Date.now(),
              isSystem: true,
              translationKey: "nightFalls",
              translationParams: [],
            };
            room.addChatMessage("system", "Система", nightText, true);
            io.to(room.getCode()).emit("chat:message", nightMessage);

          // Move to night phase
          room.startNextNight();
          // Send updated players with connection status
          const playersWithStatus = room.getAllPlayersWithConnectionStatus();
          io.to(room.getCode()).emit("game:players-updated", {
            players: playersWithStatus,
          });
          const nightDiscussionState = room.getDiscussionState();
          if (nightDiscussionState) {
            io.to(room.getCode()).emit("discussion:started", nightDiscussionState);
          }
          io.to(room.getCode()).emit("game:phase-changed", {
            phase: room.getPhase(),
            round: room.getRound(),
            endTime: room.getEndTime()!,
          });
          await redisService.saveRoom(room, 86400);
          gameTimer.startTimer(room);
          }
        } else {
          // Last player voted — stop timer immediately so we don't wait for remaining time
          gameTimer.stopTimer(room.getCode());
          // No more voters, process voting
          const result = room.processVoting();
          io.to(room.getCode()).emit("action:vote-result", {
            eliminatedId: result.eliminatedId,
            votes: result.votes,
            isTie: result.isTie,
          });

          if (result.eliminatedId) {
            const eliminatedPlayer = room.getPlayer(result.eliminatedId);
            io.to(room.getCode()).emit("game:player-eliminated", {
              playerId: result.eliminatedId,
              role: eliminatedPlayer?.role,
            });
          }

          // Check for game end
          const winner = room.checkGameEnd();
          if (winner) {
            // Store last voting result before ending game
            room.setLastVotingResult({
              eliminatedId: result.eliminatedId,
              isTie: result.isTie,
              votes: result.votes,
            });
            // Emit last voting result before game end
            io.to(room.getCode()).emit("game:last-voting-result", {
              eliminatedId: result.eliminatedId,
              isTie: result.isTie,
              votes: result.votes,
            });
            // Wait a bit before ending game to show voting result modal
            setTimeout(async () => {
              await gameTimer.endGame(room, winner);
            }, 5000);
            return;
          }

          // Send system message about night starting
          const hostPlayer = room.getPlayer(room.getHostId());
          const hostLang = hostPlayer ? (socketLang.get(room.getSocketId(hostPlayer.id) ?? "") ?? "uz") : "uz";
          const nightText = t(hostLang, "nightMafiaWakes");
          const nightMessage: ChatMessage = {
            id: uuidv4(),
            senderId: "system",
            senderName: t(hostLang, "system"),
            text: nightText,
            timestamp: Date.now(),
            isSystem: true,
            translationKey: "nightMafiaWakes",
            translationParams: [],
          };
          room.addChatMessage("system", "Система", nightText, true);
          io.to(room.getCode()).emit("chat:message", nightMessage);

          // Move to night phase
          room.startNextNight();
          // Send updated players with connection status
          const playersWithStatus = room.getAllPlayersWithConnectionStatus();
          io.to(room.getCode()).emit("game:players-updated", {
            players: playersWithStatus,
          });
          const nightDiscussionState = room.getDiscussionState();
          if (nightDiscussionState) {
            io.to(room.getCode()).emit("discussion:started", nightDiscussionState);
          }
          io.to(room.getCode()).emit("game:phase-changed", {
            phase: room.getPhase(),
            round: room.getRound(),
            endTime: room.getEndTime()!,
          });
          await redisService.saveRoom(room, 86400);
          gameTimer.startTimer(room);
        }
      }

      // Save room state to Redis after vote
      await redisService.saveRoom(room, 86400);
    });

    // Chat: Send
    socket.on("chat:send", async (text: string) => {
      const playerInfo = findPlayerIdBySocket(socket.id, roomManager);
      const playerLang = socketLang.get(socket.id) ?? "uz";
      if (!playerInfo || !playerInfo.room) {
        socket.emit("error", t(playerLang, "errorRoomRequired"));
        return;
      }
      
      const { playerId, room } = playerInfo;
      const player = room.getPlayer(playerId);
      if (!player) return;
      
      // Dead players cannot send messages (except after game ended)
      if (!player.isAlive && room.getPhase() !== "ended") {
        socket.emit("error", t(playerLang, "errorDeadCannotChat"));
        return;
      }

      // Limit message length to prevent crashes (max 500 characters)
      const maxLength = 500;
      const messageText = text.length > maxLength ? text.substring(0, maxLength) : text;

      // During night phase, only mafia can send messages, and they should only be visible to mafia
      if (room.getPhase() === "night" && player.role === "mafia") {
        // Send message only to mafia players, don't save to room chat
        const message: ChatMessage = {
          id: uuidv4(),
          senderId: playerId,
          senderName: player.name,
          text: messageText,
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
          text: messageText,
          timestamp: Date.now(),
          isSystem: false,
        };
        room.addChatMessage(playerId, player.name, messageText);
        io.to(room.getCode()).emit("chat:message", message);
        // Save room state to Redis after chat message (only for active games)
        if (room.getPhase() !== "lobby") {
          await redisService.saveRoom(room, 86400);
        }
      }
    });

    // Disconnect
    socket.on("disconnect", async () => {
      socketLang.delete(socket.id);
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
            const hostPlayer = roomBeforeLeave.getPlayer(roomBeforeLeave.getHostId());
            const hostSocketId = hostPlayer ? roomBeforeLeave.getSocketId(hostPlayer.id) : undefined;
            const msgLang = hostSocketId ? (socketLang.get(hostSocketId) ?? "uz") : "uz";
            const disconnectText = t(msgLang, "playerDisconnected", disconnectedPlayer.name);
            const disconnectMessage: ChatMessage = {
              id: uuidv4(),
              senderId: "system",
              senderName: t(msgLang, "system"),
              text: disconnectText,
              timestamp: Date.now(),
              isSystem: true,
              translationKey: "playerDisconnected",
              translationParams: [disconnectedPlayer.name],
            };
            roomBeforeLeave.addChatMessage("system", "Система", disconnectText, true);
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
        socketLang.delete(socket.id);
        const leavingPlayer = roomBeforeLeave?.getPlayer(playerId) || { id: playerId, name: "Player" };
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
