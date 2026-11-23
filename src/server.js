import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);

/** @typedef {{ role: "host" | "guest"; playerId: string; room: string; socket: import("ws").WebSocket }} Client */

/** @type {Map<string, { host: Client | null; guests: Map<string, Client> }>} */
const rooms = new Map();

function getRoom(code) {
  const key = code.trim().toUpperCase();
  let room = rooms.get(key);
  if (!room) {
    room = { host: null, guests: new Map() };
    rooms.set(key, room);
  }
  return { key, room };
}

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function dropClient(client) {
  if (!client) return;
  const entry = rooms.get(client.room);
  if (!entry) return;
  if (client.role === "host" && entry.host?.playerId === client.playerId) {
    entry.host = null;
    for (const guest of entry.guests.values()) {
      send(guest.socket, { type: "host-gone" });
    }
  } else {
    entry.guests.delete(client.playerId);
    if (entry.host) {
      send(entry.host.socket, { type: "guest-left", playerId: client.playerId });
    }
  }
  if (!entry.host && entry.guests.size === 0) rooms.delete(client.room);
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      service: "domino-relay",
      rooms: rooms.size,
      uptime: Math.floor(process.uptime()),
    }),
  );
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  /** @type {Client | null} */
  let client = null;

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (data?.type === "join") {
      const code = typeof data.code === "string" ? data.code.trim().toUpperCase() : "";
      const role = data.role === "host" ? "host" : "guest";
      const playerId = typeof data.playerId === "string" ? data.playerId : "";
      if (!code || !playerId) {
        send(socket, { type: "error", message: "Código ou jogador inválido." });
        return;
      }
      if (client) dropClient(client);
      const { key, room } = getRoom(code);
      client = { role, playerId, room: key, socket };
      if (role === "host") {
        if (room.host && room.host.socket !== socket) {
          send(room.host.socket, { type: "host-replaced" });
          try {
            room.host.socket.close();
          } catch {
            /* ignore */
          }
        }
        room.host = client;
        send(socket, { type: "joined", role: "host", code: key, guests: [...room.guests.keys()] });
        for (const guest of room.guests.values()) {
          send(guest.socket, { type: "host-ready" });
        }
        return;
      }
      room.guests.set(playerId, client);
      send(socket, { type: "joined", role: "guest", code: key, hasHost: Boolean(room.host) });
      if (room.host) send(room.host.socket, { type: "guest-joined", playerId });
      return;
    }

    if (!client) {
      send(socket, { type: "error", message: "Entre na sala antes." });
      return;
    }

    const entry = rooms.get(client.room);
    if (!entry) return;

    if (data?.type === "up" && client.role === "guest") {
      if (!entry.host) {
        send(socket, { type: "host-gone" });
        return;
      }
      send(entry.host.socket, {
        type: "up",
        from: client.playerId,
        payload: data.payload,
      });
      return;
    }

    if (data?.type === "down" && client.role === "host") {
      const to = data.to;
      const payload = data.payload;
      if (to === "*") {
        for (const guest of entry.guests.values()) send(guest.socket, { type: "down", payload });
        return;
      }
      const guest = entry.guests.get(String(to));
      if (guest) send(guest.socket, { type: "down", payload });
    }
  });

  socket.on("close", () => dropClient(client));
  socket.on("error", () => dropClient(client));
});

server.listen(PORT, () => {
  console.log(`domino-relay listening on :${PORT}`);
});
