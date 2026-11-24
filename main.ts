import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

interface MarketEvent {
  seq: number;
  ts: number;
  mint: string;
  side: "create" | "buy" | "sell" | "migrate" | "init" | "end";
  sol: number;
  tokens: number;
  price: number;
  vSol: number;
  vTok: number;
  trader: string;
  creator: string;
  cash?: number;
}

interface TokenState {
  mint: string;
  creator: string;
  createdTs: number;
  lastTs: number;
  trades: number;
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
  vSol: number;
  vTok: number;
  price: number;
  openPrice: number;
  peakPrice: number;
  emaFast: number;
  emaSlow: number;
  devBuySol: number;
  devSellSol: number;
  buyers: Map<string, number>;
  recent: number[];
  migrated: boolean;
}

interface Position {
  mint: string;
  tokens: number;
  costSol: number;
  entryPrice: number;
  peakPrice: number;
  entrySeq: number;
  holdEvents: number;
  scaledOut: boolean;
}

interface TradeRecord {
  seq: number;
  ts: number;
  mint: string;
  action: "buy" | "sell";
  sol: number;
  tokens: number;
  price: number;
  pnlSol: number;
  reason: string;
  score: number;
  equityAfter: number;
}

interface BotAction {
  action: "hold" | "buy" | "sell";
  mint?: string;
  sol?: number;
  amount_sol?: number;
  pct?: number;
  fraction?: number;
  tokens?: number;
  reason?: string;
}

const FEE = 0.01;
const SLIP = 0.005;
const INIT_VSOL = 30;
const INIT_VTOK = 1_073_000_000;
const INIT_K = INIT_VSOL * INIT_VTOK;

function round(v: number, d = 6): number {
  const m = 10 ** d;
  return Math.round((Number.isFinite(v) ? v : 0) * m) / m;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
}

function num(v: unknown, fb = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fb;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeEvent(raw: Record<string, unknown>, seq: number): MarketEvent {
  const kind = String(raw.type ?? raw.event ?? raw.tx_type ?? raw.action ?? raw.side ?? "trade").toLowerCase();
  const rawSide = String(raw.side ?? "").toLowerCase();
  let side: MarketEvent["side"] = "buy";
  if (kind === "init" || kind === "start" || kind === "config") side = "init";
  else if (kind === "end" || kind === "done" || kind === "complete_replay") side = "end";
  else if (kind === "create" || kind === "launch") side = "create";
  else if (kind === "migrate" || kind === "complete" || kind === "graduate") side = "migrate";
  else if (kind === "sell" || rawSide === "sell" || raw.is_buy === false) side = "sell";
  const mint = String(raw.mint ?? raw.token ?? raw.token_address ?? raw.address ?? raw.symbol ?? "").trim() || "NONE";
  const sol = Math.max(0, num(raw.sol_amount ?? raw.sol ?? raw.quote_amount ?? raw.amount_sol, 0));
  const tokens = Math.max(0, num(raw.token_amount ?? raw.tokens ?? raw.base_amount, 0));
  const vSol = Math.max(0, num(raw.virtual_sol_reserves ?? raw.v_sol ?? raw.vSol, 0));
  const vTok = Math.max(0, num(raw.virtual_token_reserves ?? raw.v_tokens ?? raw.vTok, 0));
  let price = Math.max(0, num(raw.price_sol ?? raw.price, 0));
  if (price <= 0 && vSol > 0 && vTok > 0) price = vSol / vTok;
  if (price <= 0 && sol > 0 && tokens > 0) price = sol / tokens;
  const trader = String(raw.trader ?? raw.user ?? raw.wallet ?? raw.signer ?? "").trim() || `w_${seq}`;
  const creator = String(raw.creator ?? raw.dev ?? (side === "create" ? trader : "")).trim();
  const cashRaw = raw.cash ?? raw.initial_cash ?? raw.balance_sol ?? raw.sol_balance;
  const cashVal = cashRaw !== undefined ? num(cashRaw, -1) : undefined;
  return {
    seq,
    ts: num(raw.ts ?? raw.timestamp ?? raw.time ?? raw.slot, 1740000000 + seq),
    mint,
    side,
    sol,
    tokens,
    price,
    vSol,
    vTok,
    trader,
    creator,
    cash: cashVal !== undefined && cashVal > 0 ? cashVal : undefined,
  };
}

class PumpBotEngine {
  initialCash: number;
  cash: number;
  tokens: Map<string, TokenState>;
  positions: Map<string, Position>;
  cooldown: Map<string, number>;
  trades: TradeRecord[];
  equityCurve: { seq: number; ts: number; equity: number; cash: number }[];
  eventsSeen: number;
  realizedPnl: number;
  maxEquity: number;
  maxDrawdown: number;
  lastTs: number;

  constructor(initialCash = 10) {
    const start = Number.isFinite(initialCash) && initialCash > 0 ? initialCash : 10;
    this.initialCash = start;
    this.cash = start;
    this.tokens = new Map();
    this.positions = new Map();
    this.cooldown = new Map();
    this.trades = [];
    this.equityCurve = [{ seq: 0, ts: 1740000000, equity: start, cash: start }];
    this.eventsSeen = 0;
    this.realizedPnl = 0;
    this.maxEquity = start;
    this.maxDrawdown = 0;
    this.lastTs = 1740000000;
  }

  equity(): number {
    let val = this.cash;
    for (const pos of this.positions.values()) {
      const tok = this.tokens.get(pos.mint);
      if (tok && tok.price > 0) val += pos.tokens * tok.price * (1 - SLIP) * (1 - FEE);
    }
    return round(val, 6);
  }

  pruneTokens(): void {
    if (this.tokens.size <= 4000) return;
    for (const mint of this.tokens.keys()) {
      if (this.tokens.size <= 3000) break;
      if (!this.positions.has(mint)) this.tokens.delete(mint);
    }
  }

  updateToken(ev: MarketEvent): TokenState {
    let tok = this.tokens.get(ev.mint);
    const basePrice = ev.price > 0 ? ev.price : INIT_VSOL / INIT_VTOK;
    if (!tok) {
      this.pruneTokens();
      tok = {
        mint: ev.mint,
        creator: ev.creator || (ev.side === "create" ? ev.trader : ""),
        createdTs: ev.ts,
        lastTs: ev.ts,
        trades: 0,
        buys: 0,
        sells: 0,
        buySol: 0,
        sellSol: 0,
        vSol: ev.vSol > 0 ? ev.vSol : INIT_VSOL,
        vTok: ev.vTok > 0 ? ev.vTok : INIT_VTOK,
        price: basePrice,
        openPrice: basePrice,
        peakPrice: basePrice,
        emaFast: basePrice,
        emaSlow: basePrice,
        devBuySol: 0,
        devSellSol: 0,
        buyers: new Map(),
        recent: [],
        migrated: false,
      };
      this.tokens.set(ev.mint, tok);
    }
    tok.lastTs = ev.ts;
    if (!tok.creator && ev.creator) tok.creator = ev.creator;
    if (ev.vSol > 0) tok.vSol = ev.vSol;
    if (ev.vTok > 0) tok.vTok = ev.vTok;
    if (ev.side === "buy" || ev.side === "create") {
      if (ev.sol > 0) {
        tok.trades += 1;
        tok.buys += 1;
        tok.buySol += ev.sol;
        tok.buyers.set(ev.trader, (tok.buyers.get(ev.trader) ?? 0) + ev.sol);
        if (tok.creator && ev.trader === tok.creator) tok.devBuySol += ev.sol;
        tok.recent.push(ev.sol);
        if (ev.vSol <= 0) {
          tok.vSol += ev.sol;
          tok.vTok = INIT_K / Math.max(1, tok.vSol);
        }
      }
    } else if (ev.side === "sell") {
      if (ev.sol > 0) {
        tok.trades += 1;
        tok.sells += 1;
        tok.sellSol += ev.sol;
        if (tok.creator && ev.trader === tok.creator) tok.devSellSol += ev.sol;
        tok.recent.push(-ev.sol);
        if (ev.vSol <= 0) {
          tok.vSol = Math.max(INIT_VSOL * 0.5, tok.vSol - ev.sol);
          tok.vTok = INIT_K / Math.max(1, tok.vSol);
        }
      }
    } else if (ev.side === "migrate") {
      tok.migrated = true;
    }
    if (tok.recent.length > 8) tok.recent.shift();
    const px = ev.price > 0 ? ev.price : tok.vSol / Math.max(1, tok.vTok);
    if (px > 0) {
      tok.price = px;
      if (px > tok.peakPrice) tok.peakPrice = px;
      tok.emaFast = tok.emaFast * 0.65 + px * 0.35;
      tok.emaSlow = tok.emaSlow * 0.88 + px * 0.12;
    }
    return tok;
  }

  recentFlow(tok: TokenState): number {
    let sum = 0;
    for (const v of tok.recent) sum += v;
    return sum;
  }

  scoreEntry(tok: TokenState, seq: number): number {
    if (tok.migrated || tok.trades < 4 || tok.price <= 0) return -1;
    if (tok.vSol < 32.5 || tok.vSol > 96) return -1;
    if ((this.cooldown.get(tok.mint) ?? 0) > seq) return -1;
    if (tok.devSellSol > 0.35 && tok.devSellSol > tok.devBuySol * 0.25) return -1;
    const uniqueBuyers = tok.buyers.size;
    if (uniqueBuyers < 4) return -1;
    let maxBuyer = 0;
    for (const [w, amt] of tok.buyers.entries()) {
      if (w !== tok.creator && amt > maxBuyer) maxBuyer = amt;
    }
    if (tok.buySol > 0 && maxBuyer / tok.buySol > 0.62) return -1;
    const flowRatio = tok.buySol / Math.max(0.25, tok.sellSol);
    if (flowRatio < 1.35) return -1;
    const rFlow = this.recentFlow(tok);
    if (rFlow < 0.7) return -1;
    if (tok.emaFast <= tok.emaSlow * 1.01) return -1;
    if (tok.price < tok.openPrice * 1.04 || tok.price > tok.openPrice * 6.0) return -1;
    if (tok.price < tok.peakPrice * 0.88) return -1;
    const sFlow = clamp((flowRatio - 1.2) * 0.22, 0, 0.34);
    const sBreadth = clamp((uniqueBuyers - 3) * 0.055, 0, 0.26);
    const sMom = clamp((rFlow / Math.max(1, tok.vSol * 0.08)) * 0.2, 0, 0.2);
    const sTrend = clamp((tok.emaFast / Math.max(1e-12, tok.emaSlow) - 1) * 3.0, 0, 0.2);
    return round(sFlow + sBreadth + sMom + sTrend, 4);
  }

  executeBuy(tok: TokenState, solAmt: number, ev: MarketEvent, score: number, reason: string): BotAction {
    const spend = round(Math.min(solAmt, this.cash), 6);
    if (spend < 0.05 || tok.price <= 0) return { action: "hold" };
    const execPrice = tok.price * (1 + SLIP);
    const qty = (spend * (1 - FEE)) / execPrice;
    this.cash = round(this.cash - spend, 6);
    this.positions.set(tok.mint, {
      mint: tok.mint,
      tokens: qty,
      costSol: spend,
      entryPrice: tok.price,
      peakPrice: tok.price,
      entrySeq: ev.seq,
      holdEvents: 0,
      scaledOut: false,
    });
    const eq = this.equity();
    this.trades.push({
      seq: ev.seq,
      ts: ev.ts,
      mint: tok.mint,
      action: "buy",
      sol: spend,
      tokens: round(qty, 4),
      price: round(tok.price, 10),
      pnlSol: 0,
      reason,
      score,
      equityAfter: eq,
    });
    return { action: "buy", mint: tok.mint, sol: spend, amount_sol: spend, reason };
  }

  executeSell(pos: Position, tok: TokenState, fraction: number, ev: MarketEvent, reason: string): BotAction {
    const frac = clamp(fraction, 0.05, 1);
    const sellQty = pos.tokens * frac;
    const basis = pos.costSol * frac;
    const proceeds = sellQty * tok.price * (1 - SLIP) * (1 - FEE);
    const pnl = round(proceeds - basis, 6);
    this.cash = round(this.cash + proceeds, 6);
    this.realizedPnl = round(this.realizedPnl + pnl, 6);
    if (frac >= 0.999) {
      this.positions.delete(pos.mint);
      this.cooldown.set(pos.mint, ev.seq + 120);
    } else {
      pos.tokens -= sellQty;
      pos.costSol -= basis;
      pos.scaledOut = true;
    }
    const eq = this.equity();
    this.trades.push({
      seq: ev.seq,
      ts: ev.ts,
      mint: pos.mint,
      action: "sell",
      sol: round(proceeds, 6),
      tokens: round(sellQty, 4),
      price: round(tok.price, 10),
      pnlSol: pnl,
      reason,
      score: 0,
      equityAfter: eq,
    });
    return {
      action: "sell",
      mint: pos.mint,
      pct: round(frac * 100, 2),
      fraction: round(frac, 4),
      tokens: round(sellQty, 4),
      reason,
    };
  }

  step(ev: MarketEvent): BotAction {
    this.eventsSeen += 1;
    this.lastTs = ev.ts;
    if (ev.side === "init") {
      if (ev.cash && ev.cash > 0 && this.trades.length === 0) {
        this.initialCash = ev.cash;
        this.cash = ev.cash;
        this.maxEquity = ev.cash;
        this.equityCurve = [{ seq: ev.seq, ts: ev.ts, equity: ev.cash, cash: ev.cash }];
      }
      return { action: "hold" };
    }
    if (ev.side === "end") {
      this.finalize(ev.seq, ev.ts);
      return { action: "hold" };
    }
    if (ev.mint === "NONE") return { action: "hold" };
    const tok = this.updateToken(ev);
    let act: BotAction = { action: "hold" };
    const pos = this.positions.get(tok.mint);
    if (pos) {
      pos.holdEvents += 1;
      if (tok.price > pos.peakPrice) pos.peakPrice = tok.price;
      const ret = (tok.price - pos.entryPrice) / Math.max(1e-12, pos.entryPrice);
      const peakRet = (pos.peakPrice - pos.entryPrice) / Math.max(1e-12, pos.entryPrice);
      const ddPeak = (pos.peakPrice - tok.price) / Math.max(1e-12, pos.peakPrice);
      if (ev.side === "migrate") act = this.executeSell(pos, tok, 1, ev, "migrate_tp");
      else if (tok.devSellSol > 0.4 && tok.devSellSol > tok.devBuySol * 0.3) act = this.executeSell(pos, tok, 1, ev, "dev_dump");
      else if (ret <= -0.14) act = this.executeSell(pos, tok, 1, ev, "stop_loss");
      else if (!pos.scaledOut && ret >= 0.32) act = this.executeSell(pos, tok, 0.5, ev, "scale_out_tp");
      else if (pos.scaledOut && ret <= 0.04) act = this.executeSell(pos, tok, 1, ev, "breakeven_exit");
      else if (peakRet >= 0.45 && ddPeak >= 0.11) act = this.executeSell(pos, tok, 1, ev, "tight_trail");
      else if (peakRet >= 0.18 && ddPeak >= 0.14) act = this.executeSell(pos, tok, 1, ev, "trail_stop");
      else if (pos.holdEvents >= 16 && this.recentFlow(tok) < -0.6 && ret < 0.06) act = this.executeSell(pos, tok, 1, ev, "momentum_fade");
    } else if (ev.side === "buy" && this.positions.size < 3) {
      const score = this.scoreEntry(tok, ev.seq);
      const eq = this.equity();
      const reserve = eq * 0.18;
      if (score >= 0.45 && this.cash > reserve + 0.1) {
        const baseFrac = 0.14 + clamp((score - 0.45) * 0.22, 0, 0.1);
        const capByLiq = Math.max(0.1, tok.vSol * 0.04);
        const sizeSol = Math.min(this.cash * baseFrac, capByLiq, this.cash - reserve);
        act = this.executeBuy(tok, sizeSol, ev, score, "momentum_breakout");
      }
    }
    const eq = this.equity();
    if (eq > this.maxEquity) this.maxEquity = eq;
    const dd = this.maxEquity > 0 ? (this.maxEquity - eq) / this.maxEquity : 0;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    if (this.eventsSeen % 10 === 0 || act.action !== "hold") {
      this.equityCurve.push({ seq: ev.seq, ts: ev.ts, equity: eq, cash: round(this.cash, 6) });
    }
    return act;
  }

  finalize(seq = this.eventsSeen + 1, ts = this.lastTs + 1): void {
    for (const pos of [...this.positions.values()]) {
      const tok = this.tokens.get(pos.mint);
      if (tok && tok.price > 0) {
        const ev: MarketEvent = {
          seq,
          ts,
          mint: pos.mint,
          side: "sell",
          sol: 0,
          tokens: pos.tokens,
          price: tok.price,
          vSol: tok.vSol,
          vTok: tok.vTok,
          trader: "bot",
          creator: tok.creator,
        };
        this.executeSell(pos, tok, 1, ev, "end_liquidate");
      }
    }
    const eq = this.equity();
    this.equityCurve.push({ seq, ts, equity: eq, cash: round(this.cash, 6) });
  }
}

function collectInputFiles(rawPath: string, depth = 0): string[] {
  if (!rawPath || depth > 2) return [];
  try {
    const st = fs.statSync(rawPath);
    if (st.isFile()) return [rawPath];
    if (!st.isDirectory()) return [];
    const entries = fs.readdirSync(rawPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const found: string[] = [];
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(rawPath, ent.name);
      if (ent.isFile() && /\.(jsonl|ndjson|json|csv|txt)$/i.test(ent.name)) found.push(full);
      else if (ent.isDirectory() && depth < 2) found.push(...collectInputFiles(full, depth + 1));
    }
    return found;
  } catch {
    return [];
  }
}

function discoverInputs(): string[] {
  const candidates = [
    ...process.argv.slice(2).filter((a) => !a.startsWith("-")),
    process.env.REPLAY_FILE ?? "",
    process.env.REPLAY_PATH ?? "",
    process.env.INPUT_FILE ?? "",
    process.env.MAKEFUN_REPLAY_FILE ?? "",
    process.env.MAKEFUN_INPUT_FILE ?? "",
    process.env.MAKEFUN_INPUT_DIR ?? "",
    process.env.INPUT_DIR ?? "",
    process.env.DATA_DIR ?? "",
    process.env.MAKEFUN_DATA_DIR ?? "",
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    for (const f of collectInputFiles(c)) {
      const abs = path.resolve(f);
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    }
  }
  return out;
}

async function processFile(filePath: string, engine: PumpBotEngine): Promise<void> {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return;
  }
  if (!st.isFile()) return;
  if (/\.json$/i.test(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed)
          ? (parsed.events ?? parsed.trades ?? parsed.ticks ?? parsed.data ?? [parsed])
          : [];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (isRecord(item)) engine.step(normalizeEvent(item, engine.eventsSeen + 1));
        }
        return;
      }
    } catch {
      // Fall through to line-by-line JSONL parsing
    }
  }
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, "utf8"), crlfDelay: Infinity });
  let csvHeaders: string[] | null = null;
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("{")) {
      try {
        const obj: unknown = JSON.parse(line);
        if (isRecord(obj)) engine.step(normalizeEvent(obj, engine.eventsSeen + 1));
      } catch {
        // Ignore malformed line
      }
    } else if (/\.csv$/i.test(filePath)) {
      const parts = line.split(",").map((s) => s.trim());
      if (!csvHeaders) {
        csvHeaders = parts;
      } else {
        const rec: Record<string, unknown> = {};
        for (let i = 0; i < csvHeaders.length && i < parts.length; i += 1) rec[csvHeaders[i]] = parts[i];
        engine.step(normalizeEvent(rec, engine.eventsSeen + 1));
      }
    }
  }
}

function generateSyntheticEvents(): MarketEvent[] {
  const rng = mulberry32(0x50756d70);
  const events: MarketEvent[] = [];
  let seq = 1;
  let ts = 1740000000;
  const archetypes: ("runner" | "chop" | "rug")[] = [
    "runner", "rug", "chop", "runner", "chop", "rug",
    "runner", "chop", "rug", "runner", "chop", "runner",
  ];
  for (let i = 0; i < archetypes.length; i += 1) {
    const kind = archetypes[i];
    const mint = `MINT_${String(i + 1).padStart(2, "0")}`;
    const creator = `dev_${i + 1}`;
    let vSol = INIT_VSOL;
    let vTok = INIT_VTOK;
    const initBuy = 0.8 + rng() * 0.9;
    vSol += initBuy;
    vTok = INIT_K / vSol;
    events.push({ seq: seq++, ts: (ts += 2), mint, side: "create", sol: round(initBuy, 4), tokens: round(INIT_VTOK - vTok, 2), price: vSol / vTok, vSol, vTok, trader: creator, creator });
    const steps = kind === "runner" ? 68 : kind === "chop" ? 44 : 36;
    for (let s = 0; s < steps; s += 1) {
      ts += 3 + Math.floor(rng() * 4);
      let isBuy = true;
      let sol = 0.4 + rng() * 1.4;
      let trader = `w_${i}_${(s % 24) + 1}`;
      if (kind === "runner") {
        isBuy = s < 48 ? rng() < 0.78 : rng() < 0.32;
        sol = isBuy ? 0.8 + rng() * 2.1 : 0.4 + rng() * 1.3;
      } else if (kind === "chop") {
        isBuy = rng() < 0.48;
        sol = 0.3 + rng() * 0.9;
      } else {
        if (s === 12) {
          isBuy = false;
          sol = 2.6 + rng() * 1.2;
          trader = creator;
        } else {
          isBuy = s < 12 ? rng() < 0.72 : rng() < 0.22;
          sol = isBuy ? 0.5 + rng() * 1.1 : 0.9 + rng() * 1.8;
        }
      }
      const prevTok = vTok;
      if (isBuy) {
        vSol += sol;
        vTok = INIT_K / vSol;
      } else {
        sol = Math.min(sol, Math.max(0.1, vSol - INIT_VSOL * 0.65));
        vSol = Math.max(INIT_VSOL * 0.65, vSol - sol);
        vTok = INIT_K / vSol;
      }
      events.push({ seq: seq++, ts, mint, side: isBuy ? "buy" : "sell", sol: round(sol, 4), tokens: round(Math.abs(vTok - prevTok), 2), price: vSol / vTok, vSol, vTok, trader, creator });
      if (vSol >= 112) {
        events.push({ seq: seq++, ts: (ts += 2), mint, side: "migrate", sol: 0, tokens: 0, price: vSol / vTok, vSol, vTok, trader: "system", creator });
        break;
      }
    }
  }
  return events;
}

async function main(): Promise<void> {
  const startCash = num(process.env.MAKEFUN_INITIAL_CASH ?? process.env.INITIAL_CASH, 10);
  const engine = new PumpBotEngine(startCash);
  const inputFiles = discoverInputs();
  let mode = "synthetic";
  if (inputFiles.length > 0) {
    mode = "replay_file";
    for (const file of inputFiles) await processFile(file, engine);
  } else if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("{")) continue;
      try {
        const obj: unknown = JSON.parse(line);
        if (isRecord(obj)) {
          mode = "stdin_stream";
          const act = engine.step(normalizeEvent(obj, engine.eventsSeen + 1));
          process.stdout.write(`${JSON.stringify(act)}\n`);
        }
      } catch {
        // Ignore malformed stdin line
      }
    }
  }
  if (engine.eventsSeen === 0) {
    mode = "synthetic";
    for (const ev of generateSyntheticEvents()) engine.step(ev);
  }
  engine.finalize();
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || process.env.OUTPUT_DIR || "./out";
  fs.mkdirSync(outDir, { recursive: true });
  const sells = engine.trades.filter((t) => t.action === "sell");
  const wins = sells.filter((t) => t.pnlSol > 0).length;
  const losses = sells.filter((t) => t.pnlSol <= 0).length;
  const finalEquity = engine.equity();
  const netPnlSol = round(finalEquity - engine.initialCash, 6);
  const summary = {
    strategy: "pumpfun-momentum-v2",
    mode,
    eventsProcessed: engine.eventsSeen,
    initialCashSol: round(engine.initialCash, 6),
    finalCashSol: round(engine.cash, 6),
    finalEquitySol: finalEquity,
    netPnlSol,
    returnPct: round((netPnlSol / Math.max(1e-9, engine.initialCash)) * 100, 4),
    maxDrawdownPct: round(engine.maxDrawdown * 100, 4),
    totalTrades: engine.trades.length,
    closedLegs: sells.length,
    wins,
    losses,
    winRatePct: sells.length > 0 ? round((wins / sells.length) * 100, 2) : 0,
    beatsCash: finalEquity > engine.initialCash,
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(outDir, "trades.json"), `${JSON.stringify(engine.trades, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(outDir, "equity.json"), `${JSON.stringify(engine.equityCurve, null, 2)}\n`, "utf8");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  process.exitCode = 1;
});