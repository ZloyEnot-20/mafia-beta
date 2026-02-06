import { Router, Request, Response } from "express";
import { Server } from "socket.io";
import { RoomManager } from "../services/RoomManager.js";
import { RedisService } from "../services/RedisService.js";

const STALE_ROOM_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without activity

function createAdminRouter(
  io: Server,
  roomManager: RoomManager,
  redisService: RedisService,
  getConnectedCount: () => number,
  getPeakUsers: () => number,
  updatePeakUsers: () => void
): Router {
  const router = Router();
  const adminPassword = process.env.ADMIN_PASSWORD

  function requireAdmin(req: Request, res: Response, next: () => void) {
    const authHeader = req.headers.authorization;
    const token =
      (typeof authHeader === "string" ? authHeader.replace("Bearer ", "") : null) ||
      (req.headers["x-admin-token"] as string) ||
      (req.query?.token as string) ||
      req.body?.token;
    if (!token || token !== adminPassword) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  router.post("/login", (req: Request, res: Response) => {
    const token =
      (req.headers.authorization?.replace?.("Bearer ", "") as string) ||
      req.body?.password ||
      req.body?.token;
    if (token === adminPassword) {
      res.json({ success: true, token: adminPassword });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  router.use(requireAdmin);

  function getStatsData() {
    updatePeakUsers();
    const rooms = roomManager.getAllRooms();
    const roomsInGame = rooms.filter((r) => r.getPhase() !== "lobby" && r.getPhase() !== "ended");
    const roomsInLobby = rooms.filter((r) => r.getPhase() === "lobby");
    const now = Date.now();
    const staleRooms = rooms.filter((r) => {
      if (r.getPhase() === "lobby" || r.getPhase() === "ended") return false;
      const endTime = r.getEndTime();
      return !endTime || now - endTime > STALE_ROOM_THRESHOLD_MS;
    });
    return {
      usersOnline: getConnectedCount(),
      peakUsers: getPeakUsers(),
      activeRooms: rooms.length,
      roomsInGame: roomsInGame.length,
      roomsInLobby: roomsInLobby.length,
      staleRooms: staleRooms.length,
    };
  }

  function getUsersData() {
    const rooms = roomManager.getAllRooms();
    const usersMap = new Map<
      string,
      { id: string; roomCode: string | null; status: string; lastActivity: number }
    >();
    const socketIdsInRooms = new Set<string>();

    rooms.forEach((room) => {
      const roomCode = room.getCode();
      const phase = room.getPhase();
      room.getAllPlayers().forEach((player) => {
        const socketId = room.getSocketId(player.id);
        if (socketId) socketIdsInRooms.add(socketId);
        const isConnected = !!socketId;
        const status =
          phase === "lobby"
            ? "lobby"
            : phase === "ended"
              ? "ended"
              : isConnected
                ? "in_game"
                : "disconnected";
        const endTime = room.getEndTime() || room.getCreatedAt();
        usersMap.set(player.id, {
          id: player.id,
          roomCode,
          status,
          lastActivity: endTime,
        });
      });
    });

    // Добавить подключённых пользователей без комнаты (idle)
    const now = Date.now();
    io.sockets.sockets.forEach((socket) => {
      if (!socketIdsInRooms.has(socket.id)) {
        usersMap.set(socket.id, {
          id: socket.id,
          roomCode: null,
          status: "idle",
          lastActivity: now,
        });
      }
    });

    return { users: Array.from(usersMap.values()) };
  }

  function getRoomsData() {
    const rooms = roomManager.getAllRooms();
    const now = Date.now();
    return {
      rooms: rooms.map((room) => {
        const endTime = room.getEndTime();
        const lastActivity = endTime || room.getCreatedAt();
        const createdAt = room.getCreatedAt();
        const isStale =
          room.getPhase() !== "lobby" &&
          room.getPhase() !== "ended" &&
          (!endTime || now - endTime > STALE_ROOM_THRESHOLD_MS);
        const durationMs = now - createdAt;
        return {
          code: room.getCode(),
          phase: room.getPhase(),
          playersCount: room.getAllPlayers().length,
          createdAt,
          lastActivity,
          isStale,
          durationMs,
        };
      }),
    };
  }

  function getRoomData(roomCode: string) {
    const room = roomManager.getRoom(roomCode.toUpperCase());
    if (!room) return null;
    const endTime = room.getEndTime();
    const now = Date.now();
    const lastActivity = endTime || room.getCreatedAt();
    const isStale =
      room.getPhase() !== "lobby" &&
      room.getPhase() !== "ended" &&
      (!endTime || now - endTime > STALE_ROOM_THRESHOLD_MS);
    return {
      code: room.getCode(),
      phase: room.getPhase(),
      round: room.getRound(),
      players: room.getAllPlayers().map((p) => ({
        ...p,
        isConnected: !!room.getSocketId(p.id),
      })),
      createdAt: room.getCreatedAt(),
      lastActivity,
      isStale,
      discussionState: room.getDiscussionState(),
      chatMessages: room.getChatMessages(),
    };
  }

  // SSE stream - admin data pushed every 3s
  router.get("/events", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const roomCode = req.query?.room as string | undefined;
    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const tick = () => {
      try {
        sendEvent("stats", getStatsData());
        sendEvent("users", getUsersData());
        sendEvent("rooms", getRoomsData());
        if (roomCode) {
          const roomData = getRoomData(roomCode);
          sendEvent("room", roomData);
        }
      } catch (err) {
        console.error("Admin SSE error:", err);
      }
    };

    tick();
    const interval = setInterval(tick, 3000);

    req.on("close", () => {
      clearInterval(interval);
      res.end();
    });
  });

  // Overview stats
  router.get("/stats", (_req: Request, res: Response) => {
    try {
      res.json(getStatsData());
    } catch (err) {
      console.error("Admin stats error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Online users
  router.get("/users", (_req: Request, res: Response) => {
    try {
      res.json(getUsersData());
    } catch (err) {
      console.error("Admin users error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Rooms list
  router.get("/rooms", (_req: Request, res: Response) => {
    try {
      res.json(getRoomsData());
    } catch (err) {
      console.error("Admin rooms error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Room details
  router.get("/rooms/:code", (req: Request, res: Response) => {
    try {
      const roomData = getRoomData(req.params.code);
      if (!roomData) {
        res.status(404).json({ error: "Room not found" });
        return;
      }
      res.json(roomData);
    } catch (err) {
      console.error("Admin room details error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Disconnect user
  router.post("/users/:userId/disconnect", async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const room = roomManager.getRoomByPlayerId(userId);
      if (room) {
        const socketId = room.getSocketId(userId);
        if (socketId) {
          io.sockets.sockets.get(socketId)?.disconnect(true);
        }
        await roomManager.leaveRoom(userId);
      }
      res.json({ success: true });
    } catch (err) {
      console.error("Admin disconnect error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // End room (force finish game)
  router.post("/rooms/:code/end", async (req: Request, res: Response) => {
    try {
      const code = req.params.code.toUpperCase();
      const room = roomManager.getRoom(code);
      if (!room) {
        res.status(404).json({ error: "Room not found" });
        return;
      }
      room.setIsEnded(true);
      io.to(code).emit("game:ended", {
        winner: "town",
        players: room.getAllPlayers(),
      });
      roomManager.removeRoom(code);
      await redisService.deleteRoom(code);
      res.json({ success: true });
    } catch (err) {
      console.error("Admin end room error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete room
  router.delete("/rooms/:code", async (req: Request, res: Response) => {
    try {
      const code = req.params.code.toUpperCase();
      const room = roomManager.getRoom(code);
      if (!room) {
        res.status(404).json({ error: "Room not found" });
        return;
      }
      room.getAllPlayers().forEach((p) => {
        const socketId = room.getSocketId(p.id);
        if (socketId) {
          io.sockets.sockets.get(socketId)?.disconnect(true);
        }
      });
      roomManager.removeRoom(code);
      await redisService.deleteRoom(code);
      res.json({ success: true });
    } catch (err) {
      console.error("Admin delete room error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove player from room
  router.post("/rooms/:code/players/:playerId/remove", async (req: Request, res: Response) => {
    try {
      const { code, playerId } = req.params;
      const room = roomManager.getRoom(code.toUpperCase());
      if (!room) {
        res.status(404).json({ error: "Room not found" });
        return;
      }
      const socketId = room.getSocketId(playerId);
      if (socketId) {
        io.sockets.sockets.get(socketId)?.disconnect(true);
      }
      await roomManager.leaveRoom(playerId);
      res.json({ success: true });
    } catch (err) {
      console.error("Admin remove player error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

export { createAdminRouter };
