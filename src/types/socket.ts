import { Player, GamePhase, Role, DiscussionState, GameSettings } from "./game.js";

// Socket event types
export interface ServerToClientEvents {
  // Room events
  "room:joined": (data: { roomCode: string; players: Player[]; settings: GameSettings; createdAt: number }) => void;
  "room:player-joined": (player: Player) => void;
  "room:player-left": (data: { playerId: string; playerName: string }) => void;
  "room:player-disconnected": (data: { playerId: string }) => void;
  "room:player-reconnected": (data: { playerId: string }) => void;
  "room:host-changed": (hostId: string) => void;
  "room:active-found": (data: { roomCode: string; playerName: string }) => void; // Active room found for player
  "room:no-active": () => void; // No active room found
  "room:check-result": (data: { hasActiveRoom: boolean; roomCode?: string; playerName?: string }) => void; // Result of room check on entry

  // Game state events
  "game:started": (data: { players: Player[] }) => void;
  "game:phase-changed": (data: {
    phase: GamePhase;
    round: number;
    endTime: number; // unix timestamp in milliseconds
  }) => void;
  "game:role-assigned": (role: Role) => void;
  "game:player-eliminated": (data: { playerId: string; role?: Role }) => void;
  "game:players-updated": (data: { players: Player[] }) => void;
  "game:ended": (data: { winner: "mafia" | "town"; players: Player[] }) => void;

  // Discussion events
  "discussion:started": (data: DiscussionState) => void;
  "discussion:speaker-changed": (data: {
    currentSpeakerId: string;
    currentSpeakerIndex: number;
    endTime: number; // unix timestamp in milliseconds
  }) => void;
  "discussion:individual-ended": () => void;
  "discussion:ended": () => void;

  // Action events
  "action:vote-received": (data: { voterId: string; targetId: string }) => void;
  "action:vote-result": (data: {
    eliminatedId: string | null;
    votes: Record<string, number>;
    isTie: boolean;
  }) => void;
  "action:night-result": (data: {
    killedId: string | null;
    savedId: string | null;
    checkedId?: string;
    checkedRole?: Role;
  }) => void;

  // Chat events
  "chat:message": (message: ChatMessage) => void;
  "chat:system": (message: string) => void;
  "users:count": (count: number) => void;

  // Error events
  error: (message: string) => void;
}

export interface ClientToServerEvents {
  // Room events
  "room:create": (playerName: string, playerId?: string) => void;
  "room:join": (data: { roomCode: string; playerName: string; playerId?: string }) => void;
  "room:leave": () => void;
  "room:delete": () => void;
  "room:check-active": (playerId: string) => void; // Check if player has active room
  "room:check-on-entry": (playerId: string) => void; // Check if player has active room on app entry

  // Game events
  "game:start": () => void;

  // Action events
  "action:vote": (targetId: string) => void;
  "action:night-action": (targetId: string) => void;

  // Chat events
  "chat:send": (text: string) => void;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}
