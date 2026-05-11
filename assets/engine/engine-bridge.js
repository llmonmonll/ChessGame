/**
 * YaneuraOu.wasm (USI) ブリッジ — GPL-3.0（同梱の Copying.txt 参照）
 * SharedArrayBuffer には COOP/COEP が必要。ローカルは serve.py を使用。
 */
(function () {
  const HAND_TYPES = ["R", "B", "G", "S", "N", "L", "P"];
  const BASE_CHAR = { K: "K", R: "R", B: "B", G: "G", S: "S", N: "N", L: "L", P: "P" };
  const PROMOTED_BASE = { PR: "R", PB: "B", PS: "S", PN: "N", PL: "L", PP: "P" };

  function pieceToSfen(p) {
    if (PROMOTED_BASE[p.type]) {
      const letter = BASE_CHAR[PROMOTED_BASE[p.type]];
      const s = "+" + letter;
      return p.side === "sente" ? s : "+" + letter.toLowerCase();
    }
    const ch = BASE_CHAR[p.type];
    return p.side === "sente" ? ch : ch.toLowerCase();
  }

  function rowSfen(g, r) {
    let out = "";
    let empty = 0;
    const flush = () => {
      if (empty) {
        out += String(empty);
        empty = 0;
      }
    };
    for (let c = 0; c < 9; c += 1) {
      const p = g.board[r][c];
      if (!p) empty += 1;
      else {
        flush();
        out += pieceToSfen(p);
      }
    }
    flush();
    return out;
  }

  function handsSfen(g) {
    let s = "";
    for (const t of HAND_TYPES) {
      const n = g.hands.sente[t];
      if (n) s += n === 1 ? t : `${n}${t}`;
    }
    for (const t of HAND_TYPES) {
      const n = g.hands.gote[t];
      const low = t.toLowerCase();
      if (n) s += n === 1 ? low : `${n}${low}`;
    }
    return s || "-";
  }

  function gameToSfenString(g) {
    const rows = [];
    for (let r = 0; r < 9; r += 1) rows.push(rowSfen(g, r));
    const board = rows.join("/");
    const side = g.turn === "sente" ? "b" : "w";
    const hands = handsSfen(g);
    const ply = Math.max(1, g.log.length + 1);
    return `${board} ${side} ${hands} ${ply}`;
  }

  function usiSquareToRc(sq) {
    const file = parseInt(sq[0], 10);
    const rank = sq.charCodeAt(1) - "a".charCodeAt(0);
    return { r: rank, c: 9 - file };
  }

  function matchUsiToLegal(usi, legalList) {
    let u = usi.trim();
    if (u === "resign" || u === "win" || u === "lose") return null;
    let promote = false;
    if (u.endsWith("+")) {
      promote = true;
      u = u.slice(0, -1);
    }
    if (u.includes("*")) {
      const pt = u[0];
      const sq = u.slice(2);
      const { r, c } = usiSquareToRc(sq);
      const map = { P: "P", L: "L", N: "N", S: "S", B: "B", R: "R", G: "G" };
      const t = map[pt];
      return legalList.find(
        (m) => m.kind === "drop" && m.pieceType === t && m.toR === r && m.toC === c
      );
    }
    if (u.length < 4) return null;
    const from = u.slice(0, 2);
    const to = u.slice(2, 4);
    const a = usiSquareToRc(from);
    const b = usiSquareToRc(to);
    return legalList.find(
      (m) =>
        m.kind === "move" &&
        m.fromR === a.r &&
        m.fromC === a.c &&
        m.toR === b.r &&
        m.toC === b.c &&
        !!m.promote === promote
    );
  }

  let engineModule = null;
  let initPromise = null;

  async function ensureEngine() {
    if (engineModule) return engineModule;
    if (typeof YaneuraOu === "undefined") throw new Error("YaneuraOu 未読込");
    if (typeof SharedArrayBuffer === "undefined") throw new Error("SharedArrayBuffer 不可");
    if (!initPromise) {
      initPromise = (async () => {
        const yn = await YaneuraOu;
        await new Promise((resolve, reject) => {
          let phase = 0;
          let listener;
          const timer = setTimeout(() => {
            if (listener) yn.removeMessageListener(listener);
            reject(new Error("USI 初期化タイムアウト"));
          }, 45000);
          listener = (line) => {
            const t = line.trim();
            if (phase === 0 && t === "usiok") {
              phase = 1;
              yn.postMessage("setoption name USI_Ponder value false");
              yn.postMessage("setoption name USI_OwnBook value false");
              yn.postMessage("setoption name USI_Hash value 256");
              const th = Math.min(8, Math.max(1, navigator.hardwareConcurrency || 4));
              yn.postMessage(`setoption name Threads value ${th}`);
              yn.postMessage("isready");
            } else if (phase === 1 && t === "readyok") {
              clearTimeout(timer);
              yn.removeMessageListener(listener);
              resolve();
            }
          };
          yn.addMessageListener(listener);
          yn.postMessage("usi");
        });
        return yn;
      })();
    }
    try {
      const yn = await initPromise;
      engineModule = yn;
      return yn;
    } catch (e) {
      initPromise = null;
      engineModule = null;
      throw e;
    }
  }

  window.__enginePickMove = async function (game, legalGote) {
    if (!legalGote.length) return null;
    const yn = await ensureEngine();
    const sfen = gameToSfenString(game);
    const cmd = `position sfen ${sfen}`;
    let bestLine = null;
    const listener = (line) => {
      if (line.startsWith("bestmove")) bestLine = line;
    };
    yn.addMessageListener(listener);
    try {
      yn.postMessage(cmd);
      yn.postMessage("go movetime 2000");
      await new Promise((resolve, reject) => {
        const t0 = Date.now();
        const poll = setInterval(() => {
          if (bestLine) {
            clearInterval(poll);
            resolve();
          } else if (Date.now() - t0 > 60000) {
            clearInterval(poll);
            reject(new Error("bestmove 待機タイムアウト"));
          }
        }, 20);
      });
    } finally {
      yn.removeMessageListener(listener);
    }
    const parts = bestLine.split(/\s+/);
    const bm = parts[1];
    if (!bm || bm === "resign") return null;
    const matched = matchUsiToLegal(bm, legalGote);
    return matched || null;
  };

  window.__engineAvailable = function () {
    return typeof SharedArrayBuffer !== "undefined" && typeof YaneuraOu !== "undefined";
  };
})();
