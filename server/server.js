const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const CLIENT_DIR = path.join(__dirname, "..", "client");
const clients = new Map();
const nicknameToWs = new Map();
const dmPairs = new Map();
const groupCalls = new Map();
const GROUP_MAX = 4;

function send404(res) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

function broadcastToRoom(roomId, payload) {
  const msg = JSON.stringify(payload);

  for (const [clientWs, info] of clients.entries()) {
    if (info.roomId === roomId && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(msg);
    }
  }
}

function broadcastToRoomExcept(roomId, excludeWs, payload) {
  const msg = JSON.stringify(payload);

  for (const [clientWs, info] of clients.entries()) {
    if (clientWs === excludeWs) continue;
    if (info.roomId === roomId && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(msg);
    }
  }
}

function broadcastUserList(wss) {
  const users = Array.from(nicknameToWs.keys());
  const payload = JSON.stringify({ type: "user-list", users });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function sendToNickname(nickname, payload) {
  const clientWs = nicknameToWs.get(nickname);
  if (!clientWs || clientWs.readyState !== WebSocket.OPEN) return false;
  clientWs.send(JSON.stringify(payload));
  return true;
}

function setDmPair(a, b) {
  dmPairs.set(a, b);
  dmPairs.set(b, a);
}

function clearDmPair(a) {
  const b = dmPairs.get(a);
  if (b) {
    dmPairs.delete(a);
    dmPairs.delete(b);
  }
  return b;
}

function getGroupSet(roomId) {
  let set = groupCalls.get(roomId);
  if (!set) {
    set = new Set();
    groupCalls.set(roomId, set);
  }
  return set;
}

const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(CLIENT_DIR, urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.log(`[WS] Static file not found: ${urlPath}`);
      return send404(res);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === ".html" ? "text/html" :
      ext === ".css" ? "text/css" :
      ext === ".js" ? "application/javascript" :
      "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("[WS] Client connected");

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (err) {
      console.log("[WS] Invalid JSON message");
      return;
    }

    if (data.type === "join") {
      if (!data.nickname || !data.roomId) return;
      clients.set(ws, { nickname: data.nickname, roomId: data.roomId });
      nicknameToWs.set(data.nickname, ws);
      console.log(`[WS] ${data.nickname} joined ${data.roomId}`);
      broadcastToRoom(data.roomId, {
        type: "system",
        text: `${data.nickname} joined the room`
      });
      const roomCount = Array.from(clients.values()).filter((info) => info.roomId === data.roomId).length;
      if (roomCount > 2) {
        ws.send(JSON.stringify({
          type: "system",
          text: "Room is full for video"
        }));
      }
      const groupSet = groupCalls.get(data.roomId);
      if (groupSet) {
        ws.send(JSON.stringify({
          type: "group-join-call",
          count: groupSet.size,
          max: GROUP_MAX
        }));
      }
      broadcastUserList(wss);
      return;
    }

    if (data.type === "message") {
      const client = clients.get(ws);
      if (!client || typeof data.text !== "string") return;
      broadcastToRoom(client.roomId, {
        type: "message",
        nickname: client.nickname,
        text: data.text
      });
      return;
    }

    if (data.type === "offer" || data.type === "answer" || data.type === "ice" || data.type === "hangup") {
      const client = clients.get(ws);
      if (!client) return;
      broadcastToRoomExcept(client.roomId, ws, data);
      return;
    }

    if (data.type === "dm-call-request" || data.type === "dm-call-accept" || data.type === "dm-call-reject" ||
        data.type === "dm-offer" || data.type === "dm-answer" || data.type === "dm-ice" || data.type === "dm-hangup") {
      const client = clients.get(ws);
      if (!client || !data.to) return;
      const target = data.to;
      const payload = { ...data, from: client.nickname };
      delete payload.to;

      const delivered = sendToNickname(target, payload);
      if (!delivered && data.type === "dm-call-request") {
        sendToNickname(client.nickname, {
          type: "dm-call-reject",
          from: target,
          reason: "offline"
        });
        return;
      }

      if (data.type === "dm-call-accept") {
        setDmPair(client.nickname, target);
      }

      if (data.type === "dm-call-reject" || data.type === "dm-hangup") {
        clearDmPair(client.nickname);
      }
      return;
    }

    if (data.type === "group-join-call") {
      const client = clients.get(ws);
      if (!client) return;
      const roomId = client.roomId;
      const groupSet = getGroupSet(roomId);
      if (groupSet.has(client.nickname)) return;
      if (groupSet.size >= GROUP_MAX) {
        ws.send(JSON.stringify({
          type: "group-join-call",
          full: true,
          count: groupSet.size,
          max: GROUP_MAX
        }));
        return;
      }

      groupSet.add(client.nickname);
      const participants = Array.from(groupSet).filter((name) => name !== client.nickname);
      ws.send(JSON.stringify({
        type: "group-join-call",
        you: true,
        participants,
        count: groupSet.size,
        max: GROUP_MAX
      }));

      participants.forEach((peer) => {
        sendToNickname(peer, {
          type: "group-join-call",
          from: client.nickname,
          count: groupSet.size,
          max: GROUP_MAX
        });
      });

      broadcastToRoom(roomId, {
        type: "group-join-call",
        count: groupSet.size,
        max: GROUP_MAX
      });
      return;
    }

    if (data.type === "group-leave-call") {
      const client = clients.get(ws);
      if (!client) return;
      const roomId = client.roomId;
      const groupSet = groupCalls.get(roomId);
      if (!groupSet || !groupSet.has(client.nickname)) return;
      groupSet.delete(client.nickname);
      groupSet.forEach((peer) => {
        sendToNickname(peer, {
          type: "group-leave-call",
          from: client.nickname,
          count: groupSet.size,
          max: GROUP_MAX
        });
      });
      broadcastToRoom(roomId, {
        type: "group-leave-call",
        count: groupSet.size,
        max: GROUP_MAX
      });
      if (groupSet.size === 0) {
        groupCalls.delete(roomId);
      }
      return;
    }

    if (data.type === "group-offer" || data.type === "group-answer" || data.type === "group-ice") {
      const client = clients.get(ws);
      if (!client || !data.to) return;
      const roomId = client.roomId;
      const groupSet = groupCalls.get(roomId);
      if (!groupSet || !groupSet.has(client.nickname) || !groupSet.has(data.to)) return;
      const payload = { ...data, from: client.nickname };
      delete payload.to;
      sendToNickname(data.to, payload);
    }
  });

  ws.on("close", () => {
    const client = clients.get(ws);
    if (client) {
      broadcastToRoom(client.roomId, {
        type: "system",
        text: `${client.nickname} left the room`
      });
      broadcastToRoomExcept(client.roomId, ws, {
        type: "hangup"
      });
      const peer = clearDmPair(client.nickname);
      if (peer) {
        sendToNickname(peer, {
          type: "dm-hangup",
          from: client.nickname
        });
      }
      if (nicknameToWs.get(client.nickname) === ws) {
        nicknameToWs.delete(client.nickname);
      }
      const groupSet = groupCalls.get(client.roomId);
      if (groupSet && groupSet.has(client.nickname)) {
        groupSet.delete(client.nickname);
        groupSet.forEach((peer) => {
          sendToNickname(peer, {
            type: "group-leave-call",
            from: client.nickname,
            count: groupSet.size,
            max: GROUP_MAX
          });
        });
        broadcastToRoom(client.roomId, {
          type: "group-leave-call",
          count: groupSet.size,
          max: GROUP_MAX
        });
        if (groupSet.size === 0) {
          groupCalls.delete(client.roomId);
        }
      }
      clients.delete(ws);
      broadcastUserList(wss);
    }
    console.log("[WS] Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`[WS] Server listening on http://localhost:${PORT}`);
});
