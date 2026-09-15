import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";

export interface WsPlayerState {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  currentHp: number;
  maxHp: number;
  isAttacking: boolean;
  isDashing: boolean;
  isJumping: boolean;
  attackType?: "normal" | "special";
  creature?: any;
  lastPacketTime: number;
}

export interface WsRoomSession {
  code: string;
  name: string;
  hostId: string;
  mode: string;
  maxPlayers: number;
  status: "waiting" | "in-match" | "ended";
  createdAt: number;
  botsEnabled: boolean;
  // Map playerId -> WsPlayerState
  players: Map<string, WsPlayerState>;
  // Map playerId -> WebSocket connection
  sockets: Map<string, WebSocket>;
  // Map playerId -> disconnect timestamp (for reconnection grace period)
  disconnectedAt: Map<string, number>;
}

// In-memory real-time rooms
export const wsRooms = new Map<string, WsRoomSession>();

// Client socket -> metadata
interface ClientMeta {
  playerId?: string;
  roomCode?: string;
  lastPing: number;
  packetCount: number;
  lastRateReset: number;
}
const socketMeta = new WeakMap<WebSocket, ClientMeta>();

// Helper to broadcast to all players in a room except optionally the sender
export function broadcastToRoom(
  room: WsRoomSession,
  message: object,
  excludePlayerId?: string
) {
  const payload = JSON.stringify(message);
  for (const [pid, sock] of room.sockets.entries()) {
    if (excludePlayerId && pid === excludePlayerId) continue;
    if (sock.readyState === WebSocket.OPEN) {
      try {
        sock.send(payload);
      } catch (err) {
        console.error(`[WS] Broadcast error to ${pid}:`, err);
      }
    }
  }
}

export function setupWebSocketMultiplayer(
  server: HttpServer,
  activeRoomsMap: Map<string, any>
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: "/ws/multiplayer",
  });

  console.log("[WS] Real-time Multiplayer WebSocket Server mounted at /ws/multiplayer");

  // Keep-alive heartbeat interval (ping every 25 seconds to keep Render/Railway reverse proxy connections open)
  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        const meta = socketMeta.get(client);
        if (meta && now - meta.lastPing > 60000) {
          // Client timed out
          client.terminate();
          continue;
        }
        try {
          client.ping();
        } catch {}
      }
    }

    // Room cleanup: remove empty rooms or rooms where everyone has been disconnected > 60 seconds
    for (const [code, room] of wsRooms.entries()) {
      const activeSockets = Array.from(room.sockets.values()).filter(
        (s) => s.readyState === WebSocket.OPEN
      );
      if (activeSockets.length === 0) {
        let allExpired = true;
        for (const [pid, discTime] of room.disconnectedAt.entries()) {
          if (now - discTime < 45000) {
            // Still in grace period for reconnecting mobile devices
            allExpired = false;
            break;
          }
        }
        if (allExpired && now - room.createdAt > 45000) {
          console.log(`[WS Room] Pruning inactive room [${code}]`);
          wsRooms.delete(code);
          activeRoomsMap.delete(code);
        }
      }
    }
  }, 20000);

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const meta: ClientMeta = {
      lastPing: Date.now(),
      packetCount: 0,
      lastRateReset: Date.now(),
    };
    socketMeta.set(ws, meta);

    ws.on("pong", () => {
      const m = socketMeta.get(ws);
      if (m) m.lastPing = Date.now();
    });

    ws.on("message", (raw: string | Buffer) => {
      try {
        const now = Date.now();
        // Rate limiting: max 80 packets per second per socket
        if (now - meta.lastRateReset > 1000) {
          meta.packetCount = 0;
          meta.lastRateReset = now;
        }
        meta.packetCount++;
        if (meta.packetCount > 90) {
          // Packet flood guard
          return;
        }

        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg.type !== "string") return;

        handleClientMessage(ws, meta, msg, activeRoomsMap);
      } catch (err) {
        console.warn("[WS] Malformed packet received:", err);
      }
    });

    ws.on("close", () => {
      handleClientDisconnect(ws, meta, activeRoomsMap);
    });

    ws.on("error", (err) => {
      console.warn("[WS Client Error]:", err?.message);
    });
  });

  return wss;
}

function handleClientMessage(
  ws: WebSocket,
  meta: ClientMeta,
  msg: any,
  activeRoomsMap: Map<string, any>
) {
  switch (msg.type) {
    case "ping": {
      meta.lastPing = Date.now();
      ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      break;
    }

    // 1. Join or Reconnect into Room
    case "join_room": {
      const roomCode = String(msg.roomCode || "").trim().toUpperCase();
      const playerId = String(msg.playerId || "").trim();
      const playerName = String(msg.playerName || "Pilot").trim();
      const creature = msg.creature || null;

      if (!roomCode || !playerId) {
        ws.send(JSON.stringify({ type: "error", message: "Missing roomCode or playerId" }));
        return;
      }

      meta.playerId = playerId;
      meta.roomCode = roomCode;

      let room = wsRooms.get(roomCode);
      if (!room) {
        // Sync with activeRoomsMap if room was created via REST
        const existingRestRoom = activeRoomsMap.get(roomCode);
        room = {
          code: roomCode,
          name: existingRestRoom?.name || `${roomCode} Match`,
          hostId: existingRestRoom?.hostId || playerId,
          mode: existingRestRoom?.mode || "classic",
          maxPlayers: existingRestRoom?.maxPlayers || 8,
          status: existingRestRoom?.status || "waiting",
          createdAt: existingRestRoom?.createdAt || Date.now(),
          botsEnabled: existingRestRoom?.botsEnabled ?? true,
          players: new Map(),
          sockets: new Map(),
          disconnectedAt: new Map(),
        };
        wsRooms.set(roomCode, room);
      }

      // Check max players for new joiners
      const isReconnecting = room.players.has(playerId);
      if (!isReconnecting && room.players.size >= room.maxPlayers) {
        ws.send(JSON.stringify({ type: "error", message: "Room is full" }));
        return;
      }

      // Update room state
      const defaultHp = creature?.stats?.hp || 1000;
      const existingPlayer = room.players.get(playerId);
      const playerState: WsPlayerState = {
        id: playerId,
        name: playerName,
        x: existingPlayer?.x ?? (Math.random() * 8 - 4),
        y: 0,
        z: existingPlayer?.z ?? (Math.random() * 8 - 4),
        rotation: existingPlayer?.rotation ?? 0,
        currentHp: existingPlayer?.currentHp ?? defaultHp,
        maxHp: existingPlayer?.maxHp ?? defaultHp,
        isAttacking: false,
        isDashing: false,
        isJumping: false,
        creature: creature || existingPlayer?.creature,
        lastPacketTime: Date.now(),
      };

      room.players.set(playerId, playerState);
      room.sockets.set(playerId, ws);
      room.disconnectedAt.delete(playerId);

      // Keep activeRoomsMap in sync
      const restPlayers = Array.from(room.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        isHost: p.id === room.hostId,
        creature: p.creature,
        isReady: true,
        ping: 20,
      }));
      activeRoomsMap.set(roomCode, {
        code: roomCode,
        name: room.name,
        hostId: room.hostId,
        mode: room.mode,
        maxPlayers: room.maxPlayers,
        status: room.status,
        createdAt: room.createdAt,
        botsEnabled: room.botsEnabled,
        players: restPlayers,
      });

      console.log(`[WS] Pilot [${playerName} (${playerId})] joined room [${roomCode}] (Count: ${room.players.size})`);

      // 1a. Send acknowledgment to the joining player with full room snapshot
      const allPlayers = Array.from(room.players.values());
      ws.send(
        JSON.stringify({
          type: "room_joined",
          room: {
            code: room.code,
            name: room.name,
            hostId: room.hostId,
            mode: room.mode,
            status: room.status,
            players: allPlayers,
          },
          you: playerState,
          isReconnect: isReconnecting,
        })
      );

      // 1b. Broadcast to other players in the room
      broadcastToRoom(
        room,
        {
          type: "player_joined",
          player: playerState,
        },
        playerId
      );
      break;
    }

    // 2. Real-time Movement & Combat State Synchronization
    case "player_move":
    case "combat_packet": {
      const roomCode = meta.roomCode;
      const playerId = meta.playerId;
      if (!roomCode || !playerId) return;

      const room = wsRooms.get(roomCode);
      if (!room) return;

      const player = room.players.get(playerId);
      if (!player) return;

      // Server validation and clamping
      const x = typeof msg.x === "number" && !isNaN(msg.x) ? Math.max(-120, Math.min(120, msg.x)) : player.x;
      const y = typeof msg.y === "number" && !isNaN(msg.y) ? Math.max(0, Math.min(40, msg.y)) : player.y;
      const z = typeof msg.z === "number" && !isNaN(msg.z) ? Math.max(-120, Math.min(120, msg.z)) : player.z;
      const rot = typeof msg.rotation === "number" && !isNaN(msg.rotation) ? msg.rotation : player.rotation;

      player.x = x;
      player.y = y;
      player.z = z;
      player.rotation = rot;
      player.isAttacking = !!msg.isAttacking;
      player.isDashing = !!msg.isDashing;
      player.isJumping = !!msg.isJumping;
      player.attackType = msg.attackType || "normal";
      player.lastPacketTime = Date.now();

      // Broadcast high-speed state to others in room
      broadcastToRoom(
        room,
        {
          type: "player_state",
          senderId: playerId,
          senderName: player.name,
          creature: player.creature,
          x: player.x,
          y: player.y,
          z: player.z,
          rotation: player.rotation,
          currentHp: player.currentHp,
          maxHp: player.maxHp,
          isAttacking: player.isAttacking,
          isDashing: player.isDashing,
          isJumping: player.isJumping,
          attackType: player.attackType,
          timestamp: Date.now(),
        },
        playerId
      );
      break;
    }

    // 3. Server-Authoritative Combat Attack & Damage Event
    case "player_attack":
    case "damage_event": {
      const roomCode = meta.roomCode;
      const attackerId = meta.playerId;
      if (!roomCode || !attackerId) return;

      const room = wsRooms.get(roomCode);
      if (!room) return;

      const targetId = String(msg.targetId || "").trim();
      const rawDamage = Number(msg.damage) || 0;
      const isCritical = !!msg.isCritical;

      // Validate damage range (clamp to reasonable upper bound)
      const sanitizedDamage = Math.max(1, Math.min(500, Math.round(rawDamage)));

      const targetPlayer = room.players.get(targetId);
      if (targetPlayer && targetPlayer.currentHp > 0) {
        // Authoritatively subtract health on server
        targetPlayer.currentHp = Math.max(0, targetPlayer.currentHp - sanitizedDamage);
        const isDead = targetPlayer.currentHp <= 0;

        const damageBroadcast = {
          type: "damage",
          attackerId,
          targetId,
          damage: sanitizedDamage,
          isCritical,
          remainingHp: targetPlayer.currentHp,
          timestamp: Date.now(),
        };

        // Broadcast damage to all players in the room (including attacker and target)
        broadcastToRoom(room, damageBroadcast);

        if (isDead) {
          console.log(`[Combat] Player [${targetPlayer.name} (${targetId})] defeated in room [${roomCode}]`);
          broadcastToRoom(room, {
            type: "player_dead",
            playerId: targetId,
            killerId: attackerId,
            timestamp: Date.now(),
          });
        }
      } else {
        // Fallback: If target is an AI bot in client's local simulation, broadcast damage event
        broadcastToRoom(
          room,
          {
            type: "damage",
            attackerId,
            targetId,
            damage: sanitizedDamage,
            isCritical,
            remainingHp: Math.max(0, (msg.remainingHp ?? 100) - sanitizedDamage),
            timestamp: Date.now(),
          },
          attackerId
        );
      }
      break;
    }

    // 4. Player Respawn
    case "player_respawn": {
      const roomCode = meta.roomCode;
      const playerId = meta.playerId;
      if (!roomCode || !playerId) return;

      const room = wsRooms.get(roomCode);
      if (!room) return;

      const player = room.players.get(playerId);
      if (player) {
        player.currentHp = player.maxHp;
        player.x = (Math.random() - 0.5) * 20;
        player.y = 0;
        player.z = (Math.random() - 0.5) * 20;

        broadcastToRoom(room, {
          type: "player_respawned",
          player,
          timestamp: Date.now(),
        });
      }
      break;
    }

    // 5. Game Start / End
    case "game_start": {
      const roomCode = meta.roomCode;
      const room = roomCode ? wsRooms.get(roomCode) : null;
      if (room && room.hostId === meta.playerId) {
        room.status = "in-match";
        const restRoom = activeRoomsMap.get(roomCode);
        if (restRoom) restRoom.status = "in-match";

        broadcastToRoom(room, {
          type: "game_started",
          roomCode,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "leave_room": {
      handleClientDisconnect(ws, meta, activeRoomsMap);
      break;
    }
  }
}

function handleClientDisconnect(
  ws: WebSocket,
  meta: ClientMeta,
  activeRoomsMap: Map<string, any>
) {
  const { roomCode, playerId } = meta;
  if (!roomCode || !playerId) return;

  const room = wsRooms.get(roomCode);
  if (!room) return;

  room.sockets.delete(playerId);
  room.disconnectedAt.set(playerId, Date.now());

  console.log(`[WS] Pilot [${playerId}] disconnected from room [${roomCode}] (Grace period 45s started)`);

  // Inform other players in the room about temporary disconnect
  broadcastToRoom(room, {
    type: "player_disconnected",
    playerId,
    timestamp: Date.now(),
  });

  // Re-elect host if host left
  if (room.hostId === playerId) {
    const activePlayerIds = Array.from(room.sockets.keys());
    if (activePlayerIds.length > 0) {
      room.hostId = activePlayerIds[0];
      const newHost = room.players.get(room.hostId);
      console.log(`[WS] New host elected for [${roomCode}]: ${newHost?.name || room.hostId}`);
      broadcastToRoom(room, {
        type: "host_changed",
        newHostId: room.hostId,
      });
    }
  }

  // Clear meta on this socket
  meta.roomCode = undefined;
}
