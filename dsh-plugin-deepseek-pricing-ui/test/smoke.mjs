// dsh-plugin-deepseek-pricing-ui 冒烟测试（mock，不依赖浏览器/真实服务）
// 运行: node test/smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pricing = await import("dsh-plugin-deepseek-pricing");
let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ---- host 半边 ----------------------------------------------------------
const host = await import("../lib/index.js");

ok("buildSnapshot 结构正确（flat 周期）", () => {
  const { DEFAULT_PRICING } = pricing;
  const at = new Date("2026-08-14T12:00:00Z");
  const snap = host.buildSnapshot(DEFAULT_PRICING, at, 7.2);
  assert.equal(snap.status, "flat");
  assert.equal(snap.models.length, 2);
  assert.equal(snap.prices.length, 2);
  assert.equal(snap.prices[0].tier, "flat");
  assert.equal(snap.unit, "USD per 1M tokens");
  assert.equal(snap.nowUtc, at.toISOString());
  assert.ok(snap.nowBeijing.includes("2026"));
});

ok("buildSnapshot 峰谷周期给出双档价格", () => {
  const { DEFAULT_PRICING } = pricing;
  const at = new Date("2026-08-17T02:00:00Z"); // 高峰
  const snap = host.buildSnapshot(DEFAULT_PRICING, at, 7.2);
  assert.equal(snap.status, "peak");
  assert.equal(snap.applicableTier, "peak");
  assert.equal(snap.prices.length, 4); // 2 模型 × 2 档
  const flashPeak = snap.prices.find((p) => p.model === "deepseek-v4-flash" && p.tier === "peak");
  assert.deepEqual(
    { cacheHit: flashPeak.cacheHit, cacheMiss: flashPeak.cacheMiss, output: flashPeak.output },
    { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 }
  );
});

ok("apply 注册快照路由并返回 JSON", async () => {
  const routes = [];
  const fakeWebServer = {
    register: (route) => {
      routes.push(route);
      return () => {};
    },
  };
  const fakeCtx = {
    inject: (services, cb) => {
      assert.deepEqual(services, ["webServer", "sessions", "sessionPersistence"]);
      cb({ webServer: fakeWebServer, effect: (fn) => fn() });
    },
  };
  host.apply(fakeCtx, {});
  assert.equal(routes.length, 2, "应注册 snapshot 与 session-costs 两条路由");
  const registered = routes.find((r) => r.path === host.ROUTE_PATH);
  assert.ok(registered, "snapshot 路由应存在");
  assert.equal(registered.kind, "exact");
  // 调用 handler（模拟请求）
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead: (code, headers) => {
        assert.equal(code, 200);
        assert.ok(headers["content-type"].includes("application/json"));
      },
      end: (payload) => resolve(payload),
    };
    registered.handler({ url: "/api/deepseek-pricing/snapshot?refresh=1" }, res).catch(reject);
  });
  const snap = JSON.parse(body);
  assert.ok(snap.prices.length >= 2);
  assert.ok(["flat", "peak", "off-peak"].includes(snap.status));
  assert.ok(snap.source === "live" || snap.source === "bundled");
  console.log(`      snapshot: source=${snap.source} status=${snap.status} 北京=${snap.nowBeijing}`);
});

ok("无 webServer 时 apply 无副作用", () => {
  let cbCalled = false;
  host.apply(
    {
      inject: (services, cb) => {
        // 服务未就绪：回调永不执行，apply 不抛错
        assert.deepEqual(services, ["webServer", "sessions", "sessionPersistence"]);
        void cb;
      },
    },
    {}
  );
  assert.equal(cbCalled, false);
});

// ---- 会话费用计算 ---------------------------------------------------------
ok("computeSessionCosts 按时间戳逐轮计价", () => {
  const { DEFAULT_PRICING } = pricing;
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
  const r = host.computeSessionCosts(DEFAULT_PRICING, events, 7.2);
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
  const { DEFAULT_PRICING } = pricing;
  const events = [
    { type: "turn/start", time: 1, data: { turn: 1 } },
    { type: "assistant/message", time: 2, data: {
        turn: 1, step: 1,
        usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 },
        message: { source: { model: "some-unknown-model" } },
    } },
  ];
  const r = host.computeSessionCosts(DEFAULT_PRICING, events, 7.2);
  assert.ok(r.totalUsd > 0, "应按回退模型计价");
  assert.ok(r.note.includes("some-unknown-model"));
});

ok("computeSessionCosts 空事件安全", () => {
  const { DEFAULT_PRICING } = pricing;
  const r = host.computeSessionCosts(DEFAULT_PRICING, [], 7.2);
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
  host.apply(fakeCtx, {});
  const costsRoute = routes.find((r) => r.path === host.COSTS_ROUTE_PATH);
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
  assert.equal(handoff.id, "dsh-plugin-deepseek-pricing-ui");
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
