import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { RoomManager } from "./services/RoomManager.js";
import { GameTimer } from "./services/GameTimer.js";
import { RedisService } from "./services/RedisService.js";
import { setupSocketHandlers } from "./handlers/socketHandlers.js";
import { createAdminRouter } from "./routes/admin.js";

// Load environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
  : [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://192.168.1.5:5173",
      "http://localhost:3000",
    ];

const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes("*")) {
      callback(null, true);
    } else {
      // Allow any localhost or local network IP
      if (
        origin.match(/^http:\/\/localhost:\d+$/) ||
        origin.match(/^http:\/\/192\.168\.\d+\.\d+:\d+$/) ||
        origin.match(/^http:\/\/127\.0\.0\.1:\d+$/)
      ) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
};

app.use(cors(corsOptions));
app.use(express.json());

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// app.post("/getMessageId", async (req: any, res: any) => {
//   try {
//     const { roomId, userId } = req.body;
//     if (!roomId) {
//       return res.status(400).json({ error: "Missing roomId" });
//     }

//     // Создаём подготовленное сообщение через Bot API
//     const response = await fetch(
//       `https://api.telegram.org/bot${BOT_TOKEN}/savePreparedInlineMessage`,
//       {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({
//           user_id: userId,
//           web_app_name: "mafia",
//           allow_user_chats: true,
//           allow_group_chats: true,
//           result: {
//             type: "article",
//             id: roomId,
//             title: "Приглашение в Мафию",
//             input_message_content: {
//               message_text: `🎮 <b>Заходи ко мне поиграть в Мафию!</b>\nНомер комнаты: <code>${roomId}</code>`,
//               parse_mode: "HTML",
//             },
//           },
//         }),
//       },
//     );

//     const data = (await response.json()) as any;

//     if (!data.ok || !data.result?.id) {
//       return res.status(500).json({ error: JSON.stringify(data) });
//     }

//     // Возвращаем id подготовленного сообщения
//     res.json({
//       status: "ok",
//       messageId: data.result.id,
//       timestamp: new Date().toISOString(),
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Server error" });
//   }
// });

// Initialize Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow requests with no origin
      if (!origin) return callback(null, true);

      if (
        allowedOrigins.indexOf(origin) !== -1 ||
        allowedOrigins.includes("*")
      ) {
        callback(null, true);
      } else {
        // Allow any localhost or local network IP
        if (
          origin.match(/^http:\/\/localhost:\d+$/) ||
          origin.match(/^http:\/\/192\.168\.\d+\.\d+:\d+$/) ||
          origin.match(/^http:\/\/127\.0\.0\.1:\d+$/)
        ) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      }
    },
    credentials: true,
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
  allowEIO3: true,
});

// Initialize services
const redisService = new RedisService();
const roomManager = new RoomManager(redisService);
const gameTimer = new GameTimer(io, redisService);

// Peak users tracking
let peakUsers = 0;
function getConnectedCount() {
  return io.sockets.sockets.size;
}
function getPeakUsers() {
  return peakUsers;
}
function updatePeakUsers() {
  const count = io.sockets.sockets.size;
  if (count > peakUsers) peakUsers = count;
}

// Admin API
app.use("/admin", createAdminRouter(io, roomManager, redisService, getConnectedCount, getPeakUsers, updatePeakUsers));

// Setup socket handlers
setupSocketHandlers(io, roomManager, gameTimer, redisService);

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready`);
  console.log(`🌍 CORS enabled for: ${corsOptions.origin}`);

  // Test Redis connection
  try {
    const pingResult = await redisService.ping();
    console.log(`✅ Redis connection test: ${pingResult}`);
  } catch (error) {
    console.error("❌ Redis connection failed:", error);
  }
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully");
  httpServer.close(async () => {
    await redisService.disconnect();
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down gracefully");
  httpServer.close(async () => {
    await redisService.disconnect();
    console.log("Server closed");
    process.exit(0);
  });
});
