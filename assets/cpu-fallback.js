/**
 * 究極フォールバック探索（Stockfish 非利用時）
 *
 * · 反復深化
 * · PVS（ヌル窓探索）+ LMR（静かな手の減深・必要時フル深さで再探索）
 * · 静止探索（捕獲）· 置換表 · キラー · 履歴 · MVV-LVA
 * · 評価: PeSTO 風 PST + ポーン重複・ビショップペア・ルーク半開線
 */
(function () {
  const MATE_SCORE = 30000;
  const MAX_PLIES = 16;
  const QMAX = 8;
  const TT_CAP = 180000;
  const DEFAULT_NODE_BUDGET = 5000000;
  const TIME_MS_DEFAULT = 14000;

  const PIECE_VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

  const PST = {
    p: [
      [0, 0, 0, 0, 0, 0, 0, 0],
      [98, 90, 96, 105, 105, 96, 90, 98],
      [24, 28, 32, 36, 36, 32, 28, 24],
      [12, 16, 18, 20, 20, 18, 16, 12],
      [6, 8, 10, 12, 12, 10, 8, 6],
      [2, 4, 6, 8, 8, 6, 4, 2],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ],
    n: [
      [-50, -40, -30, -24, -24, -30, -40, -50],
      [-40, -20, 0, 5, 5, 0, -20, -40],
      [-30, 5, 10, 15, 15, 10, 5, -30],
      [-24, 5, 15, 20, 20, 15, 5, -24],
      [-24, 5, 15, 20, 20, 15, 5, -24],
      [-30, 5, 10, 15, 15, 10, 5, -30],
      [-40, -20, 0, 5, 5, 0, -20, -40],
      [-50, -40, -30, -24, -24, -30, -40, -50],
    ],
    b: [
      [-20, -10, -10, -10, -10, -10, -10, -20],
      [-10, 0, 0, 0, 0, 0, 0, -10],
      [-10, 0, 5, 10, 10, 5, 0, -10],
      [-10, 5, 5, 10, 10, 5, 5, -10],
      [-10, 0, 10, 15, 15, 10, 0, -10],
      [-10, 10, 10, 15, 15, 10, 10, -10],
      [-10, 5, 0, 0, 0, 0, 5, -10],
      [-20, -10, -10, -10, -10, -10, -10, -20],
    ],
    r: [
      [0, 0, 0, 0, 0, 0, 0, 0],
      [5, 10, 10, 10, 10, 10, 10, 5],
      [-5, 0, 0, 0, 0, 0, 0, -5],
      [-5, 0, 0, 0, 0, 0, 0, -5],
      [-5, 0, 0, 0, 0, 0, 0, -5],
      [-5, 0, 0, 0, 0, 0, 0, -5],
      [-5, 0, 0, 0, 0, 0, 0, -5],
      [0, 0, 0, 5, 5, 0, 0, 0],
    ],
    q: [
      [-20, -10, -10, -5, -5, -10, -10, -20],
      [-10, 0, 0, 0, 0, 0, 0, -10],
      [-10, 0, 5, 5, 5, 5, 0, -10],
      [-5, 0, 5, 5, 5, 5, 0, -5],
      [0, 0, 5, 5, 5, 5, 0, -5],
      [-10, 5, 5, 5, 5, 5, 0, -10],
      [-10, 0, 5, 0, 0, 0, 0, -10],
      [-20, -10, -10, -5, -5, -10, -10, -20],
    ],
    k: [
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-20, -30, -30, -40, -40, -30, -30, -20],
      [-10, -20, -20, -20, -20, -20, -20, -10],
      [20, 20, 0, 0, 0, 0, 20, 20],
      [20, 30, 10, 0, 0, 10, 30, 20],
    ],
  };

  function sqIndex(r, c) {
    return r * 8 + c;
  }

  function makeHashKey(pos) {
    let s = pos.turn;
    s += pos.castling.wk ? "K" : "";
    s += pos.castling.wq ? "Q" : "";
    s += pos.castling.bk ? "k" : "";
    s += pos.castling.bq ? "q" : "";
    s += pos.ep ? `e${pos.ep.r}${pos.ep.c}` : "-";
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = pos.board[r][c];
        s += p ? `${p.color}${p.type}` : ".";
      }
    }
    return s;
  }

  function evalMaterialPst(pos) {
    let score = 0;
    const b = pos.board;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = b[r][c];
        if (!p) continue;
        const wr = 7 - r;
        const pst = PST[p.type] ? PST[p.type][wr][c] : 0;
        const mat = PIECE_VAL[p.type];
        const add = mat + pst;
        score += p.color === "w" ? add : -add;
      }
    }
    return score;
  }

  function evalStructure(pos) {
    const b = pos.board;
    let bonus = 0;
    const wFiles = [0, 0, 0, 0, 0, 0, 0, 0];
    const bFiles = [0, 0, 0, 0, 0, 0, 0, 0];
    let wBish = 0;
    let bBish = 0;

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = b[r][c];
        if (!p) continue;
        if (p.type === "p") {
          if (p.color === "w") wFiles[c]++;
          else bFiles[c]++;
        } else if (p.type === "b") {
          if (p.color === "w") wBish++;
          else bBish++;
        }
      }
    }

    for (let c = 0; c < 8; c++) {
      if (wFiles[c] > 1) bonus -= 18 * (wFiles[c] - 1);
      if (bFiles[c] > 1) bonus += 18 * (bFiles[c] - 1);
    }

    if (wBish >= 2) bonus += 35;
    if (bBish >= 2) bonus -= 35;

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = b[r][c];
        if (!p || p.type !== "r") continue;
        const wf = wFiles[c];
        const bf = bFiles[c];
        if (p.color === "w") {
          if (wf === 0) bonus += 14;
        } else if (bf === 0) {
          bonus -= 14;
        }
      }
    }

    return bonus;
  }

  function evalWhitePov(pos) {
    return evalMaterialPst(pos) + evalStructure(pos);
  }

  function sideMultiplier(pos) {
    return pos.turn === "w" ? 1 : -1;
  }

  function isCapture(mv) {
    return !!(mv.capture || mv.epCapture || mv.promo);
  }

  function mvvLvaScore(pos, mv) {
    const attacker = pos.board[mv.from.r][mv.from.c];
    const victim = pos.board[mv.to.r][mv.to.c];
    const v = victim ? PIECE_VAL[victim.type] : mv.epCapture ? 100 : 0;
    const a = PIECE_VAL[attacker.type];
    return 400 * v - a + (mv.promo ? 50 : 0);
  }

  function moveEquals(a, b) {
    if (!a || !b) return false;
    return (
      a.from.r === b.from.r &&
      a.from.c === b.from.c &&
      a.to.r === b.to.r &&
      a.to.c === b.to.c &&
      (a.promo || "") === (b.promo || "")
    );
  }

  function orderMoves(pos, moves, ply, ttMove, killers, history) {
    return moves
      .map((mv) => {
        let pri = 0;
        if (ttMove && moveEquals(mv, ttMove)) pri = 1e9;
        else if (isCapture(mv)) pri = 800000 + mvvLvaScore(pos, mv);
        else {
          const k0 = killers[ply]?.[0];
          const k1 = killers[ply]?.[1];
          if (k0 && moveEquals(mv, k0)) pri = 700000;
          else if (k1 && moveEquals(mv, k1)) pri = 600000;
          else {
            const fr = sqIndex(mv.from.r, mv.from.c);
            const to = sqIndex(mv.to.r, mv.to.c);
            pri = history[fr][to];
          }
        }
        return { mv, pri };
      })
      .sort((x, y) => y.pri - x.pri)
      .map((x) => x.mv);
  }

  function registerKiller(killers, ply, mv) {
    if (isCapture(mv)) return;
    if (!killers[ply]) killers[ply] = [null, null];
    const k = killers[ply];
    if (moveEquals(mv, k[0])) return;
    k[1] = k[0];
    k[0] = mv;
  }

  function lmrReduction(moveIdx, depth, mv) {
    if (moveIdx < 4 || depth < 3) return 0;
    if (isCapture(mv)) return 0;
    let r = 1 + Math.floor(Math.log2(moveIdx + 1));
    if (r > depth - 2) r = Math.max(0, depth - 2);
    return Math.max(0, r);
  }

  function ttGet(tt, key) {
    return tt.get(key);
  }

  function ttPut(tt, key, depth, score, flag, bestMv) {
    if (tt.size >= TT_CAP) tt.clear();
    tt.set(key, { depth, score, flag, bestMv });
  }

  function ttScoreCutoff(entry, depth, alpha, beta) {
    if (!entry || entry.depth < depth) return null;
    const s = entry.score;
    if (entry.flag === 0) return s;
    if (entry.flag === 1 && s >= beta) return s;
    if (entry.flag === 2 && s <= alpha) return s;
    return null;
  }

  function ttFlagFromSearch(best, alpha, beta, origAlpha) {
    if (best <= origAlpha) return 2;
    if (best >= beta) return 1;
    return 0;
  }

  function quiescence(api, pos, alpha, beta, qdepth, ply, ctx) {
    ctx.nodes++;
    if (ctx.nodes > ctx.nodeBudget || performance.now() > ctx.deadline) {
      return sideMultiplier(pos) * evalWhitePov(pos);
    }

    const stand = sideMultiplier(pos) * evalWhitePov(pos);
    if (stand >= beta) return stand;
    let a = alpha;
    if (stand > a) a = stand;
    if (qdepth >= QMAX) return stand;

    const caps = api.legalMoves(pos).filter((m) => isCapture(m));
    if (!caps.length) return stand;

    caps.sort((x, y) => mvvLvaScore(pos, y) - mvvLvaScore(pos, x));

    let best = stand;
    for (const mv of caps) {
      const next = api.applyMove(pos, mv);
      const sc = -quiescence(api, next, -beta, -a, qdepth + 1, ply + 1, ctx);
      if (sc > best) best = sc;
      if (best > a) a = best;
      if (a >= beta) break;
    }
    return best;
  }

  /**
   * PVS + LMR。score は手番側から見た評価（negamax 形式で子では反転）
   */
  function pvs(api, pos, depth, alpha, beta, ply, ctx) {
    ctx.nodes++;
    if (ctx.nodes > ctx.nodeBudget || performance.now() > ctx.deadline) {
      return sideMultiplier(pos) * evalWhitePov(pos);
    }

    const key = makeHashKey(pos);
    const tte = ttGet(ctx.tt, key);
    const ttMove = tte?.bestMv || null;

    const tcut = ttScoreCutoff(tte, depth, alpha, beta);
    if (tcut !== null) return tcut;

    const moves = api.legalMoves(pos);
    if (!moves.length) {
      if (api.isInCheck(pos, pos.turn)) return -MATE_SCORE + ply;
      return 0;
    }

    if (depth <= 0) {
      return quiescence(api, pos, alpha, beta, 0, ply, ctx);
    }

    const ordered = orderMoves(pos, moves, ply, ttMove, ctx.killers, ctx.history);
    let best = -Infinity;
    let bestMv = null;
    const origAlpha = alpha;
    let moveIdx = 0;

    for (const mv of ordered) {
      const next = api.applyMove(pos, mv);
      const red = lmrReduction(moveIdx, depth, mv);
      const shallowD = depth - 1 - red;
      let sc;

      if (moveIdx === 0) {
        sc = -pvs(api, next, depth - 1, -beta, -alpha, ply + 1, ctx);
      } else {
        if (shallowD <= 0) {
          sc = -quiescence(api, next, -alpha - 1, -alpha, 0, ply + 1, ctx);
        } else {
          sc = -pvs(api, next, shallowD, -alpha - 1, -alpha, ply + 1, ctx);
        }
        if (sc > alpha) {
          sc = -pvs(api, next, depth - 1, -beta, -alpha, ply + 1, ctx);
        }
      }

      if (sc > best) {
        best = sc;
        bestMv = mv;
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        registerKiller(ctx.killers, ply, mv);
        const fr = sqIndex(mv.from.r, mv.from.c);
        const to = sqIndex(mv.to.r, mv.to.c);
        ctx.history[fr][to] += depth * depth;
        break;
      }
      moveIdx++;
    }

    const tf = ttFlagFromSearch(best, alpha, beta, origAlpha);
    ttPut(ctx.tt, key, depth, best, tf, bestMv);
    return best;
  }

  function searchRoot(api, pos, maxDepth, ctx) {
    const moves = api.legalMoves(pos);
    if (!moves.length) return null;

    let bestMv = moves[0];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const ordered = orderMoves(pos, moves, 0, ctx.lastBest, ctx.killers, ctx.history);
      let alpha = -Infinity;
      const beta = Infinity;
      let best = -Infinity;
      let localBest = bestMv;

      for (let mi = 0; mi < ordered.length; mi++) {
        const mv = ordered[mi];
        const next = api.applyMove(pos, mv);
        const red = lmrReduction(mi, depth, mv);
        const shallowD = depth - 1 - red;
        let sc;

        if (mi === 0) {
          sc = -pvs(api, next, depth - 1, -beta, -alpha, 1, ctx);
        } else {
          if (shallowD <= 0) {
            sc = -quiescence(api, next, -alpha - 1, -alpha, 0, 1, ctx);
          } else {
            sc = -pvs(api, next, shallowD, -alpha - 1, -alpha, 1, ctx);
          }
          if (sc > alpha) {
            sc = -pvs(api, next, depth - 1, -beta, -alpha, 1, ctx);
          }
        }

        if (sc > best) {
          best = sc;
          localBest = mv;
        }
        if (best > alpha) alpha = best;
      }

      bestMv = localBest;
      ctx.lastBest = bestMv;

      if (performance.now() > ctx.deadline || ctx.nodes > ctx.nodeBudget) break;
    }

    return bestMv;
  }

  function createSearch(api, options) {
    return function pickBest(pos) {
      const dyn =
        typeof window !== "undefined" && typeof window.__getCpuFallbackOptions === "function"
          ? window.__getCpuFallbackOptions()
          : null;
      const timeMs = dyn?.timeMs ?? options?.timeMs ?? TIME_MS_DEFAULT;
      const nodeBudget = dyn?.nodeBudget ?? options?.nodeBudget ?? DEFAULT_NODE_BUDGET;
      const depthCap = dyn?.maxDepth;

      const ctx = {
        tt: new Map(),
        killers: [],
        history: Array.from({ length: 64 }, () => Array(64).fill(0)),
        nodes: 0,
        nodeBudget,
        deadline: performance.now() + timeMs,
        lastBest: null,
      };

      const legal = api.legalMoves(pos);
      if (!legal.length) return null;

      let maxDepth = MAX_PLIES;
      const moveCount = legal.length;
      if (moveCount > 40) maxDepth = Math.min(maxDepth, 10);
      else if (moveCount > 30) maxDepth = Math.min(maxDepth, 12);
      else if (moveCount > 22) maxDepth = Math.min(maxDepth, 14);
      if (typeof depthCap === "number" && depthCap >= 1) {
        maxDepth = Math.min(maxDepth, Math.floor(depthCap));
      }

      const best = searchRoot(api, pos, maxDepth, ctx);
      if (!best) return null;
      const humanize =
        typeof window !== "undefined" && typeof window.__getCpuHumanizeChance === "function"
          ? window.__getCpuHumanizeChance()
          : 0;
      if (Math.random() < humanize) {
        const ordered = orderMoves(pos, legal, 0, ctx.lastBest, ctx.killers, ctx.history);
        const n = Math.min(ordered.length, 2 + Math.floor(Math.random() * 5));
        return ordered[Math.floor(Math.random() * n)];
      }
      return best;
    };
  }

  window.__cpuFallbackFactory = createSearch;
})();
