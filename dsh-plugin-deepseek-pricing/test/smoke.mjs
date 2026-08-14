// dsh-plugin-deepseek-pricing 冒烟测试：纯逻辑验证（不依赖 dsh 运行时）
// 运行: node test/smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

ok("空页面解析报错", () => {
  assert.throws(() => parsePricingHtml(""), /empty/);
  assert.throws(() => parsePricingHtml("<html><body>no tables</body></html>"), /MODEL header row/);
});

// ---- apply() 在最小 ctx 上注册两个工具 ----------------------------------
ok("峰谷周期下 deepseek_pricing 工具执行（offPeak 键回归）", async () => {
  const registered = [];
  apply({ tools: { register: (d) => registered.push(d) } }, { liveSync: false });
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
