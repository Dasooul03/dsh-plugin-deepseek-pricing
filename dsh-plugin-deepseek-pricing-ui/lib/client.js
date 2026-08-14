// dsh-plugin-deepseek-pricing-ui — 浏览器半边（client bundle）
//
// 由 dsh 的 ClientModuleRegistry 以 /plugins/dsh-plugin-deepseek-pricing-ui/client.js
// 提供给 web 前端；页面加载后通过 window.__ModuleLoader__ 注册工厂，客户端 loader
// 按 dsh.client.inject 声明的服务依赖激活本插件（apply），向侧边栏注入一个
// 「DeepSeek 定价」面板入口：实时价格、峰谷状态与费用预估器。
//
// 数据来源：同源路由 GET /api/deepseek-pricing/snapshot（host 半边注册）。

window.__ModuleLoader__.load({
  id: "dsh-plugin-deepseek-pricing-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback, useMemo } = React;
    const h = React.createElement;

    const NS = "deepseekPricingPanel";
    const inject = ["slots", "locale"];

    const zh = {
      label: "DeepSeek 定价",
      open: "打开 DeepSeek 定价面板",
      close: "关闭定价面板",
      refresh: "刷新",
      loading: "加载中…",
      error: "暂时无法获取定价",
      time: "时间",
      beijing: "北京时间",
      status: "计费档位",
      flat: "统一价",
      peak: "高峰",
      offPeak: "谷时",
      period: "当前周期",
      effective: "峰谷生效",
      peakHours: "高峰时段(UTC)",
      source: "数据源",
      synced: "同步时间",
      prices: "每 1M tokens 价格（USD）",
      hit: "缓存命中",
      miss: "缓存未命中",
      output: "输出",
      estimator: "费用预估",
      model: "模型",
      input: "输入 tokens",
      cacheHit: "其中缓存命中",
      out: "输出 tokens",
      estimate: "估算",
      total: "合计",
      cny: "约合人民币",
      details: "明细",
      note: "注",
      custom: "自定义",
      live: "官方实时",
      bundled: "内置",
    };

    const en = {
      label: "DeepSeek Pricing",
      open: "Open DeepSeek pricing panel",
      close: "Close pricing panel",
      refresh: "Refresh",
      loading: "Loading…",
      error: "Pricing unavailable",
      time: "Time",
      beijing: "Beijing time",
      status: "Billing tier",
      flat: "Flat",
      peak: "Peak",
      offPeak: "Off-peak",
      period: "Period",
      effective: "Effective",
      peakHours: "Peak hours (UTC)",
      source: "Source",
      synced: "Synced at",
      prices: "Price per 1M tokens (USD)",
      hit: "Cache hit",
      miss: "Cache miss",
      output: "Output",
      estimator: "Cost estimate",
      model: "Model",
      input: "Input tokens",
      cacheHit: "Cache-hit input",
      out: "Output tokens",
      estimate: "Estimate",
      total: "Total",
      cny: "≈ CNY",
      details: "Breakdown",
      note: "Note",
      custom: "Custom",
      live: "Live",
      bundled: "Bundled",
    };

    // ---------------------------------------------------------------------
    // 样式（内联 + 主题 CSS 变量，随 dsh 明暗主题自动适配）
    // ---------------------------------------------------------------------
    const STYLES = {
      badge: {
        boxSizing: "border-box",
        width: "100%",
        height: "49px",
        color: "var(--dsw-alias-label-primary)",
        cursor: "pointer",
        background: "transparent",
        border: "none",
        borderRadius: "12px",
        alignItems: "center",
        gap: "8px",
        padding: "0 8px 0 10px",
        fontFamily: "inherit",
        fontSize: "14px",
        display: "inline-flex",
        overflow: "hidden",
      },
      badgeActive: { background: "var(--dsw-alias-interactive-bg-hover)" },
      badgeLabel: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" },
      badgeDot: {
        flex: "none",
        width: "8px",
        height: "8px",
        borderRadius: "999px",
        background: "var(--dsw-alias-label-tertiary)",
      },
      badgeTier: {
        marginLeft: "auto",
        flex: "none",
        fontSize: "11px",
        lineHeight: "18px",
        padding: "0 6px",
        borderRadius: "999px",
        background: "var(--dsw-alias-button-ghost-active-fill)",
        color: "var(--dsw-alias-label-caption)",
      },
      railBadge: {
        width: "36px",
        height: "36px",
        borderRadius: "50%",
        justifyContent: "center",
        gap: 0,
        padding: 0,
        fontSize: "13px",
        fontWeight: 600,
      },
      panel: {
        zIndex: 30,
        boxSizing: "border-box",
        border: "1px solid var(--dsw-alias-border-l1)",
        background: "var(--dsw-alias-bg-base)",
        width: "400px",
        maxWidth: "calc(100vw - 24px)",
        maxHeight: "70vh",
        boxShadow: "var(--dsw-shadow-lv2)",
        borderRadius: "12px",
        display: "flex",
        flexDirection: "column",
        position: "fixed",
        bottom: "128px",
        left: "12px",
        overflow: "hidden",
      },
      header: {
        boxSizing: "border-box",
        borderBottom: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-base)",
        flex: "none",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        minHeight: "44px",
        padding: "8px 12px",
        gap: "8px",
      },
      title: { color: "var(--dsw-alias-label-primary)", fontSize: "13px", fontWeight: 600, lineHeight: "20px" },
      tierPill: {
        flex: "none",
        fontSize: "11px",
        lineHeight: "18px",
        padding: "0 8px",
        borderRadius: "999px",
      },
      refreshBtn: {
        flex: "none",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-secondary)",
        font: "inherit",
        fontSize: "12px",
        cursor: "pointer",
        borderRadius: "8px",
        padding: "3px 10px",
      },
      body: { flex: "1", minHeight: 0, padding: "10px 12px 12px", overflowY: "auto" },
      meta: {
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 14px",
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "11px",
        lineHeight: "18px",
        marginBottom: "8px",
      },
      groupLabel: {
        color: "var(--dsw-alias-label-caption)",
        textTransform: "uppercase",
        letterSpacing: ".04em",
        margin: "10px 0 4px",
        fontSize: "11px",
        fontWeight: 500,
        lineHeight: "16px",
      },
      table: {
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "12px",
        lineHeight: "18px",
      },
      th: {
        textAlign: "left",
        color: "var(--dsw-alias-label-tertiary)",
        fontWeight: 500,
        padding: "4px 6px",
        borderBottom: "1px solid var(--dsw-alias-border-l2)",
        whiteSpace: "nowrap",
      },
      td: {
        color: "var(--dsw-alias-label-secondary)",
        padding: "5px 6px",
        borderBottom: "1px solid var(--dsw-alias-border-l2)",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      },
      tdModel: { color: "var(--dsw-alias-label-primary)", fontWeight: 500 },
      tierTag: {
        display: "inline-block",
        fontSize: "10px",
        lineHeight: "16px",
        padding: "0 5px",
        borderRadius: "5px",
        marginLeft: "6px",
        verticalAlign: "1px",
      },
      form: { display: "flex", flexDirection: "column", gap: "8px" },
      field: { display: "flex", alignItems: "center", gap: "8px" },
      fieldLabel: { flex: "none", width: "120px", color: "var(--dsw-alias-label-secondary)", fontSize: "12px" },
      input: {
        flex: "1",
        minWidth: 0,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        fontSize: "12px",
        borderRadius: "8px",
        padding: "5px 8px",
      },
      select: {
        flex: "1",
        minWidth: 0,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        fontSize: "12px",
        borderRadius: "8px",
        padding: "5px 8px",
      },
      estimateBtn: {
        alignSelf: "flex-end",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-button-elevated-fill)",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        fontSize: "12px",
        fontWeight: 500,
        cursor: "pointer",
        borderRadius: "8px",
        padding: "5px 14px",
      },
      result: {
        marginTop: "8px",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)",
        borderRadius: "10px",
        padding: "8px 10px",
        fontSize: "12px",
        lineHeight: "20px",
        color: "var(--dsw-alias-label-secondary)",
      },
      resultTotal: { color: "var(--dsw-alias-label-primary)", fontWeight: 600, fontSize: "13px" },
      error: { color: "var(--dsw-alias-state-error-primary)", fontSize: "12px", lineHeight: "18px", margin: "6px 0" },
      note: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", lineHeight: "16px", marginTop: "8px" },
    };

    const TIER_COLORS = {
      flat: { bg: "var(--dsw-alias-button-ghost-active-fill)", fg: "var(--dsw-alias-label-caption)" },
      peak: { bg: "var(--dsw-alias-state-warn-tertiary)", fg: "var(--dsw-alias-state-warn-label)" },
      "off-peak": { bg: "var(--dsw-alias-state-success-tertiary)", fg: "var(--dsw-alias-state-success-primary)" },
    };

    function tierLabel(t, status) {
      return status === "flat" ? t("flat") : status === "peak" ? t("peak") : t("offPeak");
    }

    function sourceLabel(t, source) {
      return source === "live" ? t("live") : source === "custom" ? t("custom") : t("bundled");
    }

    /** 本地按当前档位价格计算预估费用。 */
    function computeEstimate(data, model, inputRaw, hitRaw, outputRaw) {
      if (!data || !model) return null;
      const row =
        data.prices.find((p) => p.model === model && p.tier === data.applicableTier) ??
        data.prices.find((p) => p.model === model);
      if (!row) return null;
      const input = Math.max(0, Math.floor(Number(inputRaw) || 0));
      const hit = Math.min(input, Math.max(0, Math.floor(Number(hitRaw) || 0)));
      const output = Math.max(0, Math.floor(Number(outputRaw) || 0));
      const hitCost = (hit / 1e6) * row.cacheHit;
      const missCost = ((input - hit) / 1e6) * row.cacheMiss;
      const outCost = (output / 1e6) * row.output;
      const totalUsd = hitCost + missCost + outCost;
      return {
        input,
        hit,
        output,
        hitCost,
        missCost,
        outCost,
        totalUsd,
        totalCny: totalUsd * (data.cnyRate ?? 7.2),
        tier: row.tier,
      };
    }

    const usd = (n) => `$${n.toFixed(6)}`;
    const cny = (n) => `¥${n.toFixed(4)}`;

    // ---------------------------------------------------------------------
    // 面板组件
    // ---------------------------------------------------------------------
    function PricingPanel({ wide, t }) {
      const [open, setOpen] = useState(false);
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [model, setModel] = useState("");
      const [inputRaw, setInputRaw] = useState("10000");
      const [hitRaw, setHitRaw] = useState("2000");
      const [outputRaw, setOutputRaw] = useState("2000");

      const load = useCallback(async (refresh) => {
        setBusy(true);
        try {
          const res = await fetch(
            "/api/deepseek-pricing/snapshot" + (refresh ? "?refresh=1" : ""),
            { cache: "no-store" }
          );
          let body = null;
          try {
            body = await res.json();
          } catch {
            throw new Error(`HTTP ${res.status}`);
          }
          if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
          setData(body);
          setError(null);
          setModel((current) => current || body.models?.[0] || "");
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        load(false);
        const timer = setInterval(() => load(false), 30000);
        return () => clearInterval(timer);
      }, [load]);

      const estimate = useMemo(
        () => computeEstimate(data, model, inputRaw, hitRaw, outputRaw),
        [data, model, inputRaw, hitRaw, outputRaw]
      );

      const colors = data ? TIER_COLORS[data.applicableTier] ?? TIER_COLORS.flat : TIER_COLORS.flat;

      const badge = h(
        "button",
        {
          type: "button",
          style: { ...STYLES.badge, ...(wide ? {} : STYLES.railBadge), ...(open ? STYLES.badgeActive : {}) },
          "aria-label": open ? t("close") : t("open"),
          onClick: () => setOpen((v) => !v),
          title: t("label"),
        },
        wide
          ? [
              h("span", { key: "d", style: { ...STYLES.badgeDot, background: colors.fg } }),
              h("span", { key: "l", style: STYLES.badgeLabel }, t("label")),
              data
                ? h(
                    "span",
                    { key: "s", style: { ...STYLES.badgeTier, background: colors.bg, color: colors.fg } },
                    tierLabel(t, data.applicableTier)
                  )
                : null,
            ]
          : [h("span", { key: "l", style: STYLES.badgeLabel }, "价")]
      );

      if (!open) return badge;

      const body = h(
        "div",
        { style: STYLES.body },
        error
          ? h("div", { style: STYLES.error }, `${t("error")}: ${error}`)
          : !data
            ? h("div", { style: STYLES.meta }, busy ? t("loading") : t("loading"))
            : [
                h(
                  "div",
                  { key: "meta", style: STYLES.meta },
                  [
                    `${t("beijing")}: ${data.nowBeijing}`,
                    `${t("period")}: ${data.periodLabel}`,
                    data.effectiveDate ? `${t("effective")}: ${data.effectiveDate}` : null,
                    `${t("peakHours")}: ${data.peakHoursUtc.map(([a, b]) => `${a}:00–${b}:00`).join("、")}`,
                    `${t("source")}: ${sourceLabel(t, data.source)}`,
                    data.fetchedAt ? `${t("synced")}: ${data.fetchedAt}` : null,
                  ].filter(Boolean)
                ),
                h("div", { key: "prices", style: STYLES.groupLabel }, t("prices")),
                h(
                  "table",
                  { key: "table", style: STYLES.table },
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      h("th", { style: STYLES.th }, t("model")),
                      h("th", { style: STYLES.th, align: "right" }, t("hit")),
                      h("th", { style: STYLES.th, align: "right" }, t("miss")),
                      h("th", { style: STYLES.th, align: "right" }, t("output"))
                    )
                  ),
                  h(
                    "tbody",
                    null,
                    data.prices.map((p) => {
                      const isApplicable = p.tier === data.applicableTier;
                      const c = TIER_COLORS[p.tier] ?? TIER_COLORS.flat;
                      return h(
                        "tr",
                        { key: p.model + "/" + p.tier },
                        h(
                          "td",
                          { style: { ...STYLES.td, ...STYLES.tdModel } },
                          p.model,
                          h(
                            "span",
                            {
                              style: {
                                ...STYLES.tierTag,
                                background: c.bg,
                                color: c.fg,
                                ...(isApplicable ? { outline: "1px solid " + c.fg } : {}),
                              },
                            },
                            p.tierLabel
                          )
                        ),
                        h("td", { style: { ...STYLES.td, textAlign: "right" } }, usd(p.cacheHit)),
                        h("td", { style: { ...STYLES.td, textAlign: "right" } }, usd(p.cacheMiss)),
                        h("td", { style: { ...STYLES.td, textAlign: "right" } }, usd(p.output))
                      );
                    })
                  )
                ),
                h("div", { key: "est", style: STYLES.groupLabel }, t("estimator")),
                h(
                  "div",
                  { key: "form", style: STYLES.form },
                  h(
                    "label",
                    { style: STYLES.field },
                    h("span", { style: STYLES.fieldLabel }, t("model")),
                    h(
                      "select",
                      {
                        style: STYLES.select,
                        value: model,
                        onChange: (e) => setModel(e.target.value),
                      },
                      (data.models ?? []).map((m) => h("option", { key: m, value: m }, m))
                    )
                  ),
                  h(
                    "label",
                    { style: STYLES.field },
                    h("span", { style: STYLES.fieldLabel }, t("input")),
                    h("input", {
                      style: STYLES.input,
                      type: "number",
                      min: 0,
                      step: 1000,
                      value: inputRaw,
                      onChange: (e) => setInputRaw(e.target.value),
                    })
                  ),
                  h(
                    "label",
                    { style: STYLES.field },
                    h("span", { style: STYLES.fieldLabel }, t("cacheHit")),
                    h("input", {
                      style: STYLES.input,
                      type: "number",
                      min: 0,
                      step: 1000,
                      value: hitRaw,
                      onChange: (e) => setHitRaw(e.target.value),
                    })
                  ),
                  h(
                    "label",
                    { style: STYLES.field },
                    h("span", { style: STYLES.fieldLabel }, t("out")),
                    h("input", {
                      style: STYLES.input,
                      type: "number",
                      min: 0,
                      step: 1000,
                      value: outputRaw,
                      onChange: (e) => setOutputRaw(e.target.value),
                    })
                  )
                ),
                estimate
                  ? h(
                      "div",
                      { key: "result", style: STYLES.result },
                      h(
                        "div",
                        { style: STYLES.resultTotal },
                        `${t("total")}: ${usd(estimate.totalUsd)}  ${t("cny")} ${cny(estimate.totalCny)}`
                      ),
                      h(
                        "div",
                        null,
                        `${t("details")}: ${t("hit")} ${usd(estimate.hitCost)} · ${t("miss")} ${usd(estimate.missCost)} · ${t("output")} ${usd(estimate.outCost)}（${tierLabel(t, estimate.tier)}）`
                      )
                    )
                  : null,
                data.note ? h("div", { key: "note", style: STYLES.note }, `${t("note")}: ${data.note}`) : null
              ]
      );

      return h(
        React.Fragment,
        null,
        badge,
        h(
          "div",
          { style: STYLES.panel, role: "dialog", "aria-label": t("label") },
          h(
            "div",
            { style: STYLES.header },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 } },
              h("span", { style: STYLES.title }, t("label")),
              data
                ? h(
                    "span",
                    { style: { ...STYLES.tierPill, background: colors.bg, color: colors.fg } },
                    tierLabel(t, data.applicableTier)
                  )
                : null
            ),
            h(
              "button",
              {
                type: "button",
                style: STYLES.refreshBtn,
                disabled: busy,
                onClick: () => load(true),
              },
              busy ? t("loading") : t("refresh")
            )
          ),
          body
        )
      );
    }

    // ---------------------------------------------------------------------
    // 插件注册：向侧边栏注入面板入口
    // ---------------------------------------------------------------------
    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "deepseek-pricing-ui: dictionaries"
      );
      const t = ctx.locale.bind(NS);
      ctx.slots.inject(
        "sidebar.footer.action",
        () =>
          ctx.slots.register(
            {
              name: "sidebar.footer.action",
              id: "deepseek-pricing-panel",
              locale: NS,
              label: () => t("label"),
              inject: () => ({}),
            },
            PricingPanel
          ),
        "deepseek-pricing-ui: sidebar entry"
      );
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
