import { v4 as uuidv4 } from "uuid";
import { Room } from "../models/Room.js";
import { Server } from "socket.io";
import { ClientToServerEvents, ServerToClientEvents } from "../types/socket.js";
import { RedisService } from "./RedisService.js";

export class GameTimer {
  private timers: Map<string, NodeJS.Timeout>; // roomCode -> timer
  private io: Server<ClientToServerEvents, ServerToClientEvents>;
  private redisService: RedisService | null;

  constructor(io: Server<ClientToServerEvents, ServerToClientEvents>, redisService?: RedisService) {
    this.timers = new Map();
    this.io = io;
    this.redisService = redisService || null;
  }

  private async saveRoomState(room: Room): Promise<void> {
    if (this.redisService) {
      const ttl = room.getPhase() !== "lobby" ? 86400 : 300; // 24 hours for active game, 5 minutes for lobby
      await this.redisService.saveRoom(room, ttl);
    }
  }

  startTimer(room: Room): void {
    this.stopTimer(room.getCode());

    const timer = setInterval(() => {
      const endTime = room.getEndTime();
      if (!endTime || Date.now() >= endTime) {
        this.handlePhaseEnd(room);
      }
    }, 1000);

    this.timers.set(room.getCode(), timer);
  }

  stopTimer(roomCode: string): void {
    const timer = this.timers.get(roomCode);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(roomCode);
    }
  }

  private handlePhaseEnd(room: Room): void {
    this.stopTimer(room.getCode());

    switch (room.getPhase()) {
      case "night":
        this.handleNightEnd(room).catch((err) => {
          console.error("Error handling night end:", err);
        });
        break;
      case "discussion":
        this.handleDiscussionEnd(room).catch((err) => {
          console.error("Error handling discussion end:", err);
        });
        break;
      case "voting":
        this.handleVotingEnd(room).catch((err) => {
          console.error("Error handling voting end:", err);
        });
        break;
    }
  }

  private async handleNightEnd(room: Room): Promise<void> {
    const result = room.processNightPhase();
    this.io.to(room.getCode()).emit("action:night-result", result);

    // Check for game end
    const winner = room.checkGameEnd();
    if (winner) {
      // Store last night result before ending game
      room.setLastNightResult({
        killedId: result.killedId,
        savedId: result.savedId,
      });
      // Emit last night result before game end
      this.io.to(room.getCode()).emit("game:last-night-result", {
        killedId: result.killedId,
        savedId: result.savedId,
      });
      // Wait a bit before ending game to show night result modal
      setTimeout(async () => {
        await this.endGame(room, winner);
      }, 5000);
      return;
    }

    // Send system message about morning
    const morningMessage = {
      id: uuidv4(),
      senderId: "system",
      senderName: "Система",
      text: "Наступило утро. Город просыпается...",
      timestamp: Date.now(),
      isSystem: true,
    };
    room.addChatMessage("system", "Система", morningMessage.text, true);
    this.io.to(room.getCode()).emit("chat:message", morningMessage);

    // Start discussion
    room.startDiscussion();
    const discussionState = room.getDiscussionState();
    if (discussionState) {
      this.io.to(room.getCode()).emit("discussion:started", discussionState);
    }

    // Send updated players with connection status
    const playersWithStatus = room.getAllPlayersWithConnectionStatus();
    this.io.to(room.getCode()).emit("game:players-updated", {
      players: playersWithStatus,
    });

    this.io.to(room.getCode()).emit("game:phase-changed", {
      phase: room.getPhase(),
      round: room.getRound(),
      endTime: room.getEndTime()!,
    });

    // Save room state to Redis
    await this.saveRoomState(room);

    this.startTimer(room);
  }

  private async handleDiscussionEnd(room: Room): Promise<void> {
    const discussionState = room.getDiscussionState();
    if (!discussionState) return;

    if (discussionState.isIndividualPhase) {
      const hasNext = room.nextSpeaker();
      if (hasNext) {
        const newState = room.getDiscussionState();
        if (newState) {
          // Check if we moved to general discussion
          if (!newState.isIndividualPhase) {
            // Emit discussion:individual-ended to update state
            this.io.to(room.getCode()).emit("discussion:individual-ended");
            // Emit phase change with updated endTime for general discussion
            this.io.to(room.getCode()).emit("game:phase-changed", {
              phase: room.getPhase(),
              round: room.getRound(),
              endTime: room.getEndTime()!,
            });
            // Save room state to Redis
            await this.saveRoomState(room);
          } else {
            // Still individual phase, emit speaker changed
            this.io.to(room.getCode()).emit("discussion:speaker-changed", {
              currentSpeakerId: newState.currentSpeakerId!,
              currentSpeakerIndex: newState.currentSpeakerIndex,
              endTime: room.getEndTime()!,
            });
            // Save room state to Redis
            await this.saveRoomState(room);
          }
          this.startTimer(room);
        } else {
          this.io.to(room.getCode()).emit("discussion:individual-ended");
          room.endDiscussion();
          await this.handleVotingEnd(room);
        }
      } else {
        this.io.to(room.getCode()).emit("discussion:individual-ended");
        room.endDiscussion();
        await this.handleVotingEnd(room);
      }
    } else {
      // General discussion ended, move to voting
      this.io.to(room.getCode()).emit("discussion:ended");
      room.endDiscussion();
      // Emit discussion:started for voting phase
      const discussionState = room.getDiscussionState();
      if (discussionState && discussionState.currentSpeakerId) {
        // Emit discussion:started with first voter
        this.io.to(room.getCode()).emit("discussion:started", discussionState);
        // Emit speaker changed for first voter
        this.io.to(room.getCode()).emit("discussion:speaker-changed", {
          currentSpeakerId: discussionState.currentSpeakerId,
          currentSpeakerIndex: discussionState.currentSpeakerIndex,
          endTime: room.getEndTime()!,
        });
        // Send updated players with connection status
        const playersWithStatus = room.getAllPlayersWithConnectionStatus();
        this.io.to(room.getCode()).emit("game:players-updated", {
          players: playersWithStatus,
        });
      }
      // Emit phase change
      this.io.to(room.getCode()).emit("game:phase-changed", {
        phase: room.getPhase(),
        round: room.getRound(),
        endTime: room.getEndTime()!,
      });
      // Save room state to Redis
      await this.saveRoomState(room);
      // Start timer for first voter (don't call handleVotingEnd yet)
      this.startTimer(room);
    }
  }

  private async handleVotingEnd(room: Room): Promise<void> {
    const discussionState = room.getDiscussionState();
    if (!discussionState) return;

    if (discussionState.isIndividualPhase) {
      // Auto-vote for current voter if they didn't vote
      const currentVoterId = discussionState.currentSpeakerId;
      if (currentVoterId && !room.hasPlayerVoted(currentVoterId)) {
        // Player didn't vote, auto-vote against themselves
        room.vote(currentVoterId, currentVoterId);
        
        // Notify all players about auto-vote
        const voter = room.getPlayer(currentVoterId);
        if (voter) {
          const alivePlayers = room.getAlivePlayers();
          const voterIndex = alivePlayers.findIndex((p) => p.id === currentVoterId) + 1;
          const message = `${voter.name} (${voterIndex}) проголосовал против ${voter.name} (${voterIndex})`;
          room.addChatMessage(
            "system",
            "Система",
            message,
            true
          );
          this.io.to(room.getCode()).emit("chat:message", {
            id: uuidv4(),
            senderId: "system",
            senderName: "Система",
            text: message,
            timestamp: Date.now(),
            isSystem: true,
          });
          
          // Emit vote received event
          this.io.to(room.getCode()).emit("action:vote-received", {
            voterId: currentVoterId,
            targetId: currentVoterId,
          });
        }
        // Save room state to Redis after vote
        await this.saveRoomState(room);
      }
      
      const hasNext = room.nextVoter();
      if (hasNext) {
        const newState = room.getDiscussionState();
        if (newState) {
          this.io.to(room.getCode()).emit("discussion:speaker-changed", {
            currentSpeakerId: newState.currentSpeakerId!,
            currentSpeakerIndex: newState.currentSpeakerIndex,
            endTime: room.getEndTime()!,
          });
          // Save room state to Redis
          await this.saveRoomState(room);
          this.startTimer(room);
        } else {
          await this.processVoting(room);
        }
      } else {
        await this.processVoting(room);
      }
    } else {
      await this.processVoting(room);
    }
  }

  private async processVoting(room: Room): Promise<void> {
    const result = room.processVoting();
    this.io.to(room.getCode()).emit("action:vote-result", {
      eliminatedId: result.eliminatedId,
      votes: result.votes,
      isTie: result.isTie,
    });

    if (result.eliminatedId) {
      const eliminatedPlayer = room.getPlayer(result.eliminatedId);
      this.io.to(room.getCode()).emit("game:player-eliminated", {
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
      this.io.to(room.getCode()).emit("game:last-voting-result", {
        eliminatedId: result.eliminatedId,
        isTie: result.isTie,
        votes: result.votes,
      });
      // Wait a bit before ending game to show voting result modal
      setTimeout(async () => {
        await this.endGame(room, winner);
      }, 5000);
      return;
    }

    // Send system message about night starting
    const nightMessage = {
      id: uuidv4(),
      senderId: "system",
      senderName: "Система",
      text: "Наступила ночь. Мафия просыпается...",
      timestamp: Date.now(),
      isSystem: true,
    };
    room.addChatMessage("system", "Система", nightMessage.text, true);
    this.io.to(room.getCode()).emit("chat:message", nightMessage);
    
    // Move to next night
    room.startNextNight();
    // Send updated players with connection status
    const playersWithStatus = room.getAllPlayersWithConnectionStatus();
    this.io.to(room.getCode()).emit("game:players-updated", {
      players: playersWithStatus,
    });
    this.io.to(room.getCode()).emit("game:phase-changed", {
      phase: room.getPhase(),
      round: room.getRound(),
      endTime: room.getEndTime()!,
    });
    // Save room state to Redis
    await this.saveRoomState(room);
    this.startTimer(room);
  }

  private async endGame(room: Room, winner: "mafia" | "town"): Promise<void> {
    this.stopTimer(room.getCode());
    // Mark room as ended
    room.setIsEnded(true);
    this.io.to(room.getCode()).emit("game:ended", {
      winner,
      players: room.getAllPlayers(),
    });
    // Save final game state to Redis
    await this.saveRoomState(room);
  }

  cleanup(roomCode: string): void {
    this.stopTimer(roomCode);
  }
}
