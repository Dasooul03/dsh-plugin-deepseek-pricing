// dsh-plugin-deepseek-pricing — DeepSeek 官方模型实时定价查询与费用预估
//
// 插件导出 cordis 插件形状 { name, inject, Config, apply }，由 dsh 的 loader
// 按 name 从 profile 的 node_modules 中加载并调用 apply(ctx, config) 注册工具：
//   - deepseek_pricing：查询 DeepSeek 官方模型的实时定价（峰谷价按 UTC 时间自动判定）
//   - estimate_cost：按输入/输出 token 估算一次 API 调用的费用（自动套用当前峰谷价）
//
// 定价数据来源：
//   - 内置默认表（离线可用，随本插件发布）
//   - liveSync 开启时从 DeepSeek 官方定价页实时拉取并解析（30 分钟 TTL 缓存，
//     失败自动回退内置表）
//   - config.customPricing 提供完整定价文档覆盖

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "deepseek-pricing";
export const inject = ["tools"];

/** 插件配置（全部可选，缺省值见下；schemastery 校验后自动填充默认值）。 */
export const Config = z.object({
  /** 是否启用从官方定价页实时同步（开启时按 cacheTtlMs 缓存）。 */
  liveSync: z.boolean().default(true),
  /** 官方定价页地址。 */
  pricingSourceUrl: z
    .string()
    .default("https://api-docs.deepseek.com/quick_start/pricing"),
  /** 实时同步结果的缓存时长（毫秒）。 */
  cacheTtlMs: z.number().default(30 * 60 * 1000),
  /** 拉取定价页的超时（毫秒）。 */
  fetchTimeoutMs: z.number().default(8000),
  /** 估算时 USD → CNY 的参考汇率（仅估算用，非实时汇率）。 */
  cnyRate: z.number().default(7.2),
  /** 完整定价文档覆盖（结构同 DEFAULT_PRICING，见 README）。 */
  customPricing: z.any().default(null),
});

// ---------------------------------------------------------------------------
// 定价数据模型
// ---------------------------------------------------------------------------
//
// 定价文档（PricingDocument）：
// {
//   source: "bundled" | "live",     // 数据来源
//   fetchedAt: string | null,       // 实时同步时间（ISO）
//   effectiveDate: string | null,   // 峰谷计价生效时间（ISO），flat 期结束后切换
//   peakHoursUtc: [[1,4],[6,10]],   // 高峰时段（UTC，半开区间 [start, end)）
//   offPeakRatio: 0.5,              // 谷时价格为峰时的比例
//   periods: [                      // 有序计费周期，按时间覆盖
//     {
//       id, label,
//       from: string | null, to: string | null,
//       mode: "flat" | "peak-off-peak",
//       prices: {
//         "<model>":  flat 模式: { cacheHit, cacheMiss, output }
//         峰谷模式: { offPeak: {...}, peak: {...} }
//       }
//     }
//   ]
// }

/** 单位说明：所有价格为每 1M tokens 的美元单价。 */
export const PRICE_UNIT = "USD per 1M tokens";

/**
 * 内置默认定价（2026-08-14 抓取自 https://api-docs.deepseek.com/quick_start/pricing）。
 * 官方宣布：峰谷计价自 2026-08-16 16:00 UTC 起生效，谷时价格为峰时的一半；
 * 高峰时段为 01:00–04:00 与 06:00–10:00 UTC（其余时间为谷时）。
 */
export const DEFAULT_PRICING = {
  source: "bundled",
  fetchedAt: null,
  effectiveDate: "2026-08-16T16:00:00.000Z",
  peakHoursUtc: [
    [1, 4],
    [6, 10],
  ],
  offPeakRatio: 0.5,
  periods: [
    {
      id: "flat",
      label: "统一计费（峰谷计价生效前）",
      from: null,
      to: "2026-08-16T16:00:00.000Z",
      mode: "flat",
      prices: {
        "deepseek-v4-flash": { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
        "deepseek-v4-pro": { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
      },
    },
    {
      id: "peak-off-peak",
      label: "峰谷计价",
      from: "2026-08-16T16:00:00.000Z",
      to: null,
      mode: "peak-off-peak",
      prices: {
        "deepseek-v4-flash": {
          offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
          peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
        },
        "deepseek-v4-pro": {
          offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
          peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
        },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// 纯函数：时间判定 / 周期解析 / 价格取用
// ---------------------------------------------------------------------------

/** 判断某时刻是否处于高峰时段（UTC，半开区间）。 */
export function isPeakUtc(at, peakHoursUtc) {
  const hour = at.getUTCHours();
  return peakHoursUtc.some(([start, end]) => hour >= start && hour < end);
}

/** 取覆盖时刻 at 的计费周期；无覆盖时回退到最后一个周期。 */
export function resolvePeriodAt(pricing, at) {
  const t = at.getTime();
  for (const period of pricing.periods) {
    const fromOk = period.from === null || new Date(period.from).getTime() <= t;
    const toOk = period.to === null || t < new Date(period.to).getTime();
    if (fromOk && toOk) return period;
  }
  return pricing.periods[pricing.periods.length - 1];
}

/**
 * 取模型 model 在时刻 at 的适用单价。
 * @returns { tier: "flat"|"peak"|"off-peak", tierLabel, cacheHit, cacheMiss, output }
 */
export function pricesFor(pricing, model, at) {
  const period = resolvePeriodAt(pricing, at);
  const entry = period.prices[model];
  if (!entry) {
    throw new Error(
      `unknown model ${JSON.stringify(model)}; known models: ${Object.keys(period.prices).join(", ")}`
    );
  }
  if (period.mode === "flat") {
    return {
      tier: "flat",
      tierLabel: "统一价",
      cacheHit: entry.cacheHit,
      cacheMiss: entry.cacheMiss,
      output: entry.output,
      periodId: period.id,
      periodLabel: period.label,
    };
  }
  const peak = isPeakUtc(at, pricing.peakHoursUtc);
  const variant = peak ? entry.peak : entry.offPeak;
  return {
    tier: peak ? "peak" : "off-peak",
    tierLabel: peak ? "高峰价" : "谷时价",
    cacheHit: variant.cacheHit,
    cacheMiss: variant.cacheMiss,
    output: variant.output,
    periodId: period.id,
    periodLabel: period.label,
  };
}

/** 所有已知模型 id（按当前生效周期）。 */
export function knownModels(pricing, at) {
  const period = resolvePeriodAt(pricing, at);
  return Object.keys(period.prices);
}

// ---------------------------------------------------------------------------
// token 预估启发式（仅当调用方未给出 token 数时使用）
// ---------------------------------------------------------------------------

const CJK_RE = /[\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g;

/**
 * 由文本粗略预估 token 数：CJK 字符约 1.5 字符/token，其余文本约 4 字符/token，
 * 另加固定开销。仅用于估算，精确值应以 tokenizer 计数为准。
 */
export function estimateTokensFromText(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const cjk = (text.match(CJK_RE) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4) + 4;
}

// ---------------------------------------------------------------------------
// 费用估算
// ---------------------------------------------------------------------------

/**
 * 估算一次调用的费用。
 * @param pricing 定价文档
 * @param model 模型 id
 * @param tokens { input, cacheHitInput, output }（均为非负整数；cacheHitInput ≤ input）
 * @param at 计费时刻（默认 now）
 * @param cnyRate USD→CNY 参考汇率
 */
export function estimateCost(pricing, model, tokens, at, cnyRate = 7.2) {
  const { input, cacheHitInput, output } = tokens;
  const price = pricesFor(pricing, model, at);
  const cacheMissInput = input - cacheHitInput;
  const inputCacheHitUsd = (cacheHitInput / 1e6) * price.cacheHit;
  const inputCacheMissUsd = (cacheMissInput / 1e6) * price.cacheMiss;
  const outputUsd = (output / 1e6) * price.output;
  const totalUsd = inputCacheHitUsd + inputCacheMissUsd + outputUsd;
  return {
    price,
    tokens: { input, cacheHitInput, cacheMissInput, output },
    costs: {
      inputCacheHitUsd,
      inputCacheMissUsd,
      outputUsd,
      totalUsd,
      totalCny: totalUsd * cnyRate,
    },
  };
}

// ---------------------------------------------------------------------------
// 官方定价页实时同步（HTML 解析）
// ---------------------------------------------------------------------------

/** 去掉标签，压缩空白。 */
function textOf(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** 把 <tr>…</tr> 拆成单元格文本数组。 */
function rowsOf(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const c of m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
      cells.push(textOf(c[1]));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * 解析官方定价页 HTML（docusaurus 静态页）为定价文档。
 * @throws 页面结构无法识别时抛错（由调用方回退内置表）。
 */
export function parsePricingHtml(html) {
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("pricing page returned empty content");
  }
  const rows = rowsOf(html);

  // 1) 主表模型列：第一个第一列为 MODEL（且第二列不是指标名）的行
  const METRIC_RE = /^1M INPUT TOKENS \(CACHE (HIT|MISS)\)$|^1M OUTPUT TOKENS$/;
  const header = rows.find((r) => r[0] === "MODEL" && r.length >= 3 && !METRIC_RE.test(r[1] ?? ""));
  if (!header) throw new Error("pricing page: MODEL header row not found");
  const models = header.slice(1).filter((c) => c.length > 0 && c !== "MODEL");
  if (models.length === 0) throw new Error("pricing page: no model ids found");

  // 2) 主表价格：行内任意单元格为指标名（兼容 rowspan 布局），其后价格列数 = 模型数
  const metricIndex = new Map(); // metric -> 模型价格数组
  const MONEY_RE = /^\$[\d,]+(?:\.\d+)?$/;
  for (const r of rows) {
    const idx = r.findIndex((c) => METRIC_RE.test(c));
    if (idx === -1) continue;
    const prices = r.slice(idx + 1);
    if (prices.length !== models.length) continue;
    if (!prices.every((c) => MONEY_RE.test(c))) continue;
    metricIndex.set(
      r[idx],
      prices.map((c) => {
        const n = Number.parseFloat(c.replace(/[$,\s]/g, ""));
        if (!Number.isFinite(n) || n < 0) throw new Error(`pricing page: bad price cell ${JSON.stringify(c)}`);
        return n;
      })
    );
  }
  const cacheHit = metricIndex.get("1M INPUT TOKENS (CACHE HIT)");
  const cacheMiss = metricIndex.get("1M INPUT TOKENS (CACHE MISS)");
  const output = metricIndex.get("1M OUTPUT TOKENS");
  if (!cacheHit || !cacheMiss || !output) {
    throw new Error("pricing page: incomplete main pricing table");
  }

  // 3) 脚注：高峰时段 + 生效时间
  const footnote = textOf(html);
  const peakMatch = /Peak hours are (\d{2}):00 - (\d{2}):00 and (\d{2}):00 - (\d{2}):00 UTC/.exec(footnote);
  const effectMatch = /take effect at (\d{2}):00 UTC on ([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(footnote);
  let peakHoursUtc = null;
  let effectiveDate = null;
  if (peakMatch && effectMatch) {
    const [h1, h2, h3, h4] = [peakMatch[1], peakMatch[2], peakMatch[3], peakMatch[4]].map(Number);
    if (h1 < h2 && h3 < h4 && h2 <= 24 && h4 <= 24) {
      peakHoursUtc = [[h1, h2], [h3, h4]];
      const month = MONTHS[effectMatch[2].toLowerCase()];
      if (month !== undefined) {
        const hour = Number(effectMatch[1]);
        const day = Number(effectMatch[3]);
        const year = Number(effectMatch[4]);
        effectiveDate = new Date(Date.UTC(year, month, day, hour)).toISOString();
      }
    }
  }

  // 4) 峰谷表：行首为模型、第二列为 PEAK/OFF-PEAK 的行（模型列 rowspan 延续时，
  //    第二行以 PEAK/OFF-PEAK 开头，模型取上一行）
  const peakTable = new Map(); // model -> { offPeak, peak }
  let lastModel = null;
  const readPrices = (cells) => {
    const p = cells.map((c) => Number.parseFloat(c.replace(/[$,\s]/g, "")));
    if (p.length !== 3 || p.some((n) => !Number.isFinite(n) || n < 0)) return null;
    return { cacheHit: p[0], cacheMiss: p[1], output: p[2] };
  };
  for (const r of rows) {
    let model = null;
    let tier = null;
    let priceCells = null;
    if (models.includes(r[0]) && (r[1] === "PEAK" || r[1] === "OFF-PEAK") && r.length === 5) {
      model = r[0];
      tier = r[1];
      priceCells = r.slice(2);
    } else if ((r[0] === "PEAK" || r[0] === "OFF-PEAK") && r.length === 4 && lastModel !== null) {
      model = lastModel;
      tier = r[0];
      priceCells = r.slice(1);
    } else {
      if (models.includes(r[0])) lastModel = r[0];
      continue;
    }
    const p = readPrices(priceCells);
    if (p === null) continue;
    const entry = peakTable.get(model) ?? { offPeak: null, peak: null };
    entry[tier === "PEAK" ? "peak" : "offPeak"] = p;
    peakTable.set(model, entry);
    lastModel = model;
  }

  // 5) 组装定价文档
  const flatPrices = {};
  for (let i = 0; i < models.length; i++) {
    flatPrices[models[i]] = { cacheHit: cacheHit[i], cacheMiss: cacheMiss[i], output: output[i] };
  }
  const periods = [
    {
      id: "flat",
      label: "统一计费（峰谷计价生效前）",
      from: null,
      to: effectiveDate,
      mode: "flat",
      prices: flatPrices,
    },
  ];
  if (effectiveDate && peakHoursUtc && peakTable.size > 0) {
    const peakOffPeakPrices = {};
    for (const [model, entry] of peakTable) {
      if (entry.offPeak && entry.peak) {
        peakOffPeakPrices[model] = { offPeak: entry.offPeak, peak: entry.peak };
      }
    }
    if (Object.keys(peakOffPeakPrices).length > 0) {
      periods.push({
        id: "peak-off-peak",
        label: "峰谷计价",
        from: effectiveDate,
        to: null,
        mode: "peak-off-peak",
        prices: peakOffPeakPrices,
      });
    }
  }
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    effectiveDate,
    peakHoursUtc: peakHoursUtc ?? DEFAULT_PRICING.peakHoursUtc,
    offPeakRatio: 0.5,
    periods,
  };
}

/** 拉取官方定价页文本（带超时）。 */
export async function fetchPricingHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "dsh-plugin-deepseek-pricing/0.1" },
    });
    if (!res.ok) throw new Error(`pricing page HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/** 归一化配置（Config 校验已填默认值，这里再兜底一次）。 */
function normalizeConfig(config) {
  const c = config ?? {};
  return {
    liveSync: c.liveSync ?? true,
    pricingSourceUrl: c.pricingSourceUrl ?? "https://api-docs.deepseek.com/quick_start/pricing",
    cacheTtlMs: c.cacheTtlMs ?? 30 * 60 * 1000,
    fetchTimeoutMs: c.fetchTimeoutMs ?? 8000,
    cnyRate: c.cnyRate ?? 7.2,
    customPricing: c.customPricing ?? null,
  };
}

/** 校验并取用配置中的自定义定价文档。 */
function resolveCustomPricing(custom) {
  if (custom === null || custom === undefined) return null;
  if (typeof custom !== "object" || !Array.isArray(custom.periods) || custom.periods.length === 0) {
    throw new Error(
      "config.customPricing must be a pricing document with a non-empty `periods` array (see README)"
    );
  }
  return { ...DEFAULT_PRICING, ...custom, source: "custom" };
}

function parseAt(raw, label = "at") {
  if (raw === undefined || raw === null || raw === "") return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid ${label} time ${JSON.stringify(raw)}: expected an ISO 8601 timestamp`);
  }
  return d;
}

function formatBeijing(d) {
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

/** 渲染文本块（output.render 契约）。 */
function textBlock(text) {
  return [{ type: "text", text }];
}

const USD = (n) => `$${n.toFixed(6)}`;

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const custom = resolveCustomPricing(cfg.customPricing);
  const state = {
    pricing: custom ?? DEFAULT_PRICING,
    lastFetch: 0,
    fetchPromise: null,
    fetchFailedNote: "",
  };

  /** 返回当前定价文档；liveSync 开启且缓存过期时先尝试同步（失败回退）。 */
  async function ensureFresh(force) {
    if (!cfg.liveSync || custom) return state.pricing;
    const now = Date.now();
    const stale = force || state.lastFetch === 0 || now - state.lastFetch > cfg.cacheTtlMs;
    if (!stale) return state.pricing;
    if (!state.fetchPromise) {
      state.fetchPromise = (async () => {
        try {
          const html = await fetchPricingHtml(cfg.pricingSourceUrl, cfg.fetchTimeoutMs);
          const doc = parsePricingHtml(html);
          state.pricing = doc;
          state.fetchFailedNote = "";
        } catch (error) {
          state.fetchFailedNote = `官方定价页同步失败(${error.message})，已使用上次/内置数据`;
        } finally {
          state.lastFetch = Date.now();
          state.fetchPromise = null;
        }
      })();
    }
    await state.fetchPromise;
    return state.pricing;
  }

  function modelFilter(pricing, model) {
    if (model === undefined || model === null || model === "") return null;
    const at = new Date();
    if (!knownModels(pricing, at).includes(model)) {
      throw new Error(
        `unknown model ${JSON.stringify(model)}; known models: ${knownModels(pricing, at).join(", ")}`
      );
    }
    return model;
  }

  // ---- deepseek_pricing：查询实时定价 ------------------------------------
  ctx.tools.register(
    defineTool({
      name: "deepseek_pricing",
      description:
        "Query real-time DeepSeek API pricing (USD per 1M tokens, cache-hit / cache-miss input and output). " +
        "Peak/off-peak billing is applied automatically from the current UTC time: peak hours are 01:00-04:00 and 06:00-10:00 UTC, " +
        "all other hours are off-peak at half the peak rates; before the official effective date a flat price applies. " +
        "Optionally refresh from the official pricing page (live sync) or evaluate a different moment with `at`. " +
        "Use estimate_cost to compute the cost of a call.",
      parameters: {
        model: {
          type: "string",
          description: "Optional model id filter (e.g. deepseek-v4-flash). Omit to list every model.",
        },
        at: {
          type: "string",
          description: "Optional ISO 8601 timestamp to evaluate peak/off-peak status for, instead of now.",
        },
        refresh: {
          type: "boolean",
          description: "Force a live re-fetch from the official pricing page before answering.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            nowUtc: { type: "string", required: true },
            nowBeijing: { type: "string", required: true },
            status: { type: "string", required: true, enum: ["flat", "peak", "off-peak"] },
            applicableTier: { type: "string", required: true, enum: ["flat", "peak", "off-peak"] },
            periodId: { type: "string", required: true },
            periodLabel: { type: "string", required: true },
            effectiveDate: { type: "string", required: true },
            peakHoursUtc: {
              type: "array",
              required: true,
              items: { type: "array", items: { type: "integer" } },
            },
            unit: { type: "string", required: true },
            prices: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  model: { type: "string", required: true },
                  tier: { type: "string", required: true, enum: ["flat", "peak", "off-peak"] },
                  tierLabel: { type: "string", required: true },
                  cacheHit: { type: "number", required: true },
                  cacheMiss: { type: "number", required: true },
                  output: { type: "number", required: true },
                },
              },
            },
            source: { type: "string", required: true, enum: ["bundled", "live", "custom"] },
            fetchedAt: { type: "string", required: true },
            note: { type: "string", required: true },
          },
        },
        render: (args, value) => {
          const lines = [
            `DeepSeek 实时定价（${PRICE_UNIT}）`,
            `当前状态: ${value.status === "flat" ? "统一计费" : value.status === "peak" ? "高峰时段" : "谷时时段"} · ${value.periodLabel} · 数据源: ${value.source}`,
            `UTC 时间: ${value.nowUtc} · 北京时间: ${value.nowBeijing}`,
            `生效日期: ${value.effectiveDate ?? "—"} · 高峰时段(UTC): ${value.peakHoursUtc.map(([a, b]) => `${a}:00-${b}:00`).join(", ")}`,
          ];
          for (const p of value.prices) {
            lines.push(
              `${p.model} [${p.tierLabel}]: 输入(缓存命中) ${USD(p.cacheHit)} · 输入(缓存未命中) ${USD(p.cacheMiss)} · 输出 ${USD(p.output)}`
            );
          }
          if (value.note) lines.push(`注意: ${value.note}`);
          return textBlock(lines.join("\n"));
        },
      },
      execute: async (args) => {
        const at = parseAt(args.at);
        const pricing = await ensureFresh(args.refresh === true);
        const filter = modelFilter(pricing, args.model);
        const prices = [];
        const period = resolvePeriodAt(pricing, at);
        for (const model of Object.keys(period.prices)) {
          if (filter && filter !== model) continue;
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
              const tier = key === "peak" ? "peak" : "off-peak";
              const p = entry[key];
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
        const status = period.mode === "flat" ? "flat" : isPeakUtc(at, pricing.peakHoursUtc) ? "peak" : "off-peak";
        const noteParts = [];
        if (state.fetchFailedNote) noteParts.push(state.fetchFailedNote);
        if (pricing.source !== "live") {
          noteParts.push("价格数据来自内置表，未实时同步官方页面（开启 liveSync 或传 refresh: true 可同步）");
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
          unit: PRICE_UNIT,
          prices,
          source: pricing.source,
          fetchedAt: pricing.fetchedAt ?? "",
          note: noteParts.join("；"),
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: "查询 DeepSeek 实时定价",
        kind: "other",
        rawInput: args,
      }),
      isConcurrencySafe: () => true,
    })
  );

  // ---- estimate_cost：预估一次调用的费用 ----------------------------------
  ctx.tools.register(
    defineTool({
      name: "estimate_cost",
      description:
        "Estimate the USD/CNY cost of one DeepSeek API call for a given model: input tokens (split into context-cache-hit and cache-miss) and output tokens, priced at the rates currently in effect (peak/off-peak aware by UTC time). " +
        "Pass explicit token counts, or pass `text` to have the input tokens roughly estimated from text length. " +
        "Combine with deepseek_pricing for the underlying rates.",
      parameters: {
        model: { type: "string", required: true, description: "Model id, e.g. deepseek-v4-flash." },
        inputTokens: {
          type: "integer",
          description: "Total input tokens (>= 0). Omit to estimate from `text` instead.",
        },
        outputTokens: { type: "integer", description: "Output tokens (>= 0, default 0)." },
        cacheHitInputTokens: {
          type: "integer",
          description: "Portion of input tokens served from the context cache (>= 0, default 0, must not exceed inputTokens).",
        },
        text: {
          type: "string",
          description: "Prompt text used to roughly estimate input tokens when inputTokens is omitted (heuristic, not a tokenizer).",
        },
        at: {
          type: "string",
          description: "Optional ISO 8601 timestamp to price for, instead of now.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string", required: true },
            tier: { type: "string", required: true, enum: ["flat", "peak", "off-peak"] },
            tierLabel: { type: "string", required: true },
            periodLabel: { type: "string", required: true },
            unit: { type: "string", required: true },
            prices: {
              type: "object",
              additionalProperties: false,
              required: true,
              properties: {
                cacheHit: { type: "number", required: true },
                cacheMiss: { type: "number", required: true },
                output: { type: "number", required: true },
              },
            },
            tokens: {
              type: "object",
              additionalProperties: false,
              required: true,
              properties: {
                input: { type: "integer", required: true },
                cacheHitInput: { type: "integer", required: true },
                cacheMissInput: { type: "integer", required: true },
                output: { type: "integer", required: true },
                inputEstimatedFromText: { type: "boolean", required: true },
              },
            },
            costs: {
              type: "object",
              additionalProperties: false,
              required: true,
              properties: {
                inputCacheHitUsd: { type: "number", required: true },
                inputCacheMissUsd: { type: "number", required: true },
                outputUsd: { type: "number", required: true },
                totalUsd: { type: "number", required: true },
                totalCny: { type: "number", required: true },
              },
            },
            cnyRate: { type: "number", required: true },
            source: { type: "string", required: true, enum: ["bundled", "live", "custom"] },
            fetchedAt: { type: "string", required: true },
            note: { type: "string", required: true },
          },
        },
        render: (args, value) => {
          const lines = [
            `预估费用 · ${value.model} · ${value.tierLabel}(${value.periodLabel}) · 数据源: ${value.source}`,
            `单价(${value.unit}): 输入缓存命中 ${USD(value.prices.cacheHit)} · 缓存未命中 ${USD(value.prices.cacheMiss)} · 输出 ${USD(value.prices.output)}`,
            `Token 数: 输入 ${value.tokens.input}${value.tokens.inputEstimatedFromText ? "(由文本预估)" : ""}（缓存命中 ${value.tokens.cacheHitInput} / 未命中 ${value.tokens.cacheMissInput}）· 输出 ${value.tokens.output}`,
            `费用: 输入缓存命中 ${USD(value.costs.inputCacheHitUsd)} · 输入缓存未命中 ${USD(value.costs.inputCacheMissUsd)} · 输出 ${USD(value.costs.outputUsd)}`,
            `合计: ${USD(value.costs.totalUsd)} ≈ ¥${value.costs.totalCny.toFixed(4)}（参考汇率 ${value.cnyRate}，仅估算）`,
          ];
          if (value.note) lines.push(`注意: ${value.note}`);
          return textBlock(lines.join("\n"));
        },
      },
      execute: async (args) => {
        const at = parseAt(args.at);
        const pricing = await ensureFresh(false);
        if (!knownModels(pricing, at).includes(args.model)) {
          throw new Error(
            `unknown model ${JSON.stringify(args.model)}; known models: ${knownModels(pricing, at).join(", ")}`
          );
        }
        let input = args.inputTokens;
        let inputEstimated = false;
        if (input === undefined || input === null) {
          if (typeof args.text !== "string" || args.text.length === 0) {
            throw new Error("estimate_cost: provide inputTokens, or text to estimate input tokens from");
          }
          input = estimateTokensFromText(args.text);
          inputEstimated = true;
        }
        const output = args.outputTokens ?? 0;
        const cacheHit = args.cacheHitInputTokens ?? 0;
        for (const [label, n] of [["inputTokens", input], ["outputTokens", output], ["cacheHitInputTokens", cacheHit]]) {
          if (!Number.isInteger(n) || n < 0) {
            throw new Error(`estimate_cost: ${label} must be a non-negative integer (got ${JSON.stringify(n)})`);
          }
        }
        if (cacheHit > input) {
          throw new Error(
            `estimate_cost: cacheHitInputTokens (${cacheHit}) must not exceed inputTokens (${input})`
          );
        }
        const result = estimateCost(pricing, args.model, { input, cacheHitInput: cacheHit, output }, at, cfg.cnyRate);
        const noteParts = [];
        if (inputEstimated) {
          noteParts.push("输入 token 由文本长度粗略预估（非 tokenizer 精确计数），实际费用以账单为准");
        }
        if (pricing.source !== "live") {
          noteParts.push("价格数据来自内置表，未实时同步官方页面（开启 liveSync 可同步）");
        }
        return {
          model: args.model,
          tier: result.price.tier,
          tierLabel: result.price.tierLabel,
          periodLabel: result.price.periodLabel,
          unit: PRICE_UNIT,
          prices: {
            cacheHit: result.price.cacheHit,
            cacheMiss: result.price.cacheMiss,
            output: result.price.output,
          },
          tokens: {
            input,
            cacheHitInput: cacheHit,
            cacheMissInput: result.tokens.cacheMissInput,
            output,
            inputEstimatedFromText: inputEstimated,
          },
          costs: result.costs,
          cnyRate: cfg.cnyRate,
          source: pricing.source,
          fetchedAt: pricing.fetchedAt ?? "",
          note: noteParts.join("；"),
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: "预估 DeepSeek 调用费用",
        kind: "other",
        rawInput: args,
      }),
      isConcurrencySafe: () => true,
    })
  );
}
