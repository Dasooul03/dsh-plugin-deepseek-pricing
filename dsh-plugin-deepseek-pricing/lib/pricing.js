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
