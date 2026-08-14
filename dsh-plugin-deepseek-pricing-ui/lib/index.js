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
  knownModels,
  parsePricingHtml,
  pricesFor,
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

/** 会话费用计算路由（与 client.js 约定）。 */
export const COSTS_ROUTE_PATH = "/api/deepseek-pricing/session-costs";

/** 事件时间归一化：存库为毫秒数，内存对象也可能为字符串。 */
function eventTimeMs(event) {
  const t = event?.time;
  if (typeof t === "number") return t;
  if (typeof t === "string") {
    const n = Date.parse(t);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/**
 * 按会话事件日志逐轮计算费用（纯函数，便于测试）。
 *
 * 每一轮（turn）的费用 = 该轮内每个 assistant/message 上报的用量
 * （inputTokens = 缓存未命中输入、cacheReadTokens = 缓存命中输入、
 * outputTokens = 输出）按**该事件自身的 time 时间戳**取当时生效的
 * 峰谷价格逐条计价后求和 —— 峰谷计价按每条消息的实际发生时刻判定。
 *
 * @param pricing 定价文档
 * @param events 会话事件（session 事件日志或持久化读取的 events）
 * @param cnyRate USD→CNY 参考汇率
 * @returns { turns, tokens, totalUsd, totalCny, currentTurn, currentTurnUsd, currentTurnCny, note }
 */
export function computeSessionCosts(pricing, events, cnyRate = DEFAULT_CNY_RATE) {
  const turns = [];
  const total = { input: 0, cacheRead: 0, output: 0, costUsd: 0 };
  let current = null;
  let fallbackModel = null;
  const notes = [];

  const ensureTurn = (turn, atMs) => {
    if (current === null || current.turn !== turn) {
      current = {
        turn,
        startedAt: atMs,
        model: null,
        tokens: { input: 0, cacheRead: 0, output: 0 },
        costUsd: 0,
        tier: null,
        steps: 0,
      };
      turns.push(current);
    }
    if (current.startedAt === null || atMs < current.startedAt) current.startedAt = atMs;
    return current;
  };

  for (const event of events ?? []) {
    const atMs = eventTimeMs(event);
    if (event.type === "turn/start") {
      const turn = event.data?.turn ?? turns.length + 1;
      ensureTurn(turn, atMs);
      continue;
    }
    if (event.type !== "assistant/message") continue;
    const d = event.data ?? {};
    const usage = d.usage;
    if (usage === null || typeof usage !== "object") continue;
    const input = usage.inputTokens ?? 0;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    if (!(input > 0 || cacheRead > 0 || output > 0)) continue;

    const turn = ensureTurn(d.turn ?? current?.turn ?? 1, atMs);
    const model = d.message?.source?.model ?? turn.model;
    turn.model = model;
    turn.steps += 1;

    let price;
    const at = atMs === null ? new Date() : new Date(atMs);
    try {
      price = pricesFor(pricing, model, at);
    } catch {
      // 未知模型（如自定义 provider 的模型）：回退到当前定价表第一个已知模型
      if (fallbackModel === null) {
        fallbackModel = knownModels(pricing, at)[0] ?? null;
        if (fallbackModel !== null && fallbackModel !== model) {
          notes.push(`部分步骤使用了定价表未知的模型 ${JSON.stringify(model)}，已按 ${fallbackModel} 计价`);
        }
      }
      if (fallbackModel === null) continue;
      price = pricesFor(pricing, fallbackModel, at);
    }

    const costUsd =
      (cacheRead / 1e6) * price.cacheHit +
      (input / 1e6) * price.cacheMiss +
      (output / 1e6) * price.output;
    if (!Number.isFinite(costUsd)) continue;

    turn.tokens.input += input;
    turn.tokens.cacheRead += cacheRead;
    turn.tokens.output += output;
    turn.costUsd += costUsd;
    turn.tier = price.tier;
    total.input += input;
    total.cacheRead += cacheRead;
    total.output += output;
    total.costUsd += costUsd;
  }

  const last = turns.at(-1);
  return {
    turns: turns.map((t) => ({
      turn: t.turn,
      startedAt: t.startedAt === null ? null : new Date(t.startedAt).toISOString(),
      model: t.model,
      tokens: { ...t.tokens },
      costUsd: t.costUsd,
      costCny: t.costUsd * cnyRate,
      tier: t.tier,
      steps: t.steps,
    })),
    tokens: { ...total },
    totalUsd: total.costUsd,
    totalCny: total.costUsd * cnyRate,
    currentTurn: last?.turn ?? null,
    currentTurnUsd: last?.costUsd ?? 0,
    currentTurnCny: (last?.costUsd ?? 0) * cnyRate,
    note: notes.join("；"),
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

  ctx.inject(["webServer", "sessions", "sessionPersistence"], (webCtx) => {
    const json = (res, code, body) => {
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body));
    };

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
              json(res, 200, snapshot);
            } catch (error) {
              json(res, 500, { error: String((error && error.message) || error) });
            }
          },
        }),
      "deepseek-pricing-ui: snapshot route"
    );

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: COSTS_ROUTE_PATH,
          handler: async (req, res) => {
            try {
              const sessionId =
                new URL(req.url ?? "/", "http://x").searchParams.get("session") ?? "";
              if (sessionId.length === 0) throw new Error("missing ?session=<sessionId>");
              // 1) 内存中的活动会话优先；2) 否则从持久化日志读取（任意历史会话）
              let events = null;
              const live = webCtx.sessions.get(sessionId);
              if (live !== void 0) {
                events = live.events;
              } else {
                try {
                  const stored = await webCtx.sessionPersistence.readFrom(sessionId, 0);
                  events = stored?.events ?? null;
                } catch (error) {
                  const message = String((error && error.message) || error);
                  if (!message.includes("not found")) throw error;
                }
              }
              if (events === null) throw new Error(`session ${JSON.stringify(sessionId)} not found`);
              const doc = await ensureFresh(false);
              const at = new Date();
              const period = resolvePeriodAt(doc, at);
              const result = computeSessionCosts(doc, events, cnyRate);
              json(res, 200, {
                sessionId,
                computedAt: at.toISOString(),
                pricing: {
                  source: doc.source,
                  fetchedAt: doc.fetchedAt ?? "",
                  status: period.mode === "flat" ? "flat" : isPeakUtc(at, doc.peakHoursUtc) ? "peak" : "off-peak",
                  periodLabel: period.label,
                },
                cnyRate,
                ...result,
              });
            } catch (error) {
              json(res, 500, { error: String((error && error.message) || error) });
            }
          },
        }),
      "deepseek-pricing-ui: session costs route"
    );
  });
}
