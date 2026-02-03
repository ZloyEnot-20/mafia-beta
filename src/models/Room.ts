import { v4 as uuidv4 } from "uuid";
import { GameRoom, Player, GamePhase, Role, DiscussionState } from "../types/game.js";
import { GameSettings } from "../types/game.js";

export class Room {
  private id: string;
  private code: string;
  private hostId: string;
  private players: Map<string, Player>;
  private phase: GamePhase;
  private round: number;
  private endTime: number | null;
  private settings: GameSettings;
  private discussionState: DiscussionState | null;
  private nightActions: Map<string, string>; // playerId -> targetId
  private votes: Map<string, string>; // voterId -> targetId
  private chatMessages: Array<{
    id: string;
    senderId: string;
    senderName: string;
    text: string;
    timestamp: number;
    isSystem?: boolean;
  }>;
  private createdAt: number; // Unix timestamp in milliseconds
  private connectedSockets: Map<string, string>; // playerId -> socketId (to track connections)
  private isEnded: boolean; // true if game has ended

  constructor(hostId: string, hostName: string, settings: GameSettings) {
    this.id = uuidv4();
    this.code = this.generateRoomCode();
    this.hostId = hostId;
    this.players = new Map();
    this.phase = "lobby";
    this.round = 0;
    this.endTime = null;
    this.settings = settings;
    this.discussionState = null;
    this.nightActions = new Map();
    this.votes = new Map();
    this.chatMessages = [];
    this.createdAt = Date.now(); // Set creation timestamp
    this.connectedSockets = new Map();
    this.isEnded = false;

    // Add host as first player
    this.addPlayer(hostId, hostName, true);
  }

  private generateRoomCode(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  addPlayer(playerId: string, playerName: string, isHost: boolean = false): Player {
    const player: Player = {
      id: playerId,
      name: playerName,
      isAlive: true,
      isHost,
      role: undefined,
    };
    this.players.set(playerId, player);
    return player;
  }

  removePlayer(playerId: string): boolean {
    const wasHost = this.players.get(playerId)?.isHost;
    const removed = this.players.delete(playerId);

    if (removed && wasHost && this.players.size > 0) {
      // Assign new host (first player)
      const newHost = Array.from(this.players.values())[0];
      newHost.isHost = true;
      this.hostId = newHost.id;
    }

    return removed;
  }

  getPlayer(playerId: string): Player | undefined {
    return this.players.get(playerId);
  }

  getAllPlayers(): Player[] {
    return Array.from(this.players.values());
  }

  getAlivePlayers(): Player[] {
    return this.getAllPlayers().filter((p) => p.isAlive);
  }

  setSocketConnection(playerId: string, socketId: string): void {
    this.connectedSockets.set(playerId, socketId);
  }

  removeSocketConnection(socketId: string): string | null {
    // Find playerId by socketId
    for (const [playerId, sId] of this.connectedSockets.entries()) {
      if (sId === socketId) {
        this.connectedSockets.delete(playerId);
        return playerId;
      }
    }
    return null;
  }

  isPlayerConnected(playerId: string): boolean {
    return this.connectedSockets.has(playerId);
  }

  getAllPlayersWithConnectionStatus(): Array<Player & { isConnected: boolean }> {
    return this.getAllPlayers().map((player) => ({
      ...player,
      isConnected: this.isPlayerConnected(player.id),
    }));
  }

  startGame(): void {
    if (this.players.size < this.settings.minPlayers) {
      throw new Error(`Недостаточно игроков. Минимум: ${this.settings.minPlayers}`);
    }

    this.assignRoles();
    this.round = 1;
    this.nightActions.clear();
    this.votes.clear();
    // Start with discussion phase (daytime discussion)
    this.startDiscussion();
  }

  startNextNight(): void {
    // Move to next night phase without reassigning roles
    this.phase = "night";
    this.round += 1;
    this.nightActions.clear();
    this.votes.clear();
    this.updateEndTime(this.settings.nightDuration);
  }

  private assignRoles(): void {
    const players = this.getAllPlayers();
    const playerCount = players.length;
    const shuffled = [...players].sort(() => Math.random() - 0.5);

    // Calculate balanced roles based on player count
    let mafiaCount: number;
    let hasDoctor: boolean;
    let hasSheriff: boolean;

    if (playerCount <= 6) {
      // Small games (4-6 players): 1 mafia, no МСР (мирные с ролью)
      mafiaCount = 1;
      hasDoctor = false;
      hasSheriff = false;
    } else if (playerCount <= 9) {
      // Medium games (7-9 players): 2 mafia, 1 МСР (either doctor or sheriff)
      mafiaCount = 2;
      // Randomly choose one МСР role
      hasDoctor = Math.random() < 0.5;
      hasSheriff = !hasDoctor;
    } else if (playerCount <= 12) {
      // Large games (10-12 players): 3 mafia, both МСР
      mafiaCount = 3;
      hasDoctor = true;
      hasSheriff = true;
    } else {
      // Very large games (13-16 players): 4 mafia, both МСР
      mafiaCount = 4;
      hasDoctor = true;
      hasSheriff = true;
    }

    let index = 0;

    // Assign mafia
    for (let i = 0; i < mafiaCount && i < shuffled.length; i++) {
      shuffled[index++].role = "mafia";
    }

    // Assign МСР (мирные с ролью) - doctor and sheriff
    if (hasDoctor && index < shuffled.length) {
      shuffled[index++].role = "doctor";
    }
    if (hasSheriff && index < shuffled.length) {
      shuffled[index++].role = "sheriff";
    }

    // Rest are citizens
    for (let i = index; i < shuffled.length; i++) {
      shuffled[i].role = "citizen";
    }
  }

  setNightAction(playerId: string, targetId: string): void {
    this.nightActions.set(playerId, targetId);
  }

  getNightActions(): Map<string, string> {
    return this.nightActions;
  }

  getSocketId(playerId: string): string | undefined {
    return this.connectedSockets.get(playerId);
  }

  processNightPhase(): {
    killedId: string | null;
    savedId: string | null;
    checkedId?: string;
    checkedRole?: Role;
  } {
    const actions = Array.from(this.nightActions.entries());
    const mafiaAction = actions.find(([id]) => {
      const player = this.players.get(id);
      return player?.role === "mafia";
    });
    const doctorAction = actions.find(([id]) => {
      const player = this.players.get(id);
      return player?.role === "doctor";
    });
    const sheriffAction = actions.find(([id]) => {
      const player = this.players.get(id);
      return player?.role === "sheriff";
    });

    const killedId = mafiaAction ? mafiaAction[1] : null;
    const savedId = doctorAction ? doctorAction[1] : null;
    const checkedId = sheriffAction ? sheriffAction[1] : undefined;
    const checkedRole = checkedId ? this.players.get(checkedId)?.role : undefined;

    // Kill player if not saved
    if (killedId && killedId !== savedId) {
      const player = this.players.get(killedId);
      if (player) {
        player.isAlive = false;
      }
    }

    this.nightActions.clear();
    return { killedId, savedId, checkedId, checkedRole };
  }

  startDiscussion(): void {
    this.phase = "discussion";
    const alivePlayers = this.getAlivePlayers();
    
    // Start with individual discussion
    this.discussionState = {
      currentSpeakerId: alivePlayers[0]?.id || null,
      speakerOrder: alivePlayers.map((p) => p.id),
      currentSpeakerIndex: 0,
      isIndividualPhase: true,
      speakingTimePerPlayer: this.settings.individualDiscussionDuration,
    };
    this.updateEndTime(this.settings.individualDiscussionDuration);
  }

  nextSpeaker(): boolean {
    if (!this.discussionState) return false;

    if (this.discussionState.isIndividualPhase) {
      const nextIndex = this.discussionState.currentSpeakerIndex + 1;
      if (nextIndex < this.discussionState.speakerOrder.length) {
        this.discussionState.currentSpeakerIndex = nextIndex;
        this.discussionState.currentSpeakerId =
          this.discussionState.speakerOrder[nextIndex];
        this.updateEndTime(this.settings.individualDiscussionDuration);
        return true;
      } else {
        // Move to general discussion
        this.discussionState.isIndividualPhase = false;
        this.discussionState.currentSpeakerId = null;
        this.updateEndTime(this.settings.discussionDuration);
        return true;
      }
    }

    return false;
  }

  endDiscussion(): void {
    this.discussionState = null;
    this.phase = "voting";
    const alivePlayers = this.getAlivePlayers();
    
    // Start individual voting
    this.discussionState = {
      currentSpeakerId: alivePlayers[0]?.id || null,
      speakerOrder: alivePlayers.map((p) => p.id),
      currentSpeakerIndex: 0,
      isIndividualPhase: true,
      speakingTimePerPlayer: this.settings.individualVotingDuration,
    };
    this.votes.clear();
    this.updateEndTime(this.settings.individualVotingDuration);
  }

  vote(voterId: string, targetId: string): void {
    // Check if player already voted
    if (this.votes.has(voterId)) {
      throw new Error("Вы уже проголосовали");
    }
    this.votes.set(voterId, targetId);
  }

  getPlayerVote(playerId: string): string | undefined {
    return this.votes.get(playerId);
  }

  hasPlayerVoted(playerId: string): boolean {
    return this.votes.has(playerId);
  }

  getVotes(): string[] {
    return Array.from(this.votes.values());
  }

  nextVoter(): boolean {
    if (!this.discussionState) return false;

    const nextIndex = this.discussionState.currentSpeakerIndex + 1;
    if (nextIndex < this.discussionState.speakerOrder.length) {
      this.discussionState.currentSpeakerIndex = nextIndex;
      this.discussionState.currentSpeakerId =
        this.discussionState.speakerOrder[nextIndex];
      this.updateEndTime(this.settings.individualVotingDuration);
      return true;
    }

    return false;
  }

  processVoting(): {
    eliminatedId: string | null;
    votes: Record<string, number>;
    isTie: boolean;
  } {
    // Count votes
    const voteCounts: Record<string, number> = {};
    this.votes.forEach((targetId) => {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    // Auto-vote for players who didn't vote
    this.getAlivePlayers().forEach((player) => {
      if (!this.votes.has(player.id)) {
        voteCounts[player.id] = (voteCounts[player.id] || 0) + 1;
      }
    });

    // Find player(s) with most votes
    const maxVotes = Math.max(...Object.values(voteCounts), 0);
    const playersWithMaxVotes = Object.entries(voteCounts)
      .filter(([_, count]) => count === maxVotes)
      .map(([playerId]) => playerId);

    const isTie = playersWithMaxVotes.length > 1 || maxVotes === 0;
    const eliminatedId = isTie ? null : playersWithMaxVotes[0];

    if (eliminatedId) {
      const player = this.players.get(eliminatedId);
      if (player) {
        player.isAlive = false;
      }
    }

    this.votes.clear();
    this.discussionState = null;

    return { eliminatedId, votes: voteCounts, isTie };
  }

  checkGameEnd(): "mafia" | "town" | null {
    const alivePlayers = this.getAlivePlayers();
    const mafiaCount = alivePlayers.filter((p) => p.role === "mafia").length;
    const townCount = alivePlayers.filter((p) => p.role !== "mafia").length;

    if (mafiaCount === 0) return "town";
    if (mafiaCount >= townCount) return "mafia";
    return null;
  }

  addChatMessage(
    senderId: string,
    senderName: string,
    text: string,
    isSystem: boolean = false
  ): void {
    this.chatMessages.push({
      id: uuidv4(),
      senderId,
      senderName,
      text,
      timestamp: Date.now(),
      isSystem,
    });
  }

  getChatMessages() {
    return this.chatMessages;
  }

  private updateEndTime(durationSeconds: number): void {
    this.endTime = Date.now() + durationSeconds * 1000;
  }

  // Getters
  getId(): string {
    return this.id;
  }

  getCode(): string {
    return this.code;
  }

  getHostId(): string {
    return this.hostId;
  }

  getPhase(): GamePhase {
    return this.phase;
  }

  getRound(): number {
    return this.round;
  }

  getEndTime(): number | null {
    return this.endTime;
  }

  getDiscussionState(): DiscussionState | null {
    return this.discussionState;
  }

  getSettings(): GameSettings {
    return this.settings;
  }

  getCreatedAt(): number {
    return this.createdAt;
  }

  setIsEnded(ended: boolean): void {
    this.isEnded = ended;
  }

  getIsEnded(): boolean {
    return this.isEnded;
  }

  toGameRoom(): GameRoom {
    // Convert Maps to objects for JSON serialization
    const votes: Record<string, string> = {};
    this.votes.forEach((targetId, voterId) => {
      votes[voterId] = targetId;
    });
    
    const nightActions: Record<string, string> = {};
    this.nightActions.forEach((targetId, playerId) => {
      nightActions[playerId] = targetId;
    });

    return {
      id: this.id,
      code: this.code,
      hostId: this.hostId,
      players: this.getAllPlayers(),
      phase: this.phase,
      round: this.round,
      endTime: this.endTime || 0,
      maxPlayers: this.settings.maxPlayers || 16,
      minPlayers: this.settings.minPlayers || 4,
      createdAt: this.createdAt,
      settings: this.settings,
      discussionState: this.discussionState,
      chatMessages: this.chatMessages,
      votes,
      nightActions,
      isEnded: this.isEnded,
    };
  }
  
  // Restore room from full state
  static fromGameRoom(data: GameRoom): Room {
    const room = new Room(data.hostId, "", data.settings);
    room.id = data.id;
    room.code = data.code;
    room.hostId = data.hostId;
    room.phase = data.phase;
    room.round = data.round;
    room.endTime = data.endTime || null;
    room.createdAt = data.createdAt;
    room.settings = data.settings;
    room.discussionState = data.discussionState || null;
    room.chatMessages = data.chatMessages || [];
    room.isEnded = data.isEnded || false;
    
    // Restore players
    data.players.forEach((player) => {
      room.players.set(player.id, { ...player });
    });
    
    // Restore votes
    if (data.votes) {
      Object.entries(data.votes).forEach(([voterId, targetId]) => {
        room.votes.set(voterId, targetId);
      });
    }
    
    // Restore night actions
    if (data.nightActions) {
      Object.entries(data.nightActions).forEach(([playerId, targetId]) => {
        room.nightActions.set(playerId, targetId);
      });
    }
    
    return room;
  }
}
