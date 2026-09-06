// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const engine = require("./gameEngine");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
// حالة كل الغرف تعيش هنا في الذاكرة (single-process MVP).
// ملاحظة توسّع: عند الحاجة لأكثر من عملية/خادم، انقل هذا الكائن
// إلى Redis (Hash لكل غرفة) واستخدم Redis Pub/Sub لبث الأحداث بين
// الخوادم، مع Lua script لعملية revealWord لضمان نفس الذرية الحالية.
const rooms = {};

function genRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id;
  do {
    id = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[id]);
  return id;
}

function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  for (const socketId of Object.keys(room.players)) {
    const sock = io.sockets.sockets.get(socketId);
    if (sock) {
      sock.emit("roomState", engine.getViewForSocket(room, socketId));
    }
  }
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    const roomId = genRoomId();
    rooms[roomId] = engine.createRoom(roomId, socket.id, name || "لاعب");
    socket.join(roomId);
    socket.data.roomId = roomId;
    cb && cb({ ok: true, roomId });
    broadcastRoom(roomId);
  });

  socket.on("joinRoom", ({ roomId, name }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb && cb({ error: "الغرفة غير موجودة" });
    engine.joinRoom(room, socket.id, name || "لاعب");
    socket.join(roomId);
    socket.data.roomId = roomId;
    cb && cb({ ok: true, roomId });
    broadcastRoom(roomId);
  });

  socket.on("setTeamRole", ({ team, role }, cb) => {
    const room = rooms[socket.data.roomId];
    if (!room) return cb && cb({ error: "لست داخل غرفة" });
    const res = engine.setTeamRole(room, socket.id, team, role);
    cb && cb(res);
    if (res.ok) broadcastRoom(room.id);
  });

  socket.on("startGame", (_, cb) => {
    const room = rooms[socket.data.roomId];
    if (!room) return cb && cb({ error: "لست داخل غرفة" });
    const res = engine.startGame(room);
    cb && cb(res);
    if (res.ok) broadcastRoom(room.id);
  });

  socket.on("giveClue", ({ word, count }, cb) => {
    const room = rooms[socket.data.roomId];
    if (!room) return cb && cb({ error: "لست داخل غرفة" });
    const res = engine.giveClue(room, socket.id, word, count);
    cb && cb(res);
    if (res.ok) broadcastRoom(room.id);
  });

  socket.on("revealWord", ({ index }, cb) => {
    const room = rooms[socket.data.roomId];
    if (!room) return cb && cb({ error: "لست داخل غرفة" });
    const res = engine.revealWord(room, socket.id, index);
    cb && cb(res);
    if (res.ok) broadcastRoom(room.id);
  });

  socket.on("endTurn", (_, cb) => {
    const room = rooms[socket.data.roomId];
    if (!room) return cb && cb({ error: "لست داخل غرفة" });
    const res = engine.endTurn(room, socket.id);
    cb && cb(res);
    if (res.ok) broadcastRoom(room.id);
  });

  socket.on("chatMessage", ({ text }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    engine.addChat(room, socket.id, text);
    broadcastRoom(room.id);
  });

  socket.on("disconnect", () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    if (room.players[socket.id]) {
      room.players[socket.id].connected = false;
    }
    broadcastRoom(room.id);
    // تنظيف الغرف الفارغة تمامًا بعد فترة
    setTimeout(() => {
      const r = rooms[socket.data.roomId];
      if (!r) return;
      const anyConnected = Object.values(r.players).some((p) => p.connected);
      if (!anyConnected) delete rooms[socket.data.roomId];
    }, 5 * 60 * 1000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`الشِفرة تعمل على http://localhost:${PORT}`);
});
