export type Role = "mafia" | "citizen" | "doctor" | "sheriff";

export type GamePhase =
  | "lobby"
  | "night"
  | "discussion"
  | "day"
  | "voting"
  | "ended";

export interface Player {
  id: string;
  name: string;
  avatar?: string;
  role?: Role;
  isAlive: boolean;
  isHost: boolean;
}

export interface GameRoom {
  id: string;
  code: string;
  hostId: string;
  players: Player[];
  phase: GamePhase;
  round: number;
  endTime: number; // unix timestamp in milliseconds
  maxPlayers: number;
  minPlayers: number;
  createdAt: number; // unix timestamp in milliseconds
  settings: GameSettings;
  discussionState?: DiscussionState | null;
  chatMessages?: Array<{
    id: string;
    senderId: string;
    senderName: string;
    text: string;
    timestamp: number;
    isSystem?: boolean;
  }>;
  votes?: Record<string, string>; // voterId -> targetId
  nightActions?: Record<string, string>; // playerId -> targetId
  isEnded?: boolean; // true if game has ended
}

export interface DiscussionState {
  currentSpeakerId: string | null;
  speakerOrder: string[];
  currentSpeakerIndex: number;
  isIndividualPhase: boolean; // true = individual turns, false = general discussion
  speakingTimePerPlayer: number;
}

export interface GameSettings {
  nightDuration: number;
  discussionDuration: number;
  dayDuration: number;
  votingDuration: number;
  individualDiscussionDuration: number;
  individualVotingDuration: number;
  mafiaCount: number;
  hasDoctor: boolean;
  hasSheriff: boolean;
  minPlayers: number;
  maxPlayers: number;
}

export interface NightAction {
  mafiaTarget?: string;
  doctorTarget?: string;
  sheriffTarget?: string;
}

export interface VoteResult {
  eliminatedId: string | null;
  votes: Record<string, number>;
  isTie: boolean;
}
