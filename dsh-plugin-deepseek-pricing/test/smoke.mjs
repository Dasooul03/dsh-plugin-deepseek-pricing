// dsh-plugin-deepseek-pricing 冒烟测试：纯逻辑验证（不依赖 dsh 运行时）
// 运行: node test/smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as pricingModule from "../lib/index.js";
import {
  Config,
  DEFAULT_PRICING,
  isPeakUtc,
  resolvePeriodAt,
  pricesFor,
  knownModels,
  estimateTokensFromText,
  estimateCost,
  parsePricingHtml,
  apply,
} from "../lib/index.js";

let passed = 0;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ---- 配置 schema 校验与默认值 -------------------------------------------
ok("Config 校验填充默认值", () => {
  const r = Config["~standard"].validate({});
  assert.equal(r.value.liveSync, true);
  assert.equal(r.value.cacheTtlMs, 30 * 60 * 1000);
  assert.equal(r.value.cnyRate, 7.2);
  const r2 = Config["~standard"].validate(undefined);
  assert.equal(r2.value.liveSync, true);
  const bad = Config["~standard"].validate({ liveSync: "yes" });
  assert.ok(bad.issues?.length > 0, "类型错误应报 issues");
});

// ---- 峰谷时间判定 -------------------------------------------------------
ok("峰谷时段判定（UTC 半开区间）", () => {
  const peak = DEFAULT_PRICING.peakHoursUtc;
  assert.equal(isPeakUtc(new Date("2026-08-14T02:30:00Z"), peak), true, "01-04 峰");
  assert.equal(isPeakUtc(new Date("2026-08-14T03:59:00Z"), peak), true);
  assert.equal(isPeakUtc(new Date("2026-08-14T04:00:00Z"), peak), false, "04:00 起谷");
  assert.equal(isPeakUtc(new Date("2026-08-14T06:30:00Z"), peak), true, "06-10 峰");
  assert.equal(isPeakUtc(new Date("2026-08-14T09:59:00Z"), peak), true);
  assert.equal(isPeakUtc(new Date("2026-08-14T10:00:00Z"), peak), false, "10:00 起谷");
  assert.equal(isPeakUtc(new Date("2026-08-14T12:00:00Z"), peak), false, "中午谷");
  assert.equal(isPeakUtc(new Date("2026-08-14T00:30:00Z"), peak), false, "凌晨 00:30 谷");
});

// ---- 周期切换 -----------------------------------------------------------
ok("峰谷计价生效前后周期切换", () => {
  const before = new Date("2026-08-16T15:59:59Z");
  const after = new Date("2026-08-16T16:00:00Z");
  assert.equal(resolvePeriodAt(DEFAULT_PRICING, before).mode, "flat");
  assert.equal(resolvePeriodAt(DEFAULT_PRICING, after).mode, "peak-off-peak");
  const p1 = pricesFor(DEFAULT_PRICING, "deepseek-v4-flash", before);
  assert.deepEqual(
    { cacheHit: p1.cacheHit, cacheMiss: p1.cacheMiss, output: p1.output },
    { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 }
  );
  const p2 = pricesFor(DEFAULT_PRICING, "deepseek-v4-flash", new Date("2026-08-17T02:00:00Z"));
  assert.equal(p2.tier, "peak");
  assert.deepEqual(
    { cacheHit: p2.cacheHit, cacheMiss: p2.cacheMiss, output: p2.output },
    { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 }
  );
  const p3 = pricesFor(DEFAULT_PRICING, "deepseek-v4-pro", new Date("2026-08-17T12:00:00Z"));
  assert.equal(p3.tier, "off-peak");
  assert.deepEqual(
    { cacheHit: p3.cacheHit, cacheMiss: p3.cacheMiss, output: p3.output },
    { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }
  );
});

ok("未知模型报错", () => {
  assert.throws(() => pricesFor(DEFAULT_PRICING, "gpt-5", new Date()), /unknown model/);
});

// ---- token 预估启发式 ---------------------------------------------------
ok("文本 token 预估启发式", () => {
  assert.equal(estimateTokensFromText(""), 0);
  const t = estimateTokensFromText("你好，这是一段中文测试文本。".repeat(10));
  assert.ok(t > 20 && t < 300, `合理区间, got ${t}`);
  const en = estimateTokensFromText("The quick brown fox jumps over the lazy dog. ".repeat(10));
  assert.ok(en > 30 && en < 150, `合理区间, got ${en}`);
});

// ---- 费用估算 -----------------------------------------------------------
ok("费用估算数学（谷时 flash）", () => {
  const at = new Date("2026-08-17T12:00:00Z"); // 谷时
  const r = estimateCost(DEFAULT_PRICING, "deepseek-v4-flash", { input: 10000, cacheHitInput: 3000, output: 2000 }, at, 7.2);
  const inputHit = (3000 / 1e6) * 0.007;
  const inputMiss = (7000 / 1e6) * 0.22;
  const output = (2000 / 1e6) * 0.66;
  assert.ok(Math.abs(r.costs.inputCacheHitUsd - inputHit) < 1e-12);
  assert.ok(Math.abs(r.costs.inputCacheMissUsd - inputMiss) < 1e-12);
  assert.ok(Math.abs(r.costs.outputUsd - output) < 1e-12);
  assert.ok(Math.abs(r.costs.totalUsd - (inputHit + inputMiss + output)) < 1e-12);
  assert.ok(Math.abs(r.costs.totalCny - r.costs.totalUsd * 7.2) < 1e-9);
});

// ---- 官方定价页解析（用抓取的真实页面） ---------------------------------
ok("解析官方定价页 HTML", () => {
  const htmlPath = process.env.DS_PRICING_HTML;
  if (!htmlPath) {
    console.log("    跳过（未提供 DS_PRICING_HTML）");
    return;
  }
  const html = readFileSync(htmlPath, "utf8");
  const doc = parsePricingHtml(html);
  assert.equal(doc.source, "live");
  assert.equal(doc.effectiveDate, "2026-08-16T16:00:00.000Z");
  assert.deepEqual(doc.peakHoursUtc, [[1, 4], [6, 10]]);
  assert.equal(doc.periods.length, 2);
  const flat = doc.periods[0];
  assert.deepEqual(flat.prices["deepseek-v4-flash"], { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 });
  assert.deepEqual(flat.prices["deepseek-v4-pro"], { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 });
  const po = doc.periods[1];
  assert.deepEqual(po.prices["deepseek-v4-flash"].peak, { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 });
  assert.deepEqual(po.prices["deepseek-v4-flash"].offPeak, { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 });
  assert.deepEqual(po.prices["deepseek-v4-pro"].peak, { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 });
});

ok("解析峰谷主表结构（官方新页面：无过渡期）", () => {
  const html = [
    "<html><body><table>",
    "<tr><td>MODEL</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr>",
    "<tr><td rowspan=\"6\">PRICING<sup>(1)</sup></td><td rowspan=\"2\">1M INPUT TOKENS (CACHE HIT)</td><td>OFF-PEAK</td><td>$0.007</td><td>$0.022</td></tr>",
    "<tr><td>PEAK</td><td>$0.014</td><td>$0.044</td></tr>",
    "<tr><td rowspan=\"2\">1M INPUT TOKENS (CACHE MISS)</td><td>OFF-PEAK</td><td>$0.22</td><td>$0.66</td></tr>",
    "<tr><td>PEAK</td><td>$0.44</td><td>$1.32</td></tr>",
    "<tr><td rowspan=\"2\">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.66</td><td>$1.98</td></tr>",
    "<tr><td>PEAK</td><td>$1.32</td><td>$3.96</td></tr>",
    "</table>",
    "<p>(1) Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC (all other hours are off-peak).</p>",
    "</body></html>",
  ].join("");
  const doc = parsePricingHtml(html);
  // 峰谷主表 + 内置历史统一价衔接（过渡前轮次按统一价计费）
  assert.equal(doc.periods.length, 2);
  assert.equal(doc.periods[0].mode, "flat");
  assert.equal(doc.periods[0].to, "2026-08-16T16:00:00.000Z");
  assert.equal(doc.periods[1].mode, "peak-off-peak");
  assert.equal(doc.periods[1].from, "2026-08-16T16:00:00.000Z");
  assert.equal(doc.periods[1].to, null);
  assert.equal(doc.effectiveDate, "2026-08-16T16:00:00.000Z");
  assert.deepEqual(doc.peakHoursUtc, [[1, 4], [6, 10]]);
  const flash = doc.periods[1].prices["deepseek-v4-flash"];
  assert.deepEqual(flash.offPeak, { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 });
  assert.deepEqual(flash.peak, { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 });
  assert.deepEqual(doc.periods[1].prices["deepseek-v4-pro"].peak, { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 });
  // 过渡前（08-14）→ 统一价；峰谷生效后按时间走档位
  const p = pricesFor(doc, "deepseek-v4-flash", new Date("2026-08-14T08:00:00Z"));
  assert.equal(p.tier, "flat");
  assert.equal(p.cacheMiss, 0.14);
  const p2 = pricesFor(doc, "deepseek-v4-flash", new Date("2026-08-17T03:00:00Z"));
  assert.equal(p2.tier, "peak");
  const p3 = pricesFor(doc, "deepseek-v4-flash", new Date("2026-08-17T12:00:00Z"));
  assert.equal(p3.tier, "off-peak");
});

// 真实抓取的官方新页面（可选，存在 DS_PRICING_HTML_NOW 时执行）
ok("解析真实官方新页面（峰谷主表）", () => {
  const htmlPath = process.env.DS_PRICING_HTML_NOW;
  if (!htmlPath) {
    console.log("    跳过（未提供 DS_PRICING_HTML_NOW）");
    return;
  }
  const doc = parsePricingHtml(readFileSync(htmlPath, "utf8"));
  assert.equal(doc.periods.length, 2);
  assert.equal(doc.periods[0].mode, "flat");
  assert.equal(doc.periods[1].mode, "peak-off-peak");
  const flash = doc.periods[1].prices["deepseek-v4-flash"];
  assert.deepEqual(flash.offPeak, { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 });
  assert.deepEqual(flash.peak, { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 });
});

ok("空页面解析报错", () => {
  assert.throws(() => parsePricingHtml(""), /empty/);
  assert.throws(() => parsePricingHtml("<html><body>no tables</body></html>"), /MODEL header row/);
});

// ---- apply() 在最小 ctx 上注册两个工具 ----------------------------------
ok("峰谷周期下 deepseek_pricing 工具执行（offPeak 键回归）", async () => {
  const registered = [];
  apply({ tools: { register: (d) => registered.push(d) }, inject: () => {} }, { liveSync: false });
  const tool = registered.find((d) => d.name === "deepseek_pricing");
  const r = await tool.execute({ at: "2026-08-17T12:00:00Z" }, {});
  assert.equal(r.status, "off-peak");
  assert.equal(r.prices.length, 4); // 2 模型 × 2 档
  const flashOff = r.prices.find((p) => p.model === "deepseek-v4-flash" && p.tier === "off-peak");
  assert.deepEqual(
    { cacheHit: flashOff.cacheHit, cacheMiss: flashOff.cacheMiss, output: flashOff.output },
    { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 }
  );
  // render 也应工作
  const blocks = tool.output.render({}, r);
  assert.ok(blocks[0].text.includes("谷时"));
});

ok("apply 注册 deepseek_pricing 与 estimate_cost", () => {  const registered = [];
  const fakeCtx = {
    tools: { register: (def) => registered.push(def) },
    inject: () => {},
  };
  apply(fakeCtx, {});
  assert.deepEqual(registered.map((d) => d.name).sort(), ["deepseek_pricing", "estimate_cost"]);
  // 工具定义可用
  for (const def of registered) {
    assert.equal(typeof def.execute, "function");
    assert.ok(def.output?.schema?.type === "object");
    assert.equal(typeof def.output.render, "function");
  }
});

console.log(`\n全部 ${passed} 项冒烟测试通过 ✅`);

// ---- Web 界面（host 路由 + client bundle）----
// P 即合并后插件模块本身
const P = pricingModule;

// ---- 会话费用计算 ---------------------------------------------------------
ok("computeSessionCosts 按时间戳逐轮计价", () => {
  const { DEFAULT_PRICING } = P;
  // 合成事件：峰谷生效后 高峰时刻 与 谷时时刻 各一条消息（验证按时间取价）
  const events = [
    { type: "turn/start", time: 1786696174303, data: { turn: 1 } },
    { type: "assistant/message", time: new Date("2026-08-17T02:00:00Z").getTime(), data: {
        turn: 1, step: 1,
        usage: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 },
        message: { source: { model: "deepseek-v4-flash" } },
    } },
    { type: "turn/end", time: 1786696186127, data: { turn: 1 } },
    { type: "turn/start", time: 1786696186128, data: { turn: 2 } },
    { type: "assistant/message", time: new Date("2026-08-17T12:00:00Z").getTime(), data: {
        turn: 2, step: 1,
        usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100 },
        message: { source: { model: "deepseek-v4-flash" } },
    } },
  ];
  const r = P.computeSessionCosts(DEFAULT_PRICING, events, 7.2);
  assert.equal(r.turns.length, 2);
  // 轮 1 高峰价：500 命中×0.014/M + 1000 未命中×0.44/M + 200 输出×1.32/M
  const t1 = r.turns[0];
  const expect1 = (500 / 1e6) * 0.014 + (1000 / 1e6) * 0.44 + (200 / 1e6) * 1.32;
  assert.ok(Math.abs(t1.costUsd - expect1) < 1e-12, `t1=${t1.costUsd} expect=${expect1}`);
  assert.equal(t1.tier, "peak");
  assert.equal(t1.model, "deepseek-v4-flash");
  // 轮 2 谷时价：1000 未命中×0.22/M + 100 输出×0.66/M
  const t2 = r.turns[1];
  const expect2 = (1000 / 1e6) * 0.22 + (100 / 1e6) * 0.66;
  assert.ok(Math.abs(t2.costUsd - expect2) < 1e-12);
  assert.equal(t2.tier, "off-peak");
  assert.ok(Math.abs(r.totalUsd - (expect1 + expect2)) < 1e-12);
  assert.equal(r.currentTurn, 2);
  assert.ok(Math.abs(r.currentTurnUsd - expect2) < 1e-12);
  assert.ok(Math.abs(r.totalCny - r.totalUsd * 7.2) < 1e-9);
  assert.ok(t1.startedAt.startsWith("2026-"), "startedAt 应带时间戳");
});

ok("computeSessionCosts 未知模型回退并注明", () => {
  const { DEFAULT_PRICING } = P;
  const events = [
    { type: "turn/start", time: 1, data: { turn: 1 } },
    { type: "assistant/message", time: 2, data: {
        turn: 1, step: 1,
        usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 },
        message: { source: { model: "some-unknown-model" } },
    } },
  ];
  const r = P.computeSessionCosts(DEFAULT_PRICING, events, 7.2);
  assert.ok(r.totalUsd > 0, "应按回退模型计价");
  assert.ok(r.note.includes("some-unknown-model"));
});

ok("computeSessionCosts 空事件安全", () => {
  const { DEFAULT_PRICING } = P;
  const r = P.computeSessionCosts(DEFAULT_PRICING, [], 7.2);
  assert.equal(r.turns.length, 0);
  assert.equal(r.totalUsd, 0);
  assert.equal(r.currentTurn, null);
});

// ---- session-costs 路由 ---------------------------------------------------
ok("session-costs 路由：活动会话优先、持久化兜底", async () => {
  let routes = [];
  const fakeWebServer = { register: (route) => { routes.push(route); return () => {}; } };
  const liveEvents = [
    { type: "turn/start", time: 1, data: { turn: 1 } },
    { type: "assistant/message", time: 2, data: {
        turn: 1, step: 1,
        usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 },
        message: { source: { model: "deepseek-v4-flash" } },
    } },
  ];
  const fakeCtx = {
    tools: { register: () => {} },
    inject: (services, cb) => {
      assert.deepEqual(services, ["webServer", "sessions", "sessionPersistence"]);
      cb({
        webServer: fakeWebServer,
        sessions: {
          get: (id) => (id === "live-session" ? { events: liveEvents } : void 0),
        },
        sessionPersistence: {
          readFrom: async (id) =>
            id === "stored-session"
              ? { meta: { id }, events: liveEvents }
              : (() => { const e = new Error(`session "${id}" not found`); throw e; })(),
        },
        effect: (fn) => fn(),
      });
    },
  };
  P.apply(fakeCtx, {});
  const costsRoute = routes.find((r) => r.path === P.COSTS_ROUTE_PATH);
  assert.ok(costsRoute, "应注册 session-costs 路由");
  const call = async (url) => {
    let payload = null;
    const res = {
      writeHead: (code, headers) => {
        assert.equal(code, 200);
        assert.ok(headers["content-type"].includes("application/json"));
      },
      end: (body) => { payload = body; },
    };
    await costsRoute.handler({ url }, res);
    return JSON.parse(payload);
  };
  const live = await call("/api/deepseek-pricing/session-costs?session=live-session");
  assert.equal(live.sessionId, "live-session");
  assert.equal(live.turns.length, 1);
  assert.ok(live.totalUsd > 0);
  const stored = await call("/api/deepseek-pricing/session-costs?session=stored-session");
  assert.equal(stored.turns.length, 1);
  // 未知会话 → 500
  let payload = null;
  const res500 = {
    writeHead: (code, headers) => { assert.equal(code, 500); void headers; },
    end: (body) => { payload = body; },
  };
  await costsRoute.handler({ url: "/api/deepseek-pricing/session-costs?session=ghost" }, res500);
  const ghost = JSON.parse(payload);
  assert.ok(ghost.error.includes("not found"));
});

// ---- client 半边（__ModuleLoader__ 工厂） --------------------------------
ok("client bundle 工厂注册并导出 apply/inject", () => {
  const source = readFileSync(join(root, "lib/client.js"), "utf8");
  let handoff = null;
  globalThis.window = {
    __ModuleLoader__: {
      load: (h) => {
        handoff = h;
      },
    },
  };
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, appendChild() {}, setAttribute() {} }),
    head: { appendChild() {} },
  };
  // 在沙箱里执行 bundle（避免污染全局 require）
  const fn = new Function(
    "window",
    "document",
    `
      const __require = (id) => {
        if (id === "react") return { useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(), createElement: () => ({}) };
        if (id === "react/jsx-runtime") return { jsx: () => ({}), jsxs: () => ({}) };
        throw new Error("unexpected require: " + id);
      };
      ${source}
    `
  );
  fn(globalThis.window, globalThis.document);
  assert.ok(handoff, "bundle 应调用 __ModuleLoader__.load");
  assert.equal(handoff.id, "dsh-plugin-deepseek-pricing");
  const mod = handoff.factory((id) => {
    if (id === "react") {
      return {
        createElement: () => ({}),
        Fragment: Symbol("fragment"),
        useState: (v) => [v, () => {}],
        useEffect: () => {},
        useCallback: (f) => f,
        useMemo: (f) => f(),
      };
    }
    if (id === "react/jsx-runtime") return { jsx: () => ({}), jsxs: () => ({}) };
    throw new Error("unexpected require: " + id);
  });
  assert.equal(typeof mod.apply, "function");
  assert.deepEqual(mod.inject, ["slots", "locale", "sessions"]);
  assert.equal(mod.NS, "deepseekPricingPanel");
  // apply 注册侧边栏入口
  let injected = null;
  let registeredSpec = null;
  const locale = {
    register: () => {},
    bind: () => (key) => key,
  };
  const slots = {
    inject: (name, factory) => {
      injected = { name, factory };
    },
    register: (spec, comp) => {
      registeredSpec = spec;
      assert.equal(spec.name, "sidebar.footer.action");
      assert.equal(spec.id, "deepseek-pricing-panel");
      assert.equal(typeof comp, "function");
      return () => {};
    },
  };
  const sessionsService = {
    list: {
      getSnapshot: () => ({ current: "session-abc" }),
      subscribe: (fn) => () => {},
    },
  };
  mod.apply({ effect: (fn) => fn(), locale, slots, sessions: sessionsService });
  assert.ok(injected);
  assert.equal(injected.name, "sidebar.footer.action");
  // 触发注入工厂，完成 slots.register
  injected.factory();
  assert.ok(registeredSpec, "slots.register 应被调用");
  // 注入的会话辅助函数
  assert.equal(typeof registeredSpec.inject, "function");
  const props = registeredSpec.inject();
  assert.equal(typeof props.getSessionId, "function");
  assert.equal(props.getSessionId(), "session-abc");
  assert.equal(typeof props.subscribeSessions, "function");
  delete globalThis.window;
  delete globalThis.document;
});

console.log(`\n全部 ${passed} 项 UI 包冒烟测试通过 ✅`);
