// Type definitions for dsh-plugin-deepseek-pricing (runtime entry: lib/index.js)

export interface ModelPrices {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

export interface PricingPeriod {
  id: string;
  label: string;
  from: string | null;
  to: string | null;
  mode: "flat" | "peak-off-peak";
  prices: Record<string, ModelPrices | { offPeak: ModelPrices; peak: ModelPrices }>;
}

export interface PricingDocument {
  source: "bundled" | "live" | "custom";
  fetchedAt: string | null;
  effectiveDate: string | null;
  peakHoursUtc: [number, number][];
  offPeakRatio: number;
  periods: PricingPeriod[];
}

export interface PluginConfig {
  liveSync?: boolean;
  pricingSourceUrl?: string;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
  cnyRate?: number;
  customPricing?: PricingDocument | null;
}

export const name: "deepseek-pricing";
export const inject: ["tools"];
export const Config: unknown;
export const PRICE_UNIT: string;
export const DEFAULT_PRICING: PricingDocument;

export function isPeakUtc(at: Date, peakHoursUtc: [number, number][]): boolean;
export function resolvePeriodAt(pricing: PricingDocument, at: Date): PricingPeriod;
export function pricesFor(
  pricing: PricingDocument,
  model: string,
  at: Date
): { tier: "flat" | "peak" | "off-peak"; tierLabel: string; cacheHit: number; cacheMiss: number; output: number; periodId: string; periodLabel: string };
export function knownModels(pricing: PricingDocument, at: Date): string[];
export function estimateTokensFromText(text: string): number;
export function estimateCost(
  pricing: PricingDocument,
  model: string,
  tokens: { input: number; cacheHitInput: number; output: number },
  at: Date,
  cnyRate?: number
): {
  price: ReturnType<typeof pricesFor>;
  tokens: { input: number; cacheHitInput: number; cacheMissInput: number; output: number };
  costs: {
    inputCacheHitUsd: number;
    inputCacheMissUsd: number;
    outputUsd: number;
    totalUsd: number;
    totalCny: number;
  };
};
export function parsePricingHtml(html: string): PricingDocument;
export function fetchPricingHtml(url: string, timeoutMs: number): Promise<string>;
export function apply(ctx: { tools: { register(definition: unknown): unknown } }, config?: PluginConfig): void;
