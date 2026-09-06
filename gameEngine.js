// gameEngine.js
// محرك حالة لعبة "الشِفرة" - منطق نقي بلا اعتماد على Socket.io
// كل الدوال هنا متزامنة (synchronous) عمدًا: بما أن Node.js يعمل بخيط واحد
// لكل عملية، فإن أي تعديل على حالة الغرفة يتم بالكامل قبل معالجة أي حدث آخر،
// وهذا يمنع تعارض الكشف المتزامن (race conditions) دون الحاجة لأقفال خارجية
// طالما كل الغرف تُدار داخل نفس العملية (process) الواحدة.
// عند التوسّع لاحقًا لعدة عمليات/خوادم، يجب نقل هذه الحالة إلى Redis
// واستخدام Lua scripts أو MULTI/EXEC لضمان نفس الضمان الذري.

const fs = require("fs");
const path = require("path");

const WORD_BANK = JSON.parse(
  fs.readFileSync(path.join(__dirname, "words.json"), "utf8")
);

const BOARD_SIZE = 25;
const TEAMS = ["red", "blue"];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createRoom(id, hostSocketId, hostName) {
  return {
    id,
    createdAt: Date.now(),
    phase: "lobby", // lobby | playing | ended
    players: {
      // socketId: { name, team, role, connected }
      [hostSocketId]: { name: hostName, team: null, role: null, connected: true },
    },
    hostId: hostSocketId,
    board: [], // [{ word, color, revealed }]
    startingTeam: null,
    turn: null, // 'red' | 'blue'
    turnPhase: null, // 'clue' | 'guess'
    currentClue: null, // { word, count, guessesLeft }
    winner: null,
    log: [], // سجل الأحداث المرئي للجميع
    chat: [],
    scores: { red: 0, blue: 0 },
  };
}

function buildBoard() {
  const words = shuffle(WORD_BANK).slice(0, BOARD_SIZE);
  const startingTeam = Math.random() < 0.5 ? "red" : "blue";
  const otherTeam = startingTeam === "red" ? "blue" : "red";

  const colors = [
    ...Array(9).fill(startingTeam),
    ...Array(8).fill(otherTeam),
    ...Array(7).fill("neutral"),
    "assassin",
  ];
  const shuffledColors = shuffle(colors);

  const board = words.map((word, i) => ({
    word,
    color: shuffledColors[i],
    revealed: false,
  }));

  return { board, startingTeam };
}

function addLog(room, text) {
  room.log.push({ text, ts: Date.now() });
  if (room.log.length > 200) room.log.shift();
}

function playerCounts(room) {
  const counts = { red: { spymaster: 0, operative: 0 }, blue: { spymaster: 0, operative: 0 } };
  for (const p of Object.values(room.players)) {
    if (p.team && p.role) counts[p.team][p.role]++;
  }
  return counts;
}

function joinRoom(room, socketId, name) {
  if (!room.players[socketId]) {
    room.players[socketId] = { name, team: null, role: null, connected: true };
    addLog(room, `${name} انضم إلى الغرفة`);
  } else {
    room.players[socketId].connected = true;
  }
}

function setTeamRole(room, socketId, team, role) {
  const player = room.players[socketId];
  if (!player) return { error: "لاعب غير موجود" };
  if (!TEAMS.includes(team)) return { error: "فريق غير صالح" };
  if (!["spymaster", "operative"].includes(role)) return { error: "دور غير صالح" };

  const counts = playerCounts(room);
  // اسمح بمرشد واحد فقط لكل فريق (باستثناء تغيير اللاعب لنفس مكانه)
  const isChangingAway = player.team === team && player.role === "spymaster" && role === "spymaster";
  if (role === "spymaster" && counts[team].spymaster >= 1 && !isChangingAway) {
    return { error: "هذا الفريق لديه مرشد بالفعل" };
  }

  player.team = team;
  player.role = role;
  addLog(room, `${player.name} انضم كـ ${role === "spymaster" ? "مرشد" : "لاعب"} لفريق ${team === "red" ? "الأحمر" : "الأزرق"}`);
  return { ok: true };
}

function canStart(room) {
  const counts = playerCounts(room);
  return (
    counts.red.spymaster === 1 &&
    counts.blue.spymaster === 1 &&
    counts.red.operative >= 1 &&
    counts.blue.operative >= 1
  );
}

function startGame(room) {
  if (!canStart(room)) {
    return { error: "يجب أن يكون لكل فريق مرشد واحد ولاعب واحد على الأقل" };
  }
  const { board, startingTeam } = buildBoard();
  room.board = board;
  room.startingTeam = startingTeam;
  room.turn = startingTeam;
  room.turnPhase = "clue";
  room.currentClue = null;
  room.winner = null;
  room.phase = "playing";
  room.scores = {
    red: board.filter((c) => c.color === "red").length,
    blue: board.filter((c) => c.color === "blue").length,
  };
  addLog(room, `بدأت اللعبة! فريق ${startingTeam === "red" ? "الأحمر" : "الأزرق"} يبدأ أولًا`);
  return { ok: true };
}

function giveClue(room, socketId, word, count) {
  const player = room.players[socketId];
  if (!player) return { error: "لاعب غير موجود" };
  if (room.phase !== "playing") return { error: "اللعبة لم تبدأ" };
  if (player.team !== room.turn || player.role !== "spymaster") {
    return { error: "ليس دورك لإعطاء تلميح" };
  }
  if (room.turnPhase !== "clue") return { error: "لا يمكن إعطاء تلميح الآن" };
  if (!word || typeof count !== "number" || count < 0 || count > 9) {
    return { error: "تلميح غير صالح" };
  }

  room.currentClue = { word, count, guessesLeft: count + 1 };
  room.turnPhase = "guess";
  addLog(room, `مرشد فريق ${room.turn === "red" ? "الأحمر" : "الأزرق"} أعطى تلميح: "${word}" (${count})`);
  return { ok: true };
}

function endTurn(room, socketId) {
  const player = room.players[socketId];
  if (!player) return { error: "لاعب غير موجود" };
  if (room.phase !== "playing") return { error: "اللعبة لم تبدأ" };
  if (player.team !== room.turn) return { error: "ليس دورك" };

  room.turn = room.turn === "red" ? "blue" : "red";
  room.turnPhase = "clue";
  room.currentClue = null;
  addLog(room, `انتهى الدور. الآن دور فريق ${room.turn === "red" ? "الأحمر" : "الأزرق"}`);
  return { ok: true };
}

// هذه هي العملية الحرجة: كشف كلمة. لأنها متزامنة بالكامل (لا await بداخلها)
// فإن أي طلبين يصلان "في نفس اللحظة" من عميلين مختلفين سيُعالَجان بالتتابع
// الصارم من طرف Node.js event loop، فلا يمكن أبدًا أن تُكشف نفس الكلمة مرتين
// أو أن تتضارب النتيجة.
function revealWord(room, socketId, index) {
  const player = room.players[socketId];
  if (!player) return { error: "لاعب غير موجود" };
  if (room.phase !== "playing") return { error: "اللعبة لم تبدأ" };
  if (player.team !== room.turn || player.role !== "operative") {
    return { error: "ليس دورك للكشف" };
  }
  if (room.turnPhase !== "guess") return { error: "لا يوجد تلميح حاليًا" };
  const cell = room.board[index];
  if (!cell) return { error: "خلية غير صالحة" };
  if (cell.revealed) return { error: "هذه الكلمة مكشوفة بالفعل" };

  cell.revealed = true;
  addLog(room, `${player.name} كشف كلمة "${cell.word}"`);

  if (cell.color === "assassin") {
    room.phase = "ended";
    room.winner = room.turn === "red" ? "blue" : "red";
    addLog(room, `كلمة الاغتيال! فريق ${room.turn === "red" ? "الأحمر" : "الأزرق"} خسر فورًا`);
    return { ok: true, revealedColor: cell.color };
  }

  if (cell.color === room.turn) {
    room.scores[room.turn]--;
    room.currentClue.guessesLeft--;
    if (checkWin(room)) return { ok: true, revealedColor: cell.color };
    if (room.currentClue.guessesLeft <= 0) {
      endTurn(room, socketId);
    }
    return { ok: true, revealedColor: cell.color };
  }

  // لون محايد أو لون الفريق الآخر -> ينهي الدور فورًا
  if (cell.color !== "neutral") {
    room.scores[cell.color]--;
    checkWin(room);
  }
  if (room.phase === "playing") endTurn(room, socketId);
  return { ok: true, revealedColor: cell.color };
}

function checkWin(room) {
  if (room.scores.red <= 0) {
    room.phase = "ended";
    room.winner = "red";
    addLog(room, "فريق الأحمر كشف كل كلماته وفاز!");
    return true;
  }
  if (room.scores.blue <= 0) {
    room.phase = "ended";
    room.winner = "blue";
    addLog(room, "فريق الأزرق كشف كل كلماته وفاز!");
    return true;
  }
  return false;
}

function addChat(room, socketId, text) {
  const player = room.players[socketId];
  if (!player || !text || !text.trim()) return;
  room.chat.push({ name: player.name, team: player.team, text: text.slice(0, 300), ts: Date.now() });
  if (room.chat.length > 300) room.chat.shift();
}

// يبني نسخة من الحالة مخصّصة لكل لاعب حسب دوره - هذا هو ضمان عدم
// تسرّب ألوان الكلمات: الخادم لا يرسل بيانات الألوان غير المكشوفة
// إطلاقًا لأي عميل ليس "مرشدًا"، بدل الاعتماد على إخفائها بصريًا فقط.
function getViewForSocket(room, socketId) {
  const me = room.players[socketId] || {};
  const isSpymaster = me.role === "spymaster";

  const board = room.board.map((cell) => {
    if (cell.revealed || isSpymaster) {
      return { word: cell.word, color: cell.color, revealed: cell.revealed };
    }
    return { word: cell.word, color: null, revealed: false };
  });

  return {
    id: room.id,
    phase: room.phase,
    players: Object.fromEntries(
      Object.entries(room.players).map(([id, p]) => [id, { name: p.name, team: p.team, role: p.role, connected: p.connected }])
    ),
    board,
    turn: room.turn,
    turnPhase: room.turnPhase,
    currentClue: room.currentClue,
    winner: room.winner,
    scores: room.scores,
    log: room.log.slice(-50),
    chat: room.chat.slice(-100),
    you: { id: socketId, team: me.team, role: me.role, name: me.name },
  };
}

module.exports = {
  createRoom,
  joinRoom,
  setTeamRole,
  canStart,
  startGame,
  giveClue,
  endTurn,
  revealWord,
  addChat,
  getViewForSocket,
  playerCounts,
};
