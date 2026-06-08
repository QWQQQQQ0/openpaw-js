// Region quality auto-validation — tracks per-tick metrics and scores region reliability.
// "LLM proposes candidates, program validates."

import type { TickQualityData, RegionQualityMetrics } from '@/types/watcher';

export class RegionQualityTracker {
  private static readonly WINDOW_SIZE = 50;
  private static readonly EVAL_INTERVAL = 20;
  private static readonly QUALITY_THRESHOLD = 0.30;
  private static readonly CRITICAL_THRESHOLD = 0.15;
  private static readonly MIN_TICKS_FOR_EVAL = 20;

  private static readonly WEIGHTS = {
    ocr: 0.25,
    changeFreq: 0.25,
    staticRatio: 0.25,
    jitter: 0.15,
    stability: 0.10,
  };

  private ticks: TickQualityData[] = [];
  private evaluationCount = 0;
  private consecutiveUnchanged = 0;
  private maxConsecutiveUnchanged = 0;
  private postChangeUnchangedTicks = 0;
  private inChangeSequence = false;
  private settleDurations: number[] = [];
  private useOcr: boolean;

  constructor(options: { useOcr?: boolean } = {}) {
    this.useOcr = options.useOcr ?? false;
  }

  get tickCount(): number {
    return this.ticks.length;
  }

  recordTick(data: TickQualityData): void {
    this.ticks.push(data);
    if (this.ticks.length > RegionQualityTracker.WINDOW_SIZE) {
      this.ticks.shift();
    }

    if (data.changed) {
      // Record settle duration if we were in a post-change sequence
      if (this.inChangeSequence) {
        this.settleDurations.push(this.postChangeUnchangedTicks);
        if (this.settleDurations.length > 20) this.settleDurations.shift();
      }
      this.consecutiveUnchanged = 0;
      this.inChangeSequence = true;
      this.postChangeUnchangedTicks = 0;
    } else {
      this.consecutiveUnchanged++;
      if (this.consecutiveUnchanged > this.maxConsecutiveUnchanged) {
        this.maxConsecutiveUnchanged = this.consecutiveUnchanged;
      }
      if (this.inChangeSequence) {
        this.postChangeUnchangedTicks++;
      }
    }
  }

  shouldEvaluate(): boolean {
    return this.ticks.length >= RegionQualityTracker.MIN_TICKS_FOR_EVAL
      && this.ticks.length % RegionQualityTracker.EVAL_INTERVAL === 0;
  }

  evaluate(): { shouldReresolve: boolean; critical: boolean; metrics: RegionQualityMetrics } {
    this.evaluationCount++;
    const metrics = this.getMetrics();
    const shouldReresolve = metrics.qualityScore < RegionQualityTracker.QUALITY_THRESHOLD;
    const critical = metrics.qualityScore < RegionQualityTracker.CRITICAL_THRESHOLD;


    return { shouldReresolve, critical, metrics };
  }

  getMetrics(): RegionQualityMetrics {
    const n = this.ticks.length;
    if (n === 0) {
      return { ocrSuccessRate: 1, changeFrequency: 0, staticRatio: 1, jitterRate: 0, diffStability: 1, qualityScore: 1, tickCount: 0, evaluationCount: this.evaluationCount };
    }

    const ocrScore = this.computeOcrScore();
    const changeFreqScore = this.computeChangeFrequencyScore();
    const staticScore = this.computeStaticScore();
    const jitterScore = this.computeJitterScore();
    const stabilityScore = this.computeStabilityScore();

    const w = RegionQualityTracker.WEIGHTS;
    const qualityScore = w.ocr * ocrScore + w.changeFreq * changeFreqScore + w.staticRatio * staticScore + w.jitter * jitterScore + w.stability * stabilityScore;

    const changedCount = this.ticks.filter(t => t.changed).length;

    return {
      ocrSuccessRate: ocrScore,
      changeFrequency: changedCount / n,
      staticRatio: this.maxConsecutiveUnchanged / RegionQualityTracker.WINDOW_SIZE,
      jitterRate: this.ticks.filter(t => t.jitter).length / n,
      diffStability: stabilityScore,
      qualityScore,
      tickCount: n,
      evaluationCount: this.evaluationCount,
    };
  }

  reset(): void {
    this.ticks = [];
    this.evaluationCount = 0;
    this.consecutiveUnchanged = 0;
    this.maxConsecutiveUnchanged = 0;
    this.postChangeUnchangedTicks = 0;
    this.inChangeSequence = false;
    this.settleDurations = [];
  }

  // ── Sub-score computations ──

  private computeOcrScore(): number {
    if (!this.useOcr) return 1.0;
    const successes = this.ticks.filter(t => t.ocrSuccess).length;
    return successes / this.ticks.length;
  }

  private computeChangeFrequencyScore(): number {
    const ratio = this.ticks.filter(t => t.changed).length / this.ticks.length;
    if (ratio < 0.01) return 0.2;  // dead/stale
    if (ratio < 0.05) return lerp(0.2, 0.7, (ratio - 0.01) / 0.04);
    if (ratio < 0.40) return lerp(0.7, 1.0, (ratio - 0.05) / 0.35);
    if (ratio < 0.80) return lerp(1.0, 0.5, (ratio - 0.40) / 0.40);
    return 0.2; // too noisy
  }

  private computeStaticScore(): number {
    const r = this.maxConsecutiveUnchanged / RegionQualityTracker.WINDOW_SIZE;
    if (r < 0.30) return 1.0;
    if (r < 0.70) return lerp(1.0, 0.3, (r - 0.30) / 0.40);
    return 0.1;
  }

  private computeJitterScore(): number {
    const jitterRatio = this.ticks.filter(t => t.jitter).length / this.ticks.length;
    if (jitterRatio < 0.10) return 1.0;
    if (jitterRatio < 0.50) return lerp(1.0, 0.3, (jitterRatio - 0.10) / 0.40);
    return 0.1;
  }

  private computeStabilityScore(): number {
    if (this.settleDurations.length === 0) return 1.0;
    const avg = this.settleDurations.reduce((a, b) => a + b, 0) / this.settleDurations.length;
    const normalized = Math.min(avg / RegionQualityTracker.WINDOW_SIZE, 1.0);
    return 1.0 - normalized * 0.7; // range 0.3..1.0
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}
