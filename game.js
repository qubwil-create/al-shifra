const socket = io();

let myName = "";
let currentRoomId = null;
let lastState = null;

const $ = (id) => document.getElementById(id);

function show(sectionId) {
  ["landing", "lobby", "game", "ended"].forEach((id) => {
    $(id).style.display = id === sectionId ? "flex" : "none";
  });
}

// ---------- شاشة البداية ----------
$("createBtn").onclick = () => {
  myName = $("createName").value.trim() || "لاعب";
  socket.emit("createRoom", { name: myName }, (res) => {
    if (res.error) return ($("landingError").textContent = res.error);
    currentRoomId = res.roomId;
  });
};

$("joinBtn").onclick = () => {
  myName = $("joinName").value.trim() || "لاعب";
  const roomId = $("joinRoomId").value.trim().toUpperCase();
  socket.emit("joinRoom", { roomId, name: myName }, (res) => {
    if (res.error) return ($("landingError").textContent = res.error);
    currentRoomId = res.roomId;
  });
};

// ---------- اختيار الفريق والدور ----------
document.querySelectorAll("#lobby .role-buttons button").forEach((btn) => {
  btn.onclick = () => {
    socket.emit(
      "setTeamRole",
      { team: btn.dataset.team, role: btn.dataset.role },
      (res) => {
        if (res.error) $("lobbyError").textContent = res.error;
      }
    );
  };
});

$("startBtn").onclick = () => {
  socket.emit("startGame", {}, (res) => {
    if (res.error) $("lobbyError").textContent = res.error;
  });
};

// ---------- التلميح والكشف ----------
$("giveClueBtn").onclick = () => {
  const word = $("clueWord").value.trim();
  const count = parseInt($("clueCount").value, 10);
  if (!word || isNaN(count)) return;
  socket.emit("giveClue", { word, count }, (res) => {
    if (!res.error) {
      $("clueWord").value = "";
      $("clueCount").value = "";
    }
  });
};

$("endTurnBtn").onclick = () => socket.emit("endTurn", {});

$("chatSendBtn").onclick = sendChat;
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});
function sendChat() {
  const text = $("chatInput").value.trim();
  if (!text) return;
  socket.emit("chatMessage", { text });
  $("chatInput").value = "";
}

// ---------- استقبال حالة الغرفة وإعادة الرسم ----------
socket.on("roomState", (state) => {
  lastState = state;
  $("roomBadge").style.display = "inline-block";
  $("roomBadge").textContent = state.id;

  if (state.phase === "lobby") renderLobby(state);
  else if (state.phase === "playing") renderGame(state);
  else if (state.phase === "ended") renderEnded(state);
});

function renderLobby(state) {
  show("lobby");
  const redList = $("redPlayers");
  const blueList = $("bluePlayers");
  redList.innerHTML = "";
  blueList.innerHTML = "";
  Object.values(state.players).forEach((p) => {
    if (p.team === "red") {
      redList.innerHTML += `<li>${p.name} ${p.role === "spymaster" ? "🕵️ مرشد" : "🎯 لاعب"}${p.connected ? "" : " (غير متصل)"}</li>`;
    } else if (p.team === "blue") {
      blueList.innerHTML += `<li>${p.name} ${p.role === "spymaster" ? "🕵️ مرشد" : "🎯 لاعب"}${p.connected ? "" : " (غير متصل)"}</li>`;
    }
  });
}

function renderGame(state) {
  show("game");
  const isMySpymasterTurn =
    state.you.role === "spymaster" && state.you.team === state.turn && state.turnPhase === "clue";
  const isMyOperativeTurn =
    state.you.role === "operative" && state.you.team === state.turn && state.turnPhase === "guess";

  $("turnIndicator").textContent = `دور فريق ${state.turn === "red" ? "الأحمر 🔴" : "الأزرق 🔵"} — ${
    state.turnPhase === "clue" ? "بانتظار التلميح" : "بانتظار التخمين"
  }`;
  $("scoreRed").textContent = state.scores.red;
  $("scoreBlue").textContent = state.scores.blue;

  if (state.currentClue) {
    $("clueBar").style.display = "block";
    $("clueBar").textContent = `التلميح: "${state.currentClue.word}" (${state.currentClue.count}) — تبقّى ${state.currentClue.guessesLeft} تخمين`;
  } else {
    $("clueBar").style.display = "none";
  }

  $("clueForm").style.display = isMySpymasterTurn ? "flex" : "none";
  $("endTurnBtn").style.display = isMyOperativeTurn ? "block" : "none";

  const board = $("board");
  board.innerHTML = "";
  state.board.forEach((cell, i) => {
    const div = document.createElement("div");
    div.className = "cell";
    div.textContent = cell.word;

    if (cell.revealed) {
      div.classList.add("revealed", `color-${cell.color}`);
    } else if (state.you.role === "spymaster" && cell.color) {
      // المرشد يرى تلميحًا بصريًا فقط لدوره، لا يكشف الكلمة فعليًا
      div.classList.add(`spy-hint-${cell.color === "neutral" ? "" : cell.color}`);
    }

    if (!cell.revealed && isMyOperativeTurn) {
      div.onclick = () => socket.emit("revealWord", { index: i }, () => {});
    }
    board.appendChild(div);
  });

  renderLog(state);
  renderChat(state);
}

function renderEnded(state) {
  show("ended");
  $("winnerText").textContent = `انتهت اللعبة! الفائز: فريق ${state.winner === "red" ? "الأحمر 🔴" : "الأزرق 🔵"}`;
  const board = $("finalBoard");
  board.innerHTML = "";
  state.board.forEach((cell) => {
    const div = document.createElement("div");
    div.className = `cell revealed color-${cell.color || "neutral"}`;
    div.textContent = cell.word;
    board.appendChild(div);
  });
}

function renderLog(state) {
  $("log").innerHTML = state.log.map((l) => `<div>${l.text}</div>`).join("");
  $("log").scrollTop = $("log").scrollHeight;
}

function renderChat(state) {
  $("chat").innerHTML = state.chat
    .map((c) => `<div><b style="color:${c.team === "red" ? "#ff6b6b" : c.team === "blue" ? "#6ba8ff" : "#aaa"}">${c.name}:</b> ${escapeHtml(c.text)}</div>`)
    .join("");
  $("chat").scrollTop = $("chat").scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
