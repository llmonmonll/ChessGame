(() => {
  const boardEl = document.getElementById("board");
  const statusEl = document.getElementById("status");
  const logEl = document.getElementById("log");
  const clockWhiteEl = document.getElementById("clockWhite");
  const clockBlackEl = document.getElementById("clockBlack");
  const newGameBtn = document.getElementById("newGameBtn");
  const undoBtn = document.getElementById("undoBtn");
  const resetGameBtn = document.getElementById("resetGameBtn");
  const exitBtn = document.getElementById("exitBtn");
  const copyPgnBtn = document.getElementById("copyPgnBtn");
  const engineBadge = document.getElementById("engineBadge");
  const materialDiffEl = document.getElementById("materialDiff");
  const timePreset = document.getElementById("timePreset");
  const incrementPreset = document.getElementById("incrementPreset");
  const engineDifficulty = document.getElementById("engineDifficulty");
  const engineDifficultyLabel = document.getElementById("engineDifficultyLabel");
  const promoModal = document.getElementById("promoModal");
  const promoCancel = document.getElementById("promoCancel");
  const lobbyOverlay = document.getElementById("lobbyOverlay");
  const turnBanner = document.getElementById("turnBanner");
  const turnBadge = document.getElementById("turnBadge");
  const turnTitle = document.getElementById("turnTitle");
  const turnHint = document.getElementById("turnHint");
  const clockRowWhite = document.getElementById("clockRowWhite");
  const clockRowBlack = document.getElementById("clockRowBlack");
  const checkToastEl = document.getElementById("checkToast");
  const checkToastHint = document.getElementById("checkToastHint");

  const FILES = "abcdefgh";
  const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  const LOW_TIME_MS = 30 * 1000;

  let game = null;
  let selected = null;
  let legalForSelected = [];
  let cpuBusy = false;
  let mateEffectPlayed = false;
  let lastClockTs = performance.now();
  let pendingPromo = null;
  /** @type {{ mv: object, san: string, timeLeftAfter: { w: number, b: number } }[]} */
  let plies = [];
  let checkToastHideTimer = null;

  function hideCheckToast(immediate) {
    if (!checkToastEl) return;
    clearTimeout(checkToastHideTimer);
    checkToastEl.classList.remove("check-toast--visible");
    if (immediate) {
      checkToastEl.hidden = true;
      return;
    }
    checkToastHideTimer = setTimeout(() => {
      checkToastEl.hidden = true;
    }, 320);
  }

  /** 対局中かつ詰みでない王手のとき、盤上にトーストを出す */
  function showCheckToastIfNeeded() {
    if (!game || game.result || !checkToastEl) return;
    const m = legalMoves(game);
    if (!m.length) return;
    if (!isInCheck(game, game.turn)) return;
    clearTimeout(checkToastHideTimer);
    if (checkToastHint) {
      checkToastHint.textContent =
        game.turn === "w"
          ? "白のキングが攻撃されています"
          : "黒のキングが攻撃されています";
    }
    checkToastEl.hidden = false;
    checkToastEl.classList.remove("check-toast--visible");
    void checkToastEl.offsetWidth;
    requestAnimationFrame(() => checkToastEl.classList.add("check-toast--visible"));
    checkToastHideTimer = setTimeout(() => hideCheckToast(false), 2600);
  }

  function getEngineDifficulty() {
    const v = parseInt(engineDifficulty?.value ?? "12", 10);
    if (Number.isNaN(v)) return 12;
    return Math.max(0, Math.min(20, v));
  }

  window.__getCpuHumanizeChance = () => {
    const d = getEngineDifficulty();
    return 0.05 + (20 - d) * 0.015;
  };

  function difficultyTierLabel(lv) {
    if (lv <= 4) return "やさしい";
    if (lv <= 8) return "かんたん";
    if (lv <= 13) return "ふつう";
    if (lv <= 17) return "むずかしい";
    return "かなり強い";
  }

  function syncDifficultyLabel() {
    if (!engineDifficultyLabel || !engineDifficulty) return;
    const lv = getEngineDifficulty();
    engineDifficultyLabel.textContent = `Lv ${lv}（${difficultyTierLabel(lv)}）`;
  }

  /** 内蔵フォールバック：難易度が主、残り時間は軽いブレのみ */
  function getCpuFallbackOptions() {
    const d = getEngineDifficulty();
    const t = d / 20;
    const base = Math.round(100 + t * 480);
    let timeMs = base + Math.floor(Math.random() * (60 + d * 38));
    const nodeBudget = Math.round(70000 + t * 4920000);
    const maxDepth = 3 + Math.floor((d / 20) * 11);

    if (game && !game.unlimitedTime && game.timeLeft) {
      const b = Math.max(0, game.timeLeft.b);
      if (b < 6000) {
        timeMs = Math.min(timeMs, base + 180 + Math.floor(Math.random() * 200));
      } else {
        timeMs += Math.min(320, Math.floor(b * (0.0004 + Math.random() * 0.0008)));
      }
    } else if (game?.unlimitedTime) {
      timeMs += Math.floor(Math.random() * 350);
    }

    return { timeMs, nodeBudget, maxDepth };
  }

  if (typeof window !== "undefined") {
    window.__getCpuFallbackOptions = getCpuFallbackOptions;
  }

  function initialBoard() {
    const b = Array.from({ length: 8 }, () => Array(8).fill(null));
    const back = ["r", "n", "b", "q", "k", "b", "n", "r"];
    for (let c = 0; c < 8; c++) {
      b[0][c] = { color: "b", type: back[c] };
      b[1][c] = { color: "b", type: "p" };
      b[6][c] = { color: "w", type: "p" };
      b[7][c] = { color: "w", type: back[c] };
    }
    return b;
  }

  function readTimeSettings() {
    const presetSec = parseInt(timePreset?.value ?? "300", 10);
    const incSec = parseInt(incrementPreset?.value ?? "0", 10);
    const unlimited = presetSec === 0;
    const baseMs = unlimited ? 0 : presetSec * 1000;
    const incrementMs = unlimited ? 0 : incSec * 1000;
    return { unlimited, baseMs, incrementMs };
  }

  function freshGameFromSettings() {
    const { unlimited, baseMs, incrementMs } = readTimeSettings();
    return {
      board: initialBoard(),
      turn: "w",
      castling: { wk: true, wq: true, bk: true, bq: true },
      ep: null,
      halfmove: 0,
      fullmove: 1,
      result: null,
      logs: [],
      timeLeft: { w: unlimited ? 0 : baseMs, b: unlimited ? 0 : baseMs },
      unlimitedTime: unlimited,
      baseTimeMs: baseMs,
      incrementMs,
      lastMove: null,
    };
  }

  function newGame() {
    hideCheckToast(true);
    lastClockTs = performance.now();
    game = freshGameFromSettings();
    plies = [];
    selected = null;
    legalForSelected = [];
    cpuBusy = false;
    mateEffectPlayed = false;
    pendingPromo = null;
    closePromoModal();
    updateMaterialDiff();
    syncDifficultyLabel();
    render();
  }

  /** 「最初から」: 対局開始前の画面に戻る（メインボタンは「対局開始」） */
  function backToLobby() {
    hideCheckToast(true);
    lastClockTs = performance.now();
    game = null;
    plies = [];
    selected = null;
    legalForSelected = [];
    cpuBusy = false;
    mateEffectPlayed = false;
    pendingPromo = null;
    closePromoModal();
    updateMaterialDiff();
    syncDifficultyLabel();
    render();
  }

  function updateMaterialDiff() {
    if (!materialDiffEl) return;
    if (!game?.board) {
      materialDiffEl.textContent = "";
      materialDiffEl.classList.remove("material-diff--pos", "material-diff--neg");
      return;
    }
    let w = 0;
    let b = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = game.board[r][c];
      if (!p || p.type === "k") continue;
      const v = PIECE_VALUE[p.type];
      if (p.color === "w") w += v;
      else b += v;
    }
    const d = w - b;
    materialDiffEl.classList.remove("material-diff--pos", "material-diff--neg");
    const pawns = Math.abs(d) / 100;
    materialDiffEl.textContent =
      d === 0
        ? "駒の損得: 互角"
        : d > 0
          ? `駒の損得: 白 +${pawns.toFixed(1)}`
          : `駒の損得: 黒 +${pawns.toFixed(1)}`;
    if (d > 0) materialDiffEl.classList.add("material-diff--pos");
    else if (d < 0) materialDiffEl.classList.add("material-diff--neg");
  }

  function triggerMateEffect(winner) {
    boardEl.classList.remove("mate-effect", "mate-effect--white", "mate-effect--black");
    void boardEl.offsetWidth;
    boardEl.classList.add("mate-effect", winner === "w" ? "mate-effect--white" : "mate-effect--black");

    const wrap = document.createElement("div");
    wrap.className = `mate-particles mate-particles--${winner === "w" ? "white" : "black"}`;
    const colors =
      winner === "w"
        ? ["#ffd166", "#fff8e7", "#f4d03f", "#ffffff", "#ffeaa7", "#e8c547"]
        : ["#c0392b", "#e74c3c", "#ff6b6b", "#2c1818", "#9b59b6", "#f5b7b1"];
    for (let i = 0; i < 36; i++) {
      const p = document.createElement("span");
      p.className = "mate-particle";
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDelay = `${Math.random() * 220}ms`;
      p.style.transform = `translateY(0) rotate(${Math.floor(Math.random() * 360)}deg)`;
      wrap.appendChild(p);
    }
    document.body.appendChild(wrap);
    setTimeout(() => {
      boardEl.classList.remove("mate-effect", "mate-effect--white", "mate-effect--black");
      wrap.remove();
    }, 1400);
  }

  function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

  function pieceSvg(type, color) {
    const light = color === "w";
    const fillA = light ? "#f5f7ff" : "#4b556b";
    const fillB = light ? "#d9e0f7" : "#1f2937";
    const stroke = light ? "#8ea0c9" : "#0b1220";
    const gloss = light ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.15)";
    const base = (body) => `
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <linearGradient id="g-${color}-${type}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${fillA}" />
            <stop offset="100%" stop-color="${fillB}" />
          </linearGradient>
        </defs>
        ${body}
        <ellipse cx="50" cy="86" rx="26" ry="5.6" fill="rgba(0,0,0,0.2)" />
      </svg>
    `;
    if (type === "p") {
      return base(`
        <circle cx="50" cy="30" r="12" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
        <path d="M34 72c0-14 8-24 16-24s16 10 16 24" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="28" y="72" width="44" height="8" rx="3" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
        <ellipse cx="44" cy="26" rx="5" ry="3" fill="${gloss}"/>
      `);
    }
    if (type === "r") {
      return base(`
        <rect x="33" y="22" width="34" height="10" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="28" y="16" width="8" height="8" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2"/>
        <rect x="46" y="16" width="8" height="8" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2"/>
        <rect x="64" y="16" width="8" height="8" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2"/>
        <path d="M34 72V32h32v40" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="26" y="72" width="48" height="8" rx="3" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
      `);
    }
    if (type === "n") {
      return base(`
        <path d="M34 72c0-28 12-50 33-50 8 0 15 5 17 12-9-2-14 3-14 9 0 6 4 9 10 10-4 11-15 19-29 19h-4v8H34z"
          fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
        <circle cx="60" cy="36" r="2.3" fill="${stroke}"/>
        <rect x="26" y="72" width="48" height="8" rx="3" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
      `);
    }
    if (type === "b") {
      return base(`
        <path d="M50 20c9 0 14 7 14 14 0 6-3 11-8 14l5 24H39l5-24c-5-3-8-8-8-14 0-7 5-14 14-14z"
          fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
        <path d="M44 44l12-12" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round"/>
        <rect x="26" y="72" width="48" height="8" rx="3" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
      `);
    }
    if (type === "q") {
      return base(`
        <circle cx="34" cy="24" r="5" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2"/>
        <circle cx="50" cy="20" r="5" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2"/>
        <circle cx="66" cy="24" r="5" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2"/>
        <path d="M30 70l6-38 14 14 14-14 6 38z" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="26" y="70" width="48" height="10" rx="3" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
      `);
    }
    return base(`
      <rect x="46" y="14" width="8" height="14" rx="1.5" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2"/>
      <rect x="40" y="20" width="20" height="7" rx="1.5" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2"/>
      <path d="M36 72c0-21 5-40 14-40s14 19 14 40" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
      <rect x="26" y="72" width="48" height="8" rx="3" fill="url(#g-${color}-${type})" stroke="${stroke}" stroke-width="2.2"/>
    `);
  }

  function clonePos(pos) {
    return {
      board: pos.board.map((row) => row.map((p) => (p ? { ...p } : null))),
      turn: pos.turn,
      castling: { ...pos.castling },
      ep: pos.ep ? { ...pos.ep } : null,
      halfmove: pos.halfmove,
      fullmove: pos.fullmove,
      result: pos.result,
      logs: [...pos.logs],
      timeLeft: pos.timeLeft ? { ...pos.timeLeft } : { w: 0, b: 0 },
      unlimitedTime: pos.unlimitedTime,
      baseTimeMs: pos.baseTimeMs,
      incrementMs: pos.incrementMs,
      lastMove: pos.lastMove ? { from: { ...pos.lastMove.from }, to: { ...pos.lastMove.to } } : null,
    };
  }

  function formatClockFromMs(ms) {
    const t = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(t / 60);
    const s = t % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function formatClock(ms) {
    if (game?.unlimitedTime) return "∞";
    return formatClockFromMs(ms);
  }

  function updateClockPreview() {
    if (!clockWhiteEl || !clockBlackEl) return;
    const { unlimited, baseMs } = readTimeSettings();
    if (unlimited) {
      clockWhiteEl.textContent = "∞";
      clockBlackEl.textContent = "∞";
    } else {
      const txt = formatClockFromMs(baseMs);
      clockWhiteEl.textContent = txt;
      clockBlackEl.textContent = txt;
    }
    clockWhiteEl.classList.remove("active", "low");
    clockBlackEl.classList.remove("active", "low");
    clockRowWhite?.classList.remove("clock-row--active");
    clockRowBlack?.classList.remove("clock-row--active");
  }

  function syncTurnBanner() {
    if (!turnBanner || !turnBadge || !turnTitle || !turnHint) return;
    turnBanner.classList.remove(
      "turn-banner--idle",
      "turn-banner--white",
      "turn-banner--black",
      "turn-banner--thinking",
      "turn-banner--result",
    );
    if (!game) {
      turnBanner.classList.add("turn-banner--idle");
      turnBadge.textContent = "待機";
      turnTitle.textContent = "対局開始前";
      turnHint.textContent = "「対局開始」で白から始まります";
      return;
    }
    if (game.result) {
      turnBanner.classList.add("turn-banner--result");
      turnBadge.textContent = "終了";
      turnTitle.textContent = game.result;
      turnHint.textContent = "";
      return;
    }
    if (cpuBusy) {
      turnBanner.classList.add("turn-banner--black", "turn-banner--thinking");
      turnBadge.textContent = "黒";
      turnTitle.textContent = "CPU（黒）が思考中";
      turnHint.textContent = "この間は盤を操作できません";
      return;
    }
    if (game.turn === "w") {
      turnBanner.classList.add("turn-banner--white");
      turnBadge.textContent = "白";
      turnTitle.textContent = "あなたの手番（白）";
      turnHint.textContent = "動かす駒と行き先を選んでください";
      return;
    }
    turnBanner.classList.add("turn-banner--black");
    turnBadge.textContent = "黒";
    turnTitle.textContent = "CPU（黒）の手番";
    turnHint.textContent = "まもなく指します…";
  }

  function updateClockView() {
    if (!clockWhiteEl || !clockBlackEl) return;
    if (!game) {
      updateClockPreview();
      return;
    }
    if (!game.timeLeft) return;
    clockWhiteEl.textContent = formatClock(game.timeLeft.w);
    clockBlackEl.textContent = formatClock(game.timeLeft.b);
    clockWhiteEl.classList.toggle("active", !game.result && game.turn === "w");
    clockBlackEl.classList.toggle("active", !game.result && game.turn === "b");
    const unlim = game.unlimitedTime;
    clockWhiteEl.classList.toggle("low", !unlim && game.timeLeft.w <= LOW_TIME_MS);
    clockBlackEl.classList.toggle("low", !unlim && game.timeLeft.b <= LOW_TIME_MS);
    clockRowWhite?.classList.toggle("clock-row--active", !game.result && game.turn === "w");
    clockRowBlack?.classList.toggle("clock-row--active", !game.result && game.turn === "b");
  }

  function tickClock() {
    if (!game || game.unlimitedTime) return;
    const now = performance.now();
    const elapsed = now - lastClockTs;
    lastClockTs = now;
    if (game.result || elapsed <= 0) return;
    game.timeLeft[game.turn] -= elapsed;
    if (game.timeLeft[game.turn] <= 0) {
      game.timeLeft[game.turn] = 0;
      const side = game.turn;
      const winner = side === "w" ? "b" : "w";
      if (hasSufficientMatingMaterial(game, winner)) {
        game.result = side === "w" ? "時間切れ: CPU(黒)の勝ち" : "時間切れ: あなた(白)の勝ち";
      } else {
        game.result = "時間切れ救済: 相手に詰み筋がなく引き分け";
      }
      selected = null;
      legalForSelected = [];
      cpuBusy = false;
    }
    updateClockView();
    if (game.result) render();
  }

  function sq(r, c) { return `${FILES[c]}${8 - r}`; }

  function findKing(pos, color) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = pos.board[r][c];
      if (p && p.color === color && p.type === "k") return { r, c };
    }
    return null;
  }

  function isSquareAttacked(pos, tr, tc, byColor) {
    const b = pos.board;
    const pawnDir = byColor === "w" ? -1 : 1;
    for (const dc of [-1, 1]) {
      const r = tr - pawnDir;
      const c = tc - dc;
      if (inBounds(r, c) && b[r][c] && b[r][c].color === byColor && b[r][c].type === "p") return true;
    }
    const knights = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    for (const [dr, dc] of knights) {
      const r = tr + dr; const c = tc + dc;
      if (inBounds(r, c) && b[r][c] && b[r][c].color === byColor && b[r][c].type === "n") return true;
    }
    const lines = [
      [-1, 0], [1, 0], [0, -1], [0, 1],
      [-1, -1], [-1, 1], [1, -1], [1, 1],
    ];
    for (let i = 0; i < lines.length; i++) {
      const [dr, dc] = lines[i];
      let r = tr + dr; let c = tc + dc; let dist = 1;
      while (inBounds(r, c)) {
        const p = b[r][c];
        if (p) {
          if (p.color === byColor) {
            if (dist === 1 && p.type === "k") return true;
            if (i < 4 && (p.type === "r" || p.type === "q")) return true;
            if (i >= 4 && (p.type === "b" || p.type === "q")) return true;
          }
          break;
        }
        r += dr; c += dc; dist++;
      }
    }
    return false;
  }

  function isInCheck(pos, color) {
    const k = findKing(pos, color);
    if (!k) return false;
    return isSquareAttacked(pos, k.r, k.c, color === "w" ? "b" : "w");
  }

  function hasSufficientMatingMaterial(pos, color) {
    let bishops = 0;
    let knights = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = pos.board[r][c];
      if (!p || p.color !== color) continue;
      if (p.type === "q" || p.type === "r" || p.type === "p") return true;
      if (p.type === "b") bishops++;
      if (p.type === "n") knights++;
    }
    if (bishops >= 2) return true;
    if (bishops >= 1 && knights >= 1) return true;
    return false;
  }

  function pseudoMoves(pos, r, c) {
    const b = pos.board;
    const p = b[r][c];
    if (!p || p.color !== pos.turn) return [];
    const moves = [];
    const push = (toR, toC, opt = {}) => moves.push({ from: { r, c }, to: { r: toR, c: toC }, ...opt });

    if (p.type === "p") {
      const dir = p.color === "w" ? -1 : 1;
      const start = p.color === "w" ? 6 : 1;
      const promoRow = p.color === "w" ? 0 : 7;
      const nr = r + dir;
      if (inBounds(nr, c) && !b[nr][c]) {
        if (nr === promoRow) ["q", "r", "b", "n"].forEach((pr) => push(nr, c, { promo: pr }));
        else push(nr, c);
        if (r === start && !b[r + dir * 2][c]) push(r + dir * 2, c, { epSet: { r: r + dir, c } });
      }
      for (const dc of [-1, 1]) {
        const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const t = b[nr][nc];
        if (t && t.color !== p.color) {
          if (nr === promoRow) ["q", "r", "b", "n"].forEach((pr) => push(nr, nc, { promo: pr, capture: true }));
          else push(nr, nc, { capture: true });
        }
      }
      if (pos.ep) {
        const er = pos.ep.r; const ec = pos.ep.c;
        if (nr === er && Math.abs(ec - c) === 1) push(er, ec, { epCapture: { r, c: ec }, capture: true });
      }
    } else if (p.type === "n") {
      const ks = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
      for (const [dr, dc] of ks) {
        const nr = r + dr; const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const t = b[nr][nc];
        if (!t || t.color !== p.color) push(nr, nc, { capture: !!t });
      }
    } else if (p.type === "b" || p.type === "r" || p.type === "q") {
      const dirs = [];
      if (p.type !== "b") dirs.push([-1, 0], [1, 0], [0, -1], [0, 1]);
      if (p.type !== "r") dirs.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
      for (const [dr, dc] of dirs) {
        let nr = r + dr; let nc = c + dc;
        while (inBounds(nr, nc)) {
          const t = b[nr][nc];
          if (!t) push(nr, nc);
          else {
            if (t.color !== p.color) push(nr, nc, { capture: true });
            break;
          }
          nr += dr; nc += dc;
        }
      }
    } else if (p.type === "k") {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr; const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const t = b[nr][nc];
        if (!t || t.color !== p.color) push(nr, nc, { capture: !!t });
      }
      if (p.color === "w" && r === 7 && c === 4) {
        if (pos.castling.wk && !b[7][5] && !b[7][6]) push(7, 6, { castle: "wk" });
        if (pos.castling.wq && !b[7][3] && !b[7][2] && !b[7][1]) push(7, 2, { castle: "wq" });
      } else if (p.color === "b" && r === 0 && c === 4) {
        if (pos.castling.bk && !b[0][5] && !b[0][6]) push(0, 6, { castle: "bk" });
        if (pos.castling.bq && !b[0][3] && !b[0][2] && !b[0][1]) push(0, 2, { castle: "bq" });
      }
    }
    return moves;
  }

  function applyMove(pos, mv) {
    const n = clonePos(pos);
    const b = n.board;
    const piece = b[mv.from.r][mv.from.c];
    const target = b[mv.to.r][mv.to.c];
    b[mv.from.r][mv.from.c] = null;

    if (mv.epCapture) b[mv.epCapture.r][mv.epCapture.c] = null;
    if (mv.castle) {
      if (mv.castle === "wk") { b[7][5] = b[7][7]; b[7][7] = null; }
      if (mv.castle === "wq") { b[7][3] = b[7][0]; b[7][0] = null; }
      if (mv.castle === "bk") { b[0][5] = b[0][7]; b[0][7] = null; }
      if (mv.castle === "bq") { b[0][3] = b[0][0]; b[0][0] = null; }
    }

    b[mv.to.r][mv.to.c] = mv.promo ? { color: piece.color, type: mv.promo } : piece;

    if (piece.type === "k") {
      if (piece.color === "w") { n.castling.wk = false; n.castling.wq = false; }
      else { n.castling.bk = false; n.castling.bq = false; }
    }
    if (piece.type === "r") {
      if (mv.from.r === 7 && mv.from.c === 0) n.castling.wq = false;
      if (mv.from.r === 7 && mv.from.c === 7) n.castling.wk = false;
      if (mv.from.r === 0 && mv.from.c === 0) n.castling.bq = false;
      if (mv.from.r === 0 && mv.from.c === 7) n.castling.bk = false;
    }
    if (target && target.type === "r") {
      if (mv.to.r === 7 && mv.to.c === 0) n.castling.wq = false;
      if (mv.to.r === 7 && mv.to.c === 7) n.castling.wk = false;
      if (mv.to.r === 0 && mv.to.c === 0) n.castling.bq = false;
      if (mv.to.r === 0 && mv.to.c === 7) n.castling.bk = false;
    }

    n.ep = mv.epSet ? { ...mv.epSet } : null;
    n.halfmove = (piece.type === "p" || target || mv.epCapture) ? 0 : n.halfmove + 1;
    if (n.turn === "b") n.fullmove++;
    n.turn = n.turn === "w" ? "b" : "w";
    return n;
  }

  function cloneMv(mv) {
    const o = {
      from: { r: mv.from.r, c: mv.from.c },
      to: { r: mv.to.r, c: mv.to.c },
    };
    if (mv.promo) o.promo = mv.promo;
    if (mv.castle) o.castle = mv.castle;
    if (mv.capture) o.capture = mv.capture;
    if (mv.epCapture) o.epCapture = { r: mv.epCapture.r, c: mv.epCapture.c };
    if (mv.epSet) o.epSet = { r: mv.epSet.r, c: mv.epSet.c };
    return o;
  }

  function rebuildFromPlies(list) {
    mateEffectPlayed = false;
    if (!list.length) {
      game = freshGameFromSettings();
      lastClockTs = performance.now();
      finalizeState();
      return;
    }
    let g = freshGameFromSettings();
    for (let i = 0; i < list.length; i++) {
      const ply = list[i];
      const mover = g.turn;
      const mv = cloneMv(ply.mv);
      g = applyMove(g, mv);
      g.logs.push(ply.san);
      g.lastMove = { from: { ...mv.from }, to: { ...mv.to } };
      if (g.incrementMs > 0 && !g.unlimitedTime) {
        g.timeLeft[mover] += g.incrementMs;
      }
      g.timeLeft = { ...ply.timeLeftAfter };
    }
    game = g;
    lastClockTs = performance.now();
    finalizeState();
  }

  function legalMoves(pos) {
    const out = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = pos.board[r][c];
      if (!p || p.color !== pos.turn) continue;
      for (const mv of pseudoMoves(pos, r, c)) {
        if (mv.castle) {
          const enemy = p.color === "w" ? "b" : "w";
          if (isInCheck(pos, p.color)) continue;
          if (mv.castle[1] === "k") {
            const midC = 5; const endC = 6;
            if (isSquareAttacked(pos, r, midC, enemy) || isSquareAttacked(pos, r, endC, enemy)) continue;
          } else {
            const midC = 3; const endC = 2;
            if (isSquareAttacked(pos, r, midC, enemy) || isSquareAttacked(pos, r, endC, enemy)) continue;
          }
        }
        const n = applyMove(pos, mv);
        if (!isInCheck(n, pos.turn)) out.push(mv);
      }
    }
    return out;
  }

  const cpuFallbackPick =
    typeof window.__cpuFallbackFactory === "function"
      ? window.__cpuFallbackFactory({ legalMoves, applyMove, isInCheck }, {})
      : null;

  function fallbackCpuBestMove(pos) {
    if (cpuFallbackPick) {
      const mv = cpuFallbackPick(pos);
      if (mv) return mv;
    }
    const moves = legalMoves(pos);
    return moves.length ? moves[0] : null;
  }

  async function cpuBestMove(pos) {
    const moves = legalMoves(pos);
    if (!moves.length) return null;
    if (window.__enginePickMove) {
      try {
        const mv = await window.__enginePickMove(pos, moves, {
          skillLevel: getEngineDifficulty(),
        });
        if (mv) return mv;
      } catch (_) {
        /* エンジン失敗時は内蔵探索へ */
      }
    }
    return fallbackCpuBestMove(pos);
  }

  function toSAN(pos, mv) {
    const p = pos.board[mv.from.r][mv.from.c];
    if (mv.castle === "wk" || mv.castle === "bk") return "O-O";
    if (mv.castle === "wq" || mv.castle === "bq") return "O-O-O";
    const letter = p.type === "p" ? "" : p.type.toUpperCase();
    const cap = mv.capture || mv.epCapture ? "x" : "";
    const dst = sq(mv.to.r, mv.to.c);
    const promo = mv.promo ? `=${mv.promo.toUpperCase()}` : "";
    if (p.type === "p" && cap) return `${FILES[mv.from.c]}x${dst}${promo}`;
    return `${letter}${cap}${dst}${promo}`;
  }

  function pgnResultTag() {
    if (!game.result) return "*";
    if (game.result.includes("あなた(白)の勝ち")) return "1-0";
    if (game.result.includes("CPU(黒)の勝ち")) return "0-1";
    return "1/2-1/2";
  }

  function buildPgn() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
    const headers = [
      `[Event "Grandmaster Chess ブラウザ対局"]`,
      `[Site "Local"]`,
      `[Date "${date}"]`,
      `[White "Player"]`,
      `[Black "Stockfish"]`,
      `[Result "${pgnResultTag()}"]`,
      "",
    ];
    const moves = [];
    for (let i = 0; i < game.logs.length; i += 2) {
      const n = Math.floor(i / 2) + 1;
      const w = game.logs[i] || "";
      const b = game.logs[i + 1] || "";
      moves.push(b ? `${n}. ${w} ${b}` : `${n}. ${w}`);
    }
    const body = moves.join(" ");
    return `${headers.join("\n")}${body} ${pgnResultTag()}`.trim();
  }

  function finalizeState() {
    if (!game) return;
    const m = legalMoves(game);
    const inCheck = isInCheck(game, game.turn);
    if (m.length === 0) {
      game.result = inCheck
        ? (game.turn === "w" ? "チェックメイト: CPU(黒)の勝ち" : "チェックメイト: あなた(白)の勝ち")
        : "ステイルメイト: 引き分け";
      if (inCheck && !mateEffectPlayed) {
        mateEffectPlayed = true;
        const winner = game.turn === "w" ? "b" : "w";
        triggerMateEffect(winner);
      }
      return;
    }
    if (game.halfmove >= 100) {
      game.result = "50手ルール: 引き分け";
      return;
    }
    game.result = null;
  }

  function updateLog() {
    if (!game.logs.length) {
      logEl.textContent = "まだ指されていません。";
      return;
    }
    const lines = [];
    for (let i = 0; i < game.logs.length; i += 2) {
      const w = game.logs[i] || "";
      const b = game.logs[i + 1] || "";
      lines.push(`${Math.floor(i / 2) + 1}. ${w}${b ? ` ${b}` : ""}`.trim());
    }
    logEl.textContent = lines.join("\n");
  }

  function moveAndRecord(mv) {
    const san = toSAN(game, mv);
    const mover = game.turn;
    game = applyMove(game, mv);
    game.logs.push(san);
    game.lastMove = { from: { ...mv.from }, to: { ...mv.to } };
    if (game.incrementMs > 0 && !game.unlimitedTime) {
      game.timeLeft[mover] += game.incrementMs;
    }
    plies.push({
      mv: cloneMv(mv),
      san,
      timeLeftAfter: { w: game.timeLeft.w, b: game.timeLeft.b },
    });
    finalizeState();
    showCheckToastIfNeeded();
    selected = null;
    legalForSelected = [];
    updateMaterialDiff();
    render();
  }

  /**
   * プレイヤー（白）の直前の手を取り消す。
   * - 手番が黒 … 直前は白の手なので 1 手戻す
   * - 手番が白 … 直前は黒（CPU）なので、CPU の手とその前の白を 2 手まとめて戻す
   */
  function undoMove() {
    if (!game || cpuBusy || pendingPromo) return;
    if (!canUndoPlayerMove()) return;
    closePromoModal();
    if (game.turn === "b") {
      plies.pop();
    } else {
      plies.pop();
      plies.pop();
    }
    rebuildFromPlies(plies);
    selected = null;
    legalForSelected = [];
    cpuBusy = false;
    updateMaterialDiff();
    render();
    if (!game.result && game.turn === "b") scheduleCpu();
  }

  function canUndoPlayerMove() {
    if (!game || !plies.length) return false;
    if (game.turn === "b") return true;
    return plies.length >= 2;
  }

  function syncUndoResetButtons() {
    if (undoBtn) {
      undoBtn.disabled =
        !game || cpuBusy || !!pendingPromo || !canUndoPlayerMove();
    }
    if (resetGameBtn) {
      resetGameBtn.disabled = !game || cpuBusy || !!pendingPromo;
    }
  }

  function closePromoModal() {
    pendingPromo = null;
    if (promoModal) {
      promoModal.hidden = true;
      promoModal.setAttribute("aria-hidden", "true");
    }
  }

  function openPromoModal(candidates) {
    pendingPromo = candidates;
    if (promoModal) {
      promoModal.hidden = false;
      promoModal.setAttribute("aria-hidden", "false");
      const first = promoModal.querySelector(".promo-btn");
      first?.focus();
    }
  }

  function tryPlayMoves(candidates) {
    if (!candidates.length) return;
    if (candidates.length === 1) {
      moveAndRecord(candidates[0]);
      if (!game.result) scheduleCpu();
      return;
    }
    openPromoModal(candidates);
  }

  function handleClick(r, c) {
    if (!game || game.result || game.turn !== "w" || cpuBusy) return;
    const piece = game.board[r][c];

    if (selected) {
      const matches = legalForSelected.filter((m) => m.to.r === r && m.to.c === c);
      if (matches.length) {
        tryPlayMoves(matches);
        return;
      }
    }

    if (piece && piece.color === "w") {
      selected = { r, c };
      legalForSelected = legalMoves(game).filter((m) => m.from.r === r && m.from.c === c);
      render();
    } else {
      selected = null;
      legalForSelected = [];
      render();
    }
  }

  async function humanThinkingDelay() {
    if (!game) return;
    let ms = 220 + Math.random() * 650;
    if (Math.random() < 0.14) ms += 700 + Math.random() * 1600;
    try {
      const n = legalMoves(game).length;
      if (n > 28) ms += 150 + Math.random() * 500;
      else if (n > 18) ms += 80 + Math.random() * 320;
    } catch (_) {}
    if (game.turn === "b" && isInCheck(game, "b")) ms += 120 + Math.random() * 380;
    await new Promise((r) => setTimeout(r, Math.min(4500, Math.round(ms))));
  }

  async function scheduleCpu() {
    if (game.turn !== "b" || game.result || cpuBusy) return;
    cpuBusy = true;
    render();
    await humanThinkingDelay();
    const mv = await cpuBestMove(game);
    if (mv) moveAndRecord(mv);
    cpuBusy = false;
    render();
  }

  function isLastMoveSquare(r, c) {
    if (!game?.lastMove) return false;
    return (game.lastMove.from.r === r && game.lastMove.from.c === c)
      || (game.lastMove.to.r === r && game.lastMove.to.c === c);
  }

  function renderLobbyBoard() {
    hideCheckToast(true);
    if (lobbyOverlay) lobbyOverlay.hidden = false;
    boardEl.classList.add("board--idle");
    boardEl.setAttribute("aria-label", "対局開始前の盤面（初期配置のプレビュー）");
    updateMaterialDiff();
    boardEl.innerHTML = "";
    const preview = initialBoard();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.disabled = true;
      cell.setAttribute("aria-hidden", "true");
      cell.tabIndex = -1;
      cell.className = `sq ${(r + c) % 2 === 0 ? "light" : "dark"}`;
      const p = preview[r][c];
      if (p) {
        const pe = document.createElement("span");
        pe.className = "piece";
        pe.innerHTML = pieceSvg(p.type, p.color);
        cell.appendChild(pe);
      }
      boardEl.appendChild(cell);
    }
    if (statusEl) {
      statusEl.textContent =
        "対局はまだ始まっていません。持ち時間などを設定し、「対局開始」で始められます。";
    }
    if (logEl) logEl.textContent = "対局開始前です。";
    if (newGameBtn) newGameBtn.textContent = "対局開始";
    syncTurnBanner();
    syncUndoResetButtons();
  }

  function render() {
    updateClockView();
    if (!game) {
      renderLobbyBoard();
      return;
    }
    if (lobbyOverlay) lobbyOverlay.hidden = true;
    boardEl.classList.remove("board--idle");
    boardEl.setAttribute("aria-label", "チェス盤");
    if (newGameBtn) newGameBtn.textContent = "新しい対局";
    boardEl.innerHTML = "";
    const checkKing = isInCheck(game, game.turn) ? findKing(game, game.turn) : null;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `sq ${(r + c) % 2 === 0 ? "light" : "dark"}`;
      if (selected && selected.r === r && selected.c === c) cell.classList.add("selected");
      if (checkKing && checkKing.r === r && checkKing.c === c) cell.classList.add("check");
      if (isLastMoveSquare(r, c)) cell.classList.add("last-move");
      cell.addEventListener("click", () => handleClick(r, c));

      const p = game.board[r][c];
      if (p) {
        const pe = document.createElement("span");
        pe.className = "piece";
        pe.innerHTML = pieceSvg(p.type, p.color);
        cell.appendChild(pe);
      }

      const markMv = legalForSelected.find((m) => m.to.r === r && m.to.c === c);
      if (markMv) {
        const mark = document.createElement("span");
        mark.className = `mark ${markMv.capture || markMv.epCapture ? "capture" : "move"}`;
        cell.appendChild(mark);
      }

      boardEl.appendChild(cell);
    }

    if (game.result) statusEl.textContent = game.result;
    else if (cpuBusy) statusEl.textContent = "CPU（黒）が思考中です…";
    else statusEl.textContent = game.turn === "w" ? "あなた（白）の手番です" : "CPU（黒）の手番です";
    syncTurnBanner();
    updateLog();
    syncUndoResetButtons();
  }

  newGameBtn.addEventListener("click", newGame);
  undoBtn?.addEventListener("click", undoMove);
  resetGameBtn?.addEventListener("click", () => {
    if (!game || cpuBusy || pendingPromo) return;
    backToLobby();
  });

  copyPgnBtn?.addEventListener("click", async () => {
    if (!game) {
      statusEl.textContent = "対局が始まっていません。先に「対局開始」してください。";
      return;
    }
    const text = buildPgn();
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = "棋譜をクリップボードにコピーしました。";
    } catch (_) {
      statusEl.textContent = "コピーに失敗しました。棋譜欄を手動で選択してください。";
    }
  });

  engineDifficulty?.addEventListener("input", syncDifficultyLabel);

  exitBtn?.addEventListener("click", async () => {
    if (!confirm("サーバーを停止して終了します。よろしいですか？")) return;
    try {
      await fetch("/__shutdown__", {
        method: "POST",
        keepalive: true,
        cache: "no-store",
      });
      statusEl.textContent = "終了中…";
      window.close();
    } catch (_) {
      statusEl.textContent = "終了に失敗しました。コンソールで Ctrl+C を押してください。";
    }
  });

  promoModal?.querySelectorAll(".promo-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pr = btn.getAttribute("data-promo");
      if (!pendingPromo || !pr) {
        closePromoModal();
        return;
      }
      const mv = pendingPromo.find((m) => m.promo === pr);
      closePromoModal();
      if (mv) {
        moveAndRecord(mv);
        if (!game.result) scheduleCpu();
      }
      render();
    });
  });

  promoCancel?.addEventListener("click", closePromoModal);
  promoModal?.querySelector(".modal__backdrop")?.addEventListener("click", closePromoModal);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pendingPromo) {
      e.preventDefault();
      closePromoModal();
      render();
    }
  });

  setInterval(tickClock, 200);

  if (engineBadge) {
    if (!window.Worker) {
      engineBadge.textContent = "エンジン: 未対応（フォールバック探索）";
      engineBadge.classList.add("badge--warn");
    } else if (window.__engineInit) {
      engineBadge.textContent = "エンジン: 初期化中…";
      window.__engineInit()
        .then(() => {
          engineBadge.textContent = "エンジン: Stockfish 準備完了";
          engineBadge.classList.add("badge--ok");
        })
        .catch(() => {
          engineBadge.textContent = "エンジン: 初期化失敗（フォールバック）";
          engineBadge.classList.add("badge--warn");
        });
    } else {
      engineBadge.textContent = "エンジン: 読み込み中…";
    }
  }

  syncDifficultyLabel();

  timePreset?.addEventListener("change", () => {
    if (!game) updateClockPreview();
  });
  incrementPreset?.addEventListener("change", () => {
    if (!game) updateClockPreview();
  });
  render();
})();
