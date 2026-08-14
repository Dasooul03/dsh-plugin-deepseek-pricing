// dsh-plugin-deepseek-pricing — DeepSeek 官方模型实时定价、会话费用统计与费用预估插件
//
// 单一插件包，提供：
//   - Agent 工具：deepseek_pricing（实时定价查询，峰谷价按 UTC 时间自动判定）、
//     estimate_cost（按输入/输出 token 预估费用）
//   - Web 界面（dsh.client 客户端 bundle，lib/client.js）：侧边栏「DeepSeek 定价」
//     面板 —— 实时价格表、峰谷状态、会话费用（本轮/总花费 + 逐轮明细）、费用预估器
//   - host 路由（lib/ui.js）：GET /api/deepseek-pricing/snapshot 与
//     /api/deepseek-pricing/session-costs
//
// 定价数据来源：
//   - 内置默认表（离线可用，随本插件发布，见 lib/pricing.js 的 DEFAULT_PRICING）
//   - liveSync 开启时从 DeepSeek 官方定价页实时拉取并解析（30 分钟 TTL 缓存，
//     失败自动回退内置表）
//   - config.customPricing 提供完整定价文档覆盖

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  DEFAULT_PRICING,
  PRICE_UNIT,
  estimateCost,
  estimateTokensFromText,
  fetchPricingHtml,
  formatBeijing,
  isPeakUtc,
  knownModels,
  parsePricingHtml,
  resolvePeriodAt,
} from "./pricing.js";
import { registerUiRoutes } from "./ui.js";

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

/** 渲染文本块（output.render 契约）。 */
function textBlock(text) {
  return [{ type: "text", text }];
}

const USD = (n) => `$${n.toFixed(6)}`;


/**
 * 创建共享定价状态：pricing 文档 + liveSync TTL 缓存 + 失败提示。
 * Agent 工具与 Web 路由共用同一份状态与缓存。
 */
function createPricingState(cfg) {
  const custom = resolveCustomPricing(cfg.customPricing);
  const state = {
    pricing: custom ?? DEFAULT_PRICING,
    lastFetch: 0,
    fetchPromise: null,
    fetchFailedNote: "",
  };

  /** 返回当前定价文档；liveSync 开启且缓存过期时先尝试同步（失败回退）。 */
  state.ensureFresh = async function ensureFresh(force) {
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
  };
  return state;
}

/** 注册 Agent 工具（deepseek_pricing / estimate_cost）。 */
function registerPricingTools(ctx, state, cfg) {
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
        const pricing = await state.ensureFresh(args.refresh === true);
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
        const pricing = await state.ensureFresh(false);
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

// 再导出：纯函数与路由常量（供测试与复用）
export * from "./pricing.js";
export { buildSnapshot, computeSessionCosts, COSTS_ROUTE_PATH, ROUTE_PATH } from "./ui.js";

/** 插件入口：注册工具与 Web 路由（webServer 动态注入，headless 下仅工具生效）。 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const state = createPricingState(cfg);
  registerPricingTools(ctx, state, cfg);
  registerUiRoutes(ctx, state, cfg);
}
