export interface TradeRecord {
  ts: number;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  trader: string;
  priceSol?: number;
}

export interface CurveState {
  virtualSolReserves: number;
  virtualTokenReserves: number;
  realSolReserves: number;
  realTokenReserves?: number;
  totalSupply?: number;
  migrated?: boolean;
}

export interface TokenSnapshot {
  mint: string;
  creator?: string;
  createdAtTs: number;
  nowTs: number;
  curve: CurveState;
  trades: TradeRecord[];
  peakPriceSol?: number;
  peakRealSol?: number;
}

export interface ScoringConfig {
  graduationSol: number;
  defaultTotalSupply: number;
  shortWindowSec: number;
  mediumWindowSec: number;
  sniperWindowSec: number;
  maxSafeTop1Share: number;
  maxSafeTop5Share: number;
  devDumpWarnFraction: number;
  minUniqueBuyers: number;
}

export interface WhaleMetrics {
  holderCount: number;
  totalTrackedTokens: number;
  top1Share: number;
  top5Share: number;
  top10Share: number;
  hhi: number;
  devHoldingShare: number;
  devPeakTokens: number;
  devCurrentTokens: number;
  devDumpedFraction: number;
  sniperShare: number;
  washRatio: number;
}

export interface FlowWindowMetrics {
  buySol: number;
  sellSol: number;
  netFlowSol: number;
  totalVolSol: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  imbalance: number;
  avgBuySol: number;
  avgSellSol: number;
  solPerSec: number;
  tradesPerSec: number;
}

export type MarketRegime =
  | "early_launch"
  | "momentum"
  | "graduation_push"
  | "distribution"
  | "rug_risk"
  | "dead";

export type ActionHint =
  | "strong_buy"
  | "buy"
  | "hold"
  | "trim"
  | "exit"
  | "avoid";

export interface TokenScore {
  mint: string;
  ts: number;
  ageSec: number;
  priceSol: number;
  marketCapSol: number;
  liquiditySol: number;
  liquidityToMcap: number;
  curveProgress: number;
  curveVelocityPerMin: number;
  drawdownFromPeak: number;
  shortFlow: FlowWindowMetrics;
  mediumFlow: FlowWindowMetrics;
  whales: WhaleMetrics;
  flowScore: number;
  velocityScore: number;
  liquidityScore: number;
  distributionScore: number;
  momentumScore: number;
  rugRisk: number;
  compositeScore: number;
  signalStrength: number;
  regime: MarketRegime;
  actionHint: ActionHint;
  riskFlags: string[];
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  graduationSol: 85,
  defaultTotalSupply: 1_000_000_000,
  shortWindowSec: 15,
  mediumWindowSec: 60,
  sniperWindowSec: 3,
  maxSafeTop1Share: 0.12,
  maxSafeTop5Share: 0.35,
  devDumpWarnFraction: 0.5,
  minUniqueBuyers: 6,
};

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function safeDiv(num: number, den: number, fallback = 0): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || Math.abs(den) <= 1e-12) {
    return fallback;
  }
  const out = num / den;
  return Number.isFinite(out) ? out : fallback;
}

export function round6(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function computeCurvePrice(curve: CurveState): number {
  if (curve.virtualSolReserves <= 0 || curve.virtualTokenReserves <= 0) {
    return 0;
  }
  return safeDiv(curve.virtualSolReserves, curve.virtualTokenReserves, 0);
}

export function computeCurveProgress(
  curve: CurveState,
  graduationSol = DEFAULT_SCORING_CONFIG.graduationSol
): number {
  if (curve.migrated) return 1;
  return clamp(safeDiv(Math.max(0, curve.realSolReserves), graduationSol, 0), 0, 1);
}

export function computeLiquidityMetrics(
  curve: CurveState,
  defaultTotalSupply = DEFAULT_SCORING_CONFIG.defaultTotalSupply
): { priceSol: number; marketCapSol: number; liquiditySol: number; liquidityToMcap: number } {
  const priceSol = computeCurvePrice(curve);
  const supply = curve.totalSupply && curve.totalSupply > 0 ? curve.totalSupply : defaultTotalSupply;
  const marketCapSol = priceSol * supply;
  const realSol = Math.max(0, curve.realSolReserves);
  const liquiditySol = curve.migrated ? realSol * 2 : realSol * 2;
  const liquidityToMcap = clamp(safeDiv(liquiditySol, marketCapSol, 0), 0, 2);
  return { priceSol, marketCapSol, liquiditySol, liquidityToMcap };
}

export function computeFlowWindow(
  trades: TradeRecord[],
  nowTs: number,
  windowSec: number
): FlowWindowMetrics {
  const cutoff = nowTs - windowSec;
  let buySol = 0;
  let sellSol = 0;
  let buyCount = 0;
  let sellCount = 0;
  const buyers = new Set<string>();
  const sellers = new Set<string>();

  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t.ts < cutoff) break;
    if (t.ts > nowTs) continue;
    const sol = Math.max(0, t.solAmount);
    if (t.side === "buy") {
      buySol += sol;
      buyCount += 1;
      if (t.trader) buyers.add(t.trader);
    } else {
      sellSol += sol;
      sellCount += 1;
      if (t.trader) sellers.add(t.trader);
    }
  }

  const totalVolSol = buySol + sellSol;
  const netFlowSol = buySol - sellSol;
  const imbalance = safeDiv(netFlowSol, totalVolSol, 0);
  const dur = Math.max(1, windowSec);

  return {
    buySol: round6(buySol),
    sellSol: round6(sellSol),
    netFlowSol: round6(netFlowSol),
    totalVolSol: round6(totalVolSol),
    buyCount,
    sellCount,
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    imbalance: round6(imbalance),
    avgBuySol: round6(safeDiv(buySol, buyCount, 0)),
    avgSellSol: round6(safeDiv(sellSol, sellCount, 0)),
    solPerSec: round6(totalVolSol / dur),
    tradesPerSec: round6((buyCount + sellCount) / dur),
  };
}

export function computeWhaleMetrics(
  trades: TradeRecord[],
  createdAtTs: number,
  creator?: string,
  sniperWindowSec = DEFAULT_SCORING_CONFIG.sniperWindowSec
): WhaleMetrics {
  const balances = new Map<string, number>();
  const boughtByWallet = new Map<string, number>();
  const soldByWallet = new Map<string, number>();
  let sniperTokens = 0;
  let totalBoughtTokens = 0;
  let devPeakTokens = 0;
  let devCurrentTokens = 0;
  const sniperCutoff = createdAtTs + sniperWindowSec;

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const wallet = t.trader || "unknown";
    const qty = Math.max(0, t.tokenAmount);
    const prev = balances.get(wallet) ?? 0;

    if (t.side === "buy") {
      const next = prev + qty;
      balances.set(wallet, next);
      boughtByWallet.set(wallet, (boughtByWallet.get(wallet) ?? 0) + qty);
      totalBoughtTokens += qty;
      if (t.ts <= sniperCutoff && wallet !== creator) {
        sniperTokens += qty;
      }
      if (creator && wallet === creator) {
        devCurrentTokens = next;
        if (next > devPeakTokens) devPeakTokens = next;
      }
    } else {
      const next = Math.max(0, prev - qty);
      balances.set(wallet, next);
      soldByWallet.set(wallet, (soldByWallet.get(wallet) ?? 0) + qty);
      if (creator && wallet === creator) {
        devCurrentTokens = next;
      }
    }
  }

  const positive: number[] = [];
  let totalTrackedTokens = 0;
  let roundTripVolume = 0;
  let totalGrossTokenVol = 0;

  for (const [wallet, bal] of balances.entries()) {
    if (bal > 1e-9) {
      positive.push(bal);
      totalTrackedTokens += bal;
    }
    const b = boughtByWallet.get(wallet) ?? 0;
    const s = soldByWallet.get(wallet) ?? 0;
    roundTripVolume += Math.min(b, s) * 2;
    totalGrossTokenVol += b + s;
  }

  positive.sort((a, b) => b - a);

  let top1 = 0;
  let top5 = 0;
  let top10 = 0;
  let hhi = 0;

  if (totalTrackedTokens > 0) {
    top1 = (positive[0] ?? 0) / totalTrackedTokens;
    for (let i = 0; i < positive.length; i++) {
      const share = positive[i] / totalTrackedTokens;
      hhi += share * share;
      if (i < 5) top5 += share;
      if (i < 10) top10 += share;
    }
  }

  const devHoldingShare = safeDiv(devCurrentTokens, totalTrackedTokens, 0);
  const devDumpedFraction =
    devPeakTokens > 0 ? clamp((devPeakTokens - devCurrentTokens) / devPeakTokens, 0, 1) : 0;
  const sniperShare = clamp(safeDiv(sniperTokens, totalBoughtTokens, 0), 0, 1);
  const washRatio = clamp(safeDiv(roundTripVolume, totalGrossTokenVol, 0), 0, 1);

  return {
    holderCount: positive.length,
    totalTrackedTokens: round6(totalTrackedTokens),
    top1Share: round6(top1),
    top5Share: round6(top5),
    top10Share: round6(top10),
    hhi: round6(hhi),
    devHoldingShare: round6(devHoldingShare),
    devPeakTokens: round6(devPeakTokens),
    devCurrentTokens: round6(devCurrentTokens),
    devDumpedFraction: round6(devDumpedFraction),
    sniperShare: round6(sniperShare),
    washRatio: round6(washRatio),
  };
}

export function scoreToken(
  snapshot: TokenSnapshot,
  overrides?: Partial<ScoringConfig>
): TokenScore {
  const cfg: ScoringConfig = { ...DEFAULT_SCORING_CONFIG, ...overrides };
  const ageSec = Math.max(1, snapshot.nowTs - snapshot.createdAtTs);
  const { priceSol, marketCapSol, liquiditySol, liquidityToMcap } = computeLiquidityMetrics(
    snapshot.curve,
    cfg.defaultTotalSupply
  );
  const curveProgress = computeCurveProgress(snapshot.curve, cfg.graduationSol);
  const shortFlow = computeFlowWindow(snapshot.trades, snapshot.nowTs, cfg.shortWindowSec);
  const mediumFlow = computeFlowWindow(snapshot.trades, snapshot.nowTs, cfg.mediumWindowSec);
  const whales = computeWhaleMetrics(
    snapshot.trades,
    snapshot.createdAtTs,
    snapshot.creator,
    cfg.sniperWindowSec
  );

  const shortNetRatePerMin = (shortFlow.netFlowSol / Math.max(1, cfg.shortWindowSec)) * 60;
  const curveVelocityPerMin = safeDiv(shortNetRatePerMin, cfg.graduationSol, 0);

  let peakPrice = snapshot.peakPriceSol ?? priceSol;
  for (let i = 0; i < snapshot.trades.length; i++) {
    const p = snapshot.trades[i].priceSol;
    if (p !== undefined && p > peakPrice) peakPrice = p;
  }
  const drawdownFromPeak = peakPrice > 0 ? clamp((peakPrice - priceSol) / peakPrice, 0, 1) : 0;

  const flowImbalanceTerm = clamp((shortFlow.imbalance * 0.65 + mediumFlow.imbalance * 0.35 + 1) / 2, 0, 1);
  const buyerBreadthTerm = clamp(mediumFlow.uniqueBuyers / Math.max(1, cfg.minUniqueBuyers * 2), 0, 1);
  const buyerRatioTerm = clamp(
    safeDiv(shortFlow.uniqueBuyers, shortFlow.uniqueBuyers + shortFlow.uniqueSellers, 0.5),
    0,
    1
  );
  const flowScore = clamp(
    (flowImbalanceTerm * 0.45 + buyerBreadthTerm * 0.3 + buyerRatioTerm * 0.25) * 100,
    0,
    100
  );

  const accelRatio = safeDiv(shortFlow.solPerSec, Math.max(0.05, mediumFlow.solPerSec), 0);
  const accelTerm = clamp(accelRatio / 2.2, 0, 1);
  const curveVelTerm = clamp((curveVelocityPerMin + 0.05) / 0.35, 0, 1);
  const activityTerm = clamp(shortFlow.tradesPerSec / 1.5, 0, 1);
  const velocityScore = clamp((curveVelTerm * 0.45 + accelTerm * 0.35 + activityTerm * 0.2) * 100, 0, 100);

  const realSolDepthTerm = clamp(snapshot.curve.realSolReserves / 35, 0, 1);
  const liqMcapTerm = clamp(liquidityToMcap / 0.35, 0, 1);
  const progressSweetSpot =
    curveProgress >= 0.12 && curveProgress <= 0.88
      ? 1
      : curveProgress < 0.12
        ? curveProgress / 0.12
        : clamp(1 - (curveProgress - 0.88) / 0.2, 0.4, 1);
  const liquidityScore = clamp(
    (realSolDepthTerm * 0.4 + liqMcapTerm * 0.35 + progressSweetSpot * 0.25) * 100,
    0,
    100
  );

  const top1Penalty = clamp(safeDiv(whales.top1Share, cfg.maxSafeTop1Share, 0) - 0.5, 0, 1);
  const top5Penalty = clamp(safeDiv(whales.top5Share, cfg.maxSafeTop5Share, 0) - 0.5, 0, 1);
  const hhiPenalty = clamp(whales.hhi / 0.18, 0, 1);
  const holderTerm = clamp(whales.holderCount / 30, 0, 1);
  const distributionScore = clamp(
    (1 - (top1Penalty * 0.35 + top5Penalty * 0.35 + hhiPenalty * 0.3)) * 75 + holderTerm * 25,
    0,
    100
  );

  const sizeAsym = clamp(safeDiv(shortFlow.avgBuySol, Math.max(0.02, shortFlow.avgSellSol), 1) / 2, 0, 1);
  const drawdownTerm = clamp(1 - drawdownFromPeak / 0.45, 0, 1);
  const momentumScore = clamp(
    (drawdownTerm * 0.45 + flowImbalanceTerm * 0.35 + sizeAsym * 0.2) * 100,
    0,
    100
  );

  const riskFlags: string[] = [];
  let rugRisk = 0;

  if (whales.devDumpedFraction >= cfg.devDumpWarnFraction && whales.devPeakTokens > 0) {
    rugRisk += 0.32 * whales.devDumpedFraction;
    riskFlags.push("dev_dump");
  }
  if (whales.top1Share > cfg.maxSafeTop1Share * 1.4) {
    rugRisk += 0.22;
    riskFlags.push("whale_top1_concentration");
  }
  if (whales.top5Share > cfg.maxSafeTop5Share * 1.35) {
    rugRisk += 0.18;
    riskFlags.push("whale_top5_concentration");
  }
  if (whales.sniperShare > 0.35 && ageSec < 180) {
    rugRisk += 0.18;
    riskFlags.push("sniper_bundle_heavy");
  }
  if (whales.washRatio > 0.55 && mediumFlow.uniqueBuyers < cfg.minUniqueBuyers) {
    rugRisk += 0.22;
    riskFlags.push("wash_trading");
  }
  if (drawdownFromPeak > 0.45 && shortFlow.imbalance < -0.25) {
    rugRisk += 0.25;
    riskFlags.push("post_peak_cascade");
  }
  if (
    snapshot.peakRealSol !== undefined &&
    snapshot.peakRealSol > 5 &&
    snapshot.curve.realSolReserves < snapshot.peakRealSol * 0.55
  ) {
    rugRisk += 0.25;
    riskFlags.push("liquidity_drain");
  }
  if (liquidityToMcap < 0.04 && !snapshot.curve.migrated && ageSec > 20) {
    rugRisk += 0.12;
    riskFlags.push("thin_liquidity");
  }
  rugRisk = clamp(rugRisk, 0, 1);

  const rawComposite =
    flowScore * 0.3 +
    velocityScore * 0.24 +
    liquidityScore * 0.16 +
    distributionScore * 0.15 +
    momentumScore * 0.15;
  const compositeScore = clamp(rawComposite * (1 - rugRisk * 0.72), 0, 100);
  const signalStrength = clamp((compositeScore - 50) / 50 - rugRisk * 0.5, -1, 1);

  let regime: MarketRegime = "momentum";
  if (rugRisk >= 0.58) {
    regime = "rug_risk";
  } else if (mediumFlow.totalVolSol < 0.25 && ageSec > 45) {
    regime = "dead";
  } else if (curveProgress >= 0.72 && shortFlow.netFlowSol > 0) {
    regime = "graduation_push";
  } else if (shortFlow.imbalance < -0.2 && drawdownFromPeak > 0.2) {
    regime = "distribution";
  } else if (ageSec <= 25 && curveProgress < 0.2) {
    regime = "early_launch";
  }

  let actionHint: ActionHint = "hold";
  if (rugRisk >= 0.55 || regime === "rug_risk") {
    actionHint = "avoid";
  } else if (regime === "distribution" || drawdownFromPeak > 0.35 || shortFlow.imbalance < -0.35) {
    actionHint = "exit";
  } else if (compositeScore >= 72 && rugRisk <= 0.22 && shortFlow.netFlowSol > 0.3) {
    actionHint = "strong_buy";
  } else if (compositeScore >= 58 && rugRisk <= 0.32 && shortFlow.netFlowSol > 0) {
    actionHint = "buy";
  } else if (compositeScore < 42 || curveVelocityPerMin < -0.04) {
    actionHint = "trim";
  }

  return {
    mint: snapshot.mint,
    ts: snapshot.nowTs,
    ageSec: round6(ageSec),
    priceSol: round6(priceSol),
    marketCapSol: round6(marketCapSol),
    liquiditySol: round6(liquiditySol),
    liquidityToMcap: round6(liquidityToMcap),
    curveProgress: round6(curveProgress),
    curveVelocityPerMin: round6(curveVelocityPerMin),
    drawdownFromPeak: round6(drawdownFromPeak),
    shortFlow,
    mediumFlow,
    whales,
    flowScore: round6(flowScore),
    velocityScore: round6(velocityScore),
    liquidityScore: round6(liquidityScore),
    distributionScore: round6(distributionScore),
    momentumScore: round6(momentumScore),
    rugRisk: round6(rugRisk),
    compositeScore: round6(compositeScore),
    signalStrength: round6(signalStrength),
    regime,
    actionHint,
    riskFlags,
  };
}

export class TokenFlowTracker {
  readonly config: ScoringConfig;
  private states: Map<string, TokenSnapshot>;
  private maxTradesPerToken: number;

  constructor(overrides?: Partial<ScoringConfig>, maxTradesPerToken = 1000) {
    this.config = { ...DEFAULT_SCORING_CONFIG, ...overrides };
    this.states = new Map<string, TokenSnapshot>();
    this.maxTradesPerToken = Math.max(50, maxTradesPerToken);
  }

  upsertToken(mint: string, createdAtTs: number, curve: CurveState, creator?: string): void {
    const existing = this.states.get(mint);
    const price = computeCurvePrice(curve);
    if (!existing) {
      this.states.set(mint, {
        mint,
        creator,
        createdAtTs,
        nowTs: createdAtTs,
        curve: { ...curve },
        trades: [],
        peakPriceSol: price,
        peakRealSol: Math.max(0, curve.realSolReserves),
      });
      return;
    }
    existing.curve = { ...curve };
    if (creator && !existing.creator) existing.creator = creator;
    if (price > (existing.peakPriceSol ?? 0)) existing.peakPriceSol = price;
    if (curve.realSolReserves > (existing.peakRealSol ?? 0)) {
      existing.peakRealSol = curve.realSolReserves;
    }
  }

  recordTrade(mint: string, trade: TradeRecord, curve: CurveState, creator?: string): TokenScore {
    if (!this.states.has(mint)) {
      this.upsertToken(mint, trade.ts, curve, creator);
    }
    const snap = this.states.get(mint)!;
    const price = trade.priceSol ?? computeCurvePrice(curve);
    snap.curve = { ...curve };
    snap.nowTs = Math.max(snap.nowTs, trade.ts);
    snap.trades.push({ ...trade, priceSol: price });
    if (snap.trades.length > this.maxTradesPerToken) {
      snap.trades.splice(0, snap.trades.length - this.maxTradesPerToken);
    }
    if (price > (snap.peakPriceSol ?? 0)) snap.peakPriceSol = price;
    if (curve.realSolReserves > (snap.peakRealSol ?? 0)) {
      snap.peakRealSol = curve.realSolReserves;
    }
    return scoreToken(snap, this.config);
  }

  evaluate(mint: string, nowTs?: number): TokenScore | null {
    const snap = this.states.get(mint);
    if (!snap) return null;
    if (nowTs !== undefined && nowTs > snap.nowTs) {
      snap.nowTs = nowTs;
    }
    return scoreToken(snap, this.config);
  }

  rankTokens(nowTs: number): TokenScore[] {
    const scores: TokenScore[] = [];
    for (const mint of this.states.keys()) {
      const s = this.evaluate(mint, nowTs);
      if (s) scores.push(s);
    }
    scores.sort((a, b) => {
      if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
      return a.mint.localeCompare(b.mint);
    });
    return scores;
  }
}