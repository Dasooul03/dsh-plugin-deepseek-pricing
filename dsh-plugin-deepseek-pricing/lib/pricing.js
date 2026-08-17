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

  // 2) 主表价格解析：兼容两种官方结构
  //    旧（统一价阶段）：[指标, $a, $b]
  //    新（峰谷阶段）  ：[指标, OFF-PEAK, $a, $b] + 延续行 [PEAK, $a, $b]（rowspan）
  const MONEY_RE = /^\$[\d,]+(?:\.\d+)?$/;
  const METRICS = ["1M INPUT TOKENS (CACHE HIT)", "1M INPUT TOKENS (CACHE MISS)", "1M OUTPUT TOKENS"];
  const parseMoney = (c) => {
    const n = Number.parseFloat(c.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) throw new Error(`pricing page: bad price cell ${JSON.stringify(c)}`);
    return n;
  };
  const flat = {}; // metric -> 模型价格数组
  const tiers = {}; // metric -> { offPeak: 数组, peak: 数组 }
  const tierKey = (v) => (v === "PEAK" ? "peak" : "offPeak");
  let lastMetric = null;
  for (const r of rows) {
    const idx = r.findIndex((c) => METRIC_RE.test(c));
    if (idx !== -1) {
      lastMetric = r[idx];
      const rest = r.slice(idx + 1);
      if (rest.length === models.length && rest.every((c) => MONEY_RE.test(c))) {
        flat[lastMetric] = rest.map(parseMoney);
      } else if (
        rest.length === models.length + 1 &&
        (rest[0] === "OFF-PEAK" || rest[0] === "PEAK") &&
        rest.slice(1).every((c) => MONEY_RE.test(c))
      ) {
        (tiers[lastMetric] ??= {})[tierKey(rest[0])] = rest.slice(1).map(parseMoney);
      }
    } else if (
      lastMetric !== null &&
      r.length === models.length + 1 &&
      (r[0] === "OFF-PEAK" || r[0] === "PEAK") &&
      r.slice(1).every((c) => MONEY_RE.test(c))
    ) {
      (tiers[lastMetric] ??= {})[tierKey(r[0])] = r.slice(1).map(parseMoney);
    }
  }

  // 3) 旧版脚注峰谷表兜底：行首为模型、第二列为 PEAK/OFF-PEAK 的行（含 rowspan 延续）。
  //    该表以模型为中心（每行含该模型全部三项价格），需转换为指标为中心的 tiers。
  if (Object.keys(tiers).length === 0) {
    const peakTable = new Map(); // model -> { offPeak: {cacheHit,cacheMiss,output}, peak: {...} }
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
    // 模型中心 → 指标中心（数组按下标对齐 models 顺序）
    const METRIC_KEYS = ["cacheHit", "cacheMiss", "output"];
    for (let i = 0; i < models.length; i++) {
      const entry = peakTable.get(models[i]);
      if (entry === void 0 || entry.offPeak === null || entry.peak === null) continue;
      for (let k = 0; k < METRICS.length; k++) {
        (tiers[METRICS[k]] ??= {}).offPeak ??= [];
        (tiers[METRICS[k]] ??= {}).peak ??= [];
        tiers[METRICS[k]].offPeak[i] = entry.offPeak[METRIC_KEYS[k]];
        tiers[METRICS[k]].peak[i] = entry.peak[METRIC_KEYS[k]];
      }
    }
  }

  const flatHit = flat["1M INPUT TOKENS (CACHE HIT)"];
  const flatMiss = flat["1M INPUT TOKENS (CACHE MISS)"];
  const flatOut = flat["1M OUTPUT TOKENS"];
  const hasFlat = !!(flatHit && flatMiss && flatOut);
  const hasTiers = METRICS.every((m) => tiers[m]?.offPeak && tiers[m]?.peak);
  if (!hasFlat && !hasTiers) {
    throw new Error("pricing page: incomplete main pricing table");
  }

  // 4) 脚注：高峰时段（生效时间仅在过渡阶段页面存在，可选）
  const footnote = textOf(html);
  const peakMatch = /Peak hours are (\d{2}):00 - (\d{2}):00 and (\d{2}):00 - (\d{2}):00 UTC/.exec(footnote);
  const effectMatch = /take effect at (\d{2}):00 UTC on ([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(footnote);
  let peakHoursUtc = null;
  let effectiveDate = null;
  if (peakMatch) {
    const [h1, h2, h3, h4] = [peakMatch[1], peakMatch[2], peakMatch[3], peakMatch[4]].map(Number);
    if (h1 < h2 && h3 < h4 && h2 <= 24 && h4 <= 24) {
      peakHoursUtc = [[h1, h2], [h3, h4]];
    }
  }
  if (effectMatch) {
    const month = MONTHS[effectMatch[2].toLowerCase()];
    if (month !== undefined) {
      effectiveDate = new Date(
        Date.UTC(Number(effectMatch[4]), month, Number(effectMatch[3]), Number(effectMatch[1]))
      ).toISOString();
    }
  }

  // 5) 组装定价文档
  const periods = [];
  if (hasFlat) {
    const flatPrices = {};
    for (let i = 0; i < models.length; i++) {
      flatPrices[models[i]] = { cacheHit: flatHit[i], cacheMiss: flatMiss[i], output: flatOut[i] };
    }
    periods.push({
      id: "flat",
      label: "统一计费（峰谷计价生效前）",
      from: null,
      to: hasTiers ? effectiveDate : null,
      mode: "flat",
      prices: flatPrices,
    });
  }
  if (hasTiers) {
    const peakOffPeakPrices = {};
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      peakOffPeakPrices[model] = {
        offPeak: { cacheHit: tiers[METRICS[0]].offPeak[i], cacheMiss: tiers[METRICS[1]].offPeak[i], output: tiers[METRICS[2]].offPeak[i] },
        peak: { cacheHit: tiers[METRICS[0]].peak[i], cacheMiss: tiers[METRICS[1]].peak[i], output: tiers[METRICS[2]].peak[i] },
      };
    }
    periods.push({
      id: "peak-off-peak",
      label: "峰谷计价",
      from: hasFlat ? effectiveDate : null,
      to: null,
      mode: "peak-off-peak",
      prices: peakOffPeakPrices,
    });
  }
  // 6) 历史统一价衔接：峰谷计价生效后的官方页面不再包含过渡期信息，
  //    此时把内置默认表中记录的历史统一价周期（截止官方过渡时间）合并进来，
  //    保证过渡前发生的会话轮次仍按当时的统一价正确计费。
  const mergedPeriods = [...periods];
  if (!mergedPeriods.some((p) => p.mode === "flat")) {
    const historicalFlat = DEFAULT_PRICING.periods.find((p) => p.mode === "flat" && p.to !== null);
    if (historicalFlat !== void 0) {
      const effective = historicalFlat.to;
      mergedPeriods.unshift({ ...historicalFlat });
      const tiered = mergedPeriods.find((p) => p.mode === "peak-off-peak");
      if (tiered !== void 0 && tiered.from === null) tiered.from = effective;
      effectiveDate = effective;
    }
  }
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    effectiveDate,
    peakHoursUtc: peakHoursUtc ?? DEFAULT_PRICING.peakHoursUtc,
    offPeakRatio: 0.5,
    periods: mergedPeriods,
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
// 展示工具
// ---------------------------------------------------------------------------

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
