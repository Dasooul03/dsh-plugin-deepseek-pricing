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
  let registered = null;
  const fakeWebServer = {
    register: (route) => {
      registered = route;
      return () => {};
    },
  };
  const fakeCtx = {
    inject: (services, cb) => {
      assert.deepEqual(services, ["webServer"]);
      cb({ webServer: fakeWebServer, effect: (fn) => fn() });
    },
  };
  host.apply(fakeCtx, {});
  assert.equal(registered.kind, "exact");
  assert.equal(registered.path, host.ROUTE_PATH);
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
        assert.deepEqual(services, ["webServer"]);
        void cb;
      },
    },
    {}
  );
  assert.equal(cbCalled, false);
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
  assert.deepEqual(mod.inject, ["slots", "locale"]);
  assert.equal(mod.NS, "deepseekPricingPanel");
  // apply 注册侧边栏入口
  let injected = null;
  const locale = {
    register: () => {},
    bind: () => (key) => key,
  };
  const slots = {
    inject: (name, factory) => {
      injected = { name, factory };
    },
    register: (spec, comp) => {
      assert.equal(spec.name, "sidebar.footer.action");
      assert.equal(spec.id, "deepseek-pricing-panel");
      assert.equal(typeof comp, "function");
      return () => {};
    },
  };
  mod.apply({ effect: (fn) => fn(), locale, slots });
  assert.ok(injected);
  assert.equal(injected.name, "sidebar.footer.action");
  delete globalThis.window;
  delete globalThis.document;
});

console.log(`\n全部 ${passed} 项 UI 包冒烟测试通过 ✅`);
