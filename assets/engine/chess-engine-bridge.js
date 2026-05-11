(() => {
  let engineWorker = null;
  let initialized = false;
  let readyPromise = null;

  function threadCount() {
    const hc = typeof navigator !== "undefined" && navigator.hardwareConcurrency;
    return Math.min(32, Math.max(1, hc || 8));
  }

  function hashMb() {
    try {
      const d = typeof navigator !== "undefined" ? navigator.deviceMemory : 0;
      if (d && d >= 8) return 1024;
      if (d && d >= 4) return 512;
    } catch (_) {}
    return 512;
  }

  function toFen(game) {
    const rows = [];
    for (let r = 0; r < 8; r++) {
      let line = "";
      let empty = 0;
      for (let c = 0; c < 8; c++) {
        const p = game.board[r][c];
        if (!p) {
          empty++;
          continue;
        }
        if (empty) {
          line += String(empty);
          empty = 0;
        }
        const ch = p.type;
        line += p.color === "w" ? ch.toUpperCase() : ch;
      }
      if (empty) line += String(empty);
      rows.push(line);
    }

    let cast = "";
    if (game.castling.wk) cast += "K";
    if (game.castling.wq) cast += "Q";
    if (game.castling.bk) cast += "k";
    if (game.castling.bq) cast += "q";
    if (!cast) cast = "-";

    const ep = game.ep ? `${"abcdefgh"[game.ep.c]}${8 - game.ep.r}` : "-";
    return `${rows.join("/")} ${game.turn} ${cast} ${ep} ${game.halfmove} ${game.fullmove}`;
  }

  function moveToUci(mv) {
    const from = `${"abcdefgh"[mv.from.c]}${8 - mv.from.r}`;
    const to = `${"abcdefgh"[mv.to.c]}${8 - mv.to.r}`;
    return `${from}${to}${mv.promo || ""}`;
  }

  /** UCI の score は「手番側」基準。白視点のセンチポーンに正規化 */
  function normalizeScoreWhitePov(turn, scoreCp, scoreMate) {
    if (scoreMate != null) {
      const m = scoreMate;
      if (turn === "w") return { kind: "mate", value: m };
      return { kind: "mate", value: -m };
    }
    if (scoreCp == null) return null;
    const cp = turn === "w" ? scoreCp : -scoreCp;
    return { kind: "cp", value: cp };
  }

  function parseMultipvPv(line) {
    const m = line.match(/\bmultipv\s+(\d+)/);
    if (!m) return null;
    const pvi = line.indexOf(" pv ");
    if (pvi === -1) return null;
    const first = line.slice(pvi + 4).trim().split(/\s+/)[0];
    if (!first || first.length < 4) return null;
    return { idx: parseInt(m[1], 10), uci: first };
  }

  /** 上位候補から確率的に選ぶ（人間の「迷い」） */
  function pickHumanUci(ucis, skill) {
    const list = ucis.filter(Boolean);
    if (list.length < 2) return list[0] || null;
    const s = Math.max(0, Math.min(20, skill));
    const w1 = 0.38 + s * 0.029;
    const r = Math.random();
    if (r < w1) return list[0];
    const w2 = (1 - w1) * 0.55;
    if (r < w1 + w2 && list.length >= 2) return list[1];
    return list[2] || list[1] || list[0];
  }

  function parseInfoLine(line, sideToMove) {
    if (!line.startsWith("info ")) return null;
    let depth;
    const dm = line.match(/\bdepth\s+(\d+)/);
    if (dm) depth = parseInt(dm[1], 10);

    let scoreCp;
    let scoreMate;
    const scp = line.match(/\bscore\s+cp\s+(-?\d+)/);
    const sm = line.match(/\bscore\s+mate\s+(-?\d+)/);
    if (sm) scoreMate = parseInt(sm[1], 10);
    else if (scp) scoreCp = parseInt(scp[1], 10);

    let pv = "";
    const pvi = line.indexOf(" pv ");
    if (pvi !== -1) pv = line.slice(pvi + 4).trim();

    const norm = normalizeScoreWhitePov(sideToMove, scoreMate != null ? null : scoreCp, scoreMate);
    return { depth, scoreCp, scoreMate, pv, normalized: norm };
  }

  /**
   * movetime は主に Skill Level で決め、強さと整合させる。
   * 持ち時間はごく小さな上乗せのみ（偏りすぎない）。
   */
  function computeMovetimeMs(game, skill) {
    const s = Math.max(0, Math.min(20, Math.round(skill)));
    const minMs = 260 + s * 22;
    const ceiling = Math.min(9200, 480 + s * 460);
    const spread = 200 + s * 360;
    const hi = Math.min(ceiling, minMs + spread);
    let mt = minMs + Math.random() * (hi - minMs);

    if (!game || game.unlimitedTime) {
      mt += Math.random() * 240;
      return Math.max(260, Math.min(ceiling, Math.round(mt)));
    }

    const b = Math.max(0, game.timeLeft?.b ?? 0);
    if (b < 6000) {
      mt = Math.min(mt, minMs + 380 + Math.random() * 320);
    } else {
      mt += Math.min(420, b * (0.0005 + Math.random() * 0.001));
    }

    return Math.max(260, Math.min(ceiling, Math.round(mt)));
  }

  function configureEngineBase() {
    if (!engineWorker) return;
    const t = threadCount();
    const h = hashMb();
    engineWorker.postMessage(`setoption name Threads value ${t}`);
    engineWorker.postMessage(`setoption name Hash value ${h}`);
    engineWorker.postMessage("setoption name MultiPV value 1");
    engineWorker.postMessage("setoption name UCI_LimitStrength value false");
    engineWorker.postMessage("setoption name Slow Mover value 100");
    engineWorker.postMessage("setoption name Contempt value 0");
    engineWorker.postMessage("setoption name Move Overhead value 30");
  }

  function ensureEngine() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
      try {
        engineWorker = new Worker("./assets/engine/stockfish.js");
      } catch (e) {
        reject(e);
        return;
      }

      const timer = setTimeout(() => reject(new Error("Stockfish初期化タイムアウト")), 45000);
      const onMessage = (ev) => {
        const line = String(ev.data || "").trim();
        if (line === "uciok") {
          configureEngineBase();
          engineWorker.postMessage("isready");
          return;
        }
        if (line === "readyok") {
          clearTimeout(timer);
          initialized = true;
          resolve();
        }
      };

      engineWorker.addEventListener("message", onMessage);
      engineWorker.postMessage("uci");
    });
    return readyPromise;
  }

  /**
   * @param {object} game
   * @param {Array} legalMoves
   * @param {{ skillLevel?: number, onInfo?: function }} [options]
   * skillLevel: 0（弱）〜20（強）。movetime は主にこれに連動。
   */
  async function pickMove(game, legalMoves, options = {}) {
    await ensureEngine();
    if (!initialized || !engineWorker) throw new Error("Stockfish未初期化");

    const skill = Math.max(0, Math.min(20, Math.round(Number(options.skillLevel ?? 12))));
    const movetimeMs = computeMovetimeMs(game, skill);
    const onInfo = typeof options.onInfo === "function" ? options.onInfo : null;
    const fen = toFen(game);
    const sideToMove = game.turn;
    const legalMap = new Map(legalMoves.map((m) => [moveToUci(m), m]));
    const waitMs = movetimeMs + 35000;

    return await new Promise((resolve, reject) => {
      let best = null;
      const multipvMoves = new Map();
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("bestmove待機タイムアウト"));
      }, waitMs);

      const onMessage = (ev) => {
        const line = String(ev.data || "").trim();
        if (line.startsWith("info ")) {
          const mp = parseMultipvPv(line);
          if (mp) multipvMoves.set(mp.idx, mp.uci);
          if (onInfo) {
            const parsed = parseInfoLine(line, sideToMove);
            if (parsed) onInfo(parsed);
          }
          return;
        }
        if (!line.startsWith("bestmove ")) return;
        const m = line.match(/^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
        best = m ? m[1] : null;
        cleanup();
        if (!best) {
          reject(new Error("engine bestmove"));
          return;
        }
        let chosen = best;
        if (multipvMoves.size >= 2) {
          const u1 = multipvMoves.get(1) || best;
          const u2 = multipvMoves.get(2);
          const u3 = multipvMoves.get(3);
          const list = [u1, u2, u3].filter(Boolean);
          if (list.length >= 2) chosen = pickHumanUci(list, skill);
        }
        if (!legalMap.has(chosen)) chosen = best;
        if (legalMap.has(chosen)) resolve(legalMap.get(chosen));
        else reject(new Error("エンジン手を合法手へ変換できません"));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        engineWorker.removeEventListener("message", onMessage);
        engineWorker.postMessage("setoption name MultiPV value 1");
      };

      engineWorker.addEventListener("message", onMessage);
      engineWorker.postMessage(`setoption name Skill Level value ${skill}`);
      engineWorker.postMessage("setoption name MultiPV value 3");
      engineWorker.postMessage("ucinewgame");
      engineWorker.postMessage(`position fen ${fen}`);
      engineWorker.postMessage(`go movetime ${movetimeMs}`);
    });
  }

  window.__engineAvailable = () => !!window.Worker;
  window.__enginePickMove = pickMove;
  window.__engineInit = ensureEngine;
})();
