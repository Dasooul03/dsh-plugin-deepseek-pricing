// dsh-plugin-deepseek-pricing-ui — host 半边
//
// 职责：向 web 应用注册一个同源只读 JSON 快照路由
//   GET /api/deepseek-pricing/snapshot[?refresh=1]
// 供浏览器端的定价面板（lib/client.js）拉取实时定价。
//
// 定价数据复用 dsh-plugin-deepseek-pricing 的抓取/解析/峰谷判定纯函数，
// 与本包自身的小型 TTL 缓存，独立于工具插件的状态。
//
// 本包同时是一个 loader entry（name: dsh-plugin-deepseek-pricing-ui）：
// 新条目名会被运行中的 web 实例全新加载，无需重启即可生效。

import {
  DEFAULT_PRICING,
  fetchPricingHtml,
  isPeakUtc,
  parsePricingHtml,
  resolvePeriodAt,
} from "dsh-plugin-deepseek-pricing";

export const name = "deepseek-pricing-ui";

/** 快照路由路径（与 client.js 约定）。 */
export const ROUTE_PATH = "/api/deepseek-pricing/snapshot";

/** 默认同步缓存时长（30 分钟）。 */
export const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SOURCE_URL = "https://api-docs.deepseek.com/quick_start/pricing";
const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_CNY_RATE = 7.2;

/** 北京时间显示格式（与工具插件的展示口径一致）。 */
export function formatBeijing(d) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * 组装一次快照（纯函数，便于测试）。
 * @returns 与 client 面板约定的 JSON 结构。
 */
export function buildSnapshot(pricing, at, cnyRate, extraNotes = []) {
  const period = resolvePeriodAt(pricing, at);
  const status = period.mode === "flat" ? "flat" : isPeakUtc(at, pricing.peakHoursUtc) ? "peak" : "off-peak";
  const prices = [];
  for (const model of Object.keys(period.prices)) {
    if (period.mode === "flat") {
      const p = period.prices[model];
      prices.push({
        model,
        tier: "flat",
        tierLabel: "统一价",
        cacheHit: p.cacheHit,
        cacheMiss: p.cacheMiss,
        output: p.output,
      });
    } else {
      const entry = period.prices[model];
      for (const key of Object.keys(entry)) {
        const p = entry[key];
        const tier = key === "peak" ? "peak" : "off-peak";
        prices.push({
          model,
          tier,
          tierLabel: tier === "peak" ? "高峰价" : "谷时价",
          cacheHit: p.cacheHit,
          cacheMiss: p.cacheMiss,
          output: p.output,
        });
      }
    }
  }
  const noteParts = [...extraNotes];
  if (pricing.source !== "live") {
    noteParts.push("价格数据来自内置表，未实时同步官方页面（可在面板点刷新强制同步）");
  }
  return {
    nowUtc: at.toISOString(),
    nowBeijing: formatBeijing(at),
    status,
    applicableTier: status,
    periodId: period.id,
    periodLabel: period.label,
    effectiveDate: pricing.effectiveDate ?? "",
    peakHoursUtc: pricing.peakHoursUtc,
    unit: "USD per 1M tokens",
    prices,
    models: Object.keys(period.prices),
    source: pricing.source,
    fetchedAt: pricing.fetchedAt ?? "",
    cnyRate,
    note: noteParts.join("；"),
  };
}

/** 插件主体：注册快照路由（webServer 动态注入，headless 下无副作用）。 */
export function apply(ctx, config = {}) {
  const liveSync = config.liveSync ?? true;
  const sourceUrl = config.pricingSourceUrl ?? DEFAULT_SOURCE_URL;
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const cnyRate = config.cnyRate ?? DEFAULT_CNY_RATE;

  let pricing = DEFAULT_PRICING;
  let lastFetch = 0;
  let inFlight = null;

  /** 返回当前定价文档；liveSync 开启且缓存过期时先尝试同步（失败回退旧值）。 */
  async function ensureFresh(force) {
    if (!liveSync) return pricing;
    const now = Date.now();
    const stale = force || lastFetch === 0 || now - lastFetch > cacheTtlMs;
    if (!stale) return pricing;
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const html = await fetchPricingHtml(sourceUrl, fetchTimeoutMs);
          pricing = parsePricingHtml(html);
        } catch {
          /* 保留上次成功数据 */
        } finally {
          lastFetch = Date.now();
          inFlight = null;
        }
      })();
    }
    await inFlight;
    return pricing;
  }

  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: ROUTE_PATH,
          handler: async (req, res) => {
            try {
              const refresh =
                new URL(req.url ?? "/", "http://x").searchParams.get("refresh") === "1";
              const doc = await ensureFresh(refresh);
              const snapshot = buildSnapshot(doc, new Date(), cnyRate);
              res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
              });
              res.end(JSON.stringify(snapshot));
            } catch (error) {
              res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: String((error && error.message) || error) }));
            }
          },
        }),
      "deepseek-pricing-ui: snapshot route"
    );
  });
}
