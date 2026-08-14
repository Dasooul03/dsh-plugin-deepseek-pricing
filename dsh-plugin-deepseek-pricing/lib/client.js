// dsh-plugin-deepseek-pricing — 浏览器半边（client bundle）
//
// 由 dsh 的 ClientModuleRegistry 以 /plugins/dsh-plugin-deepseek-pricing-ui/client.js
// 提供给 web 前端；页面加载后通过 window.__ModuleLoader__ 注册工厂，客户端 loader
// 按 dsh.client.inject 声明的服务依赖激活本插件（apply），向侧边栏注入一个
// 「DeepSeek 定价」面板入口：实时价格、峰谷状态与费用预估器。
//
// 数据来源：同源路由 GET /api/deepseek-pricing/snapshot（host 半边注册）。

window.__ModuleLoader__.load({
  id: "dsh-plugin-deepseek-pricing",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback, useMemo } = React;
    const h = React.createElement;

    const NS = "deepseekPricingPanel";
    const inject = ["slots", "locale", "sessions"];

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
      sessionCost: "会话费用",
      turnCost: "本轮对话",
      totalCost: "会话总花费",
      noSession: "暂无会话",
      turnsDetail: "费用明细（每轮按实际发生时刻计价）",
      turnsCount: "共 {n} 轮",
      turnRow: "轮 · {time} · {model}",
      costLoading: "计算中…",
      cnyRateNote: "人民币按参考汇率 {r} 换算",
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
      sessionCost: "Session cost",
      turnCost: "This turn",
      totalCost: "Session total",
      noSession: "No session",
      turnsDetail: "Per-turn detail (priced at each turn's actual time)",
      turnsCount: "{n} turns",
      turnRow: "turn · {time} · {model}",
      costLoading: "Computing…",
      cnyRateNote: "CNY at reference rate {r}",
    };

    // ---------------------------------------------------------------------
    // 样式（内联 + 主题 CSS 变量，随 dsh 明暗主题自动适配）
    // ---------------------------------------------------------------------
    const STYLES = {
      badge: {
        boxSizing: "border-box",
        width: "100%",
        minHeight: "49px",
        color: "var(--dsw-alias-label-primary)",
        cursor: "pointer",
        background: "transparent",
        border: "none",
        borderRadius: "12px",
        alignItems: "flex-start",
        justifyContent: "center",
        flexDirection: "column",
        gap: "2px",
        padding: "7px 10px",
        fontFamily: "inherit",
        fontSize: "14px",
        display: "inline-flex",
        overflow: "hidden",
      },
      badgeActive: { background: "var(--dsw-alias-interactive-bg-hover)" },
      badgeLabel: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" },
      badgeRow: { display: "flex", alignItems: "baseline", gap: "6px", width: "100%", minWidth: 0 },
      badgeRowLabel: {
        flex: "none",
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "11px",
        lineHeight: "18px",
        whiteSpace: "nowrap",
      },
      badgeRowValue: {
        color: "var(--dsw-alias-label-primary)",
        fontSize: "13px",
        fontWeight: 600,
        lineHeight: "18px",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      },
      badgeRowUsd: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "11px",
        lineHeight: "18px",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      },
      railBadge: {
        width: "36px",
        height: "36px",
        borderRadius: "50%",
        alignItems: "center",
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
      costSection: { marginTop: "12px", borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: "8px" },
      costSummary: { display: "flex", gap: "8px" },
      costCard: {
        flex: "1",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)",
        borderRadius: "10px",
        padding: "8px 10px",
        minWidth: 0,
      },
      costLabel: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", lineHeight: "16px" },
      costValue: {
        color: "var(--dsw-alias-label-primary)",
        fontSize: "16px",
        fontWeight: 600,
        lineHeight: "24px",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      costUsdSub: { color: "var(--dsw-alias-label-tertiary)", fontWeight: 400, fontSize: "12px", marginLeft: "4px" },
      costEmpty: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "20px", margin: "6px 0" },
      costError: { color: "var(--dsw-alias-state-error-primary)", fontSize: "12px", lineHeight: "18px", margin: "6px 0" },
      turnsCount: { color: "var(--dsw-alias-label-tertiary)", fontWeight: 400, textTransform: "none", letterSpacing: 0 },
      turnList: { display: "flex", flexDirection: "column", gap: "4px", margin: "2px 0 4px" },
      turnRow: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: "8px",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)",
        borderRadius: "8px",
        padding: "5px 8px",
        fontSize: "11px",
        lineHeight: "16px",
        minWidth: 0,
      },
      turnRowHead: { color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
      turnRowMeta: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", lineHeight: "16px", fontVariantNumeric: "tabular-nums", flex: "none" },
      tdCny: { color: "var(--dsw-alias-label-tertiary)", fontSize: "10px", lineHeight: "14px", fontVariantNumeric: "tabular-nums" },
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
    const fmtUsd = (n, digits = 6) => `$${Number(n).toFixed(digits)}`;
    const cnyPerM = (cnyAmount) => `¥${Number(cnyAmount).toFixed(4)}`;
    const shortTime = (iso) => {
      if (!iso) return "—";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "—";
      const p = (x) => String(x).padStart(2, "0");
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    // ---------------------------------------------------------------------
    // 面板组件
    // ---------------------------------------------------------------------
    function PricingPanel({ wide, t, getSessionId, subscribeSessions }) {
      const [open, setOpen] = useState(false);
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [model, setModel] = useState("");
      const [inputRaw, setInputRaw] = useState("10000");
      const [hitRaw, setHitRaw] = useState("2000");
      const [outputRaw, setOutputRaw] = useState("2000");
      const [sessionId, setSessionId] = useState(null);
      const [costs, setCosts] = useState(null);
      const [costError, setCostError] = useState(null);

      const loadCosts = useCallback(async (sid) => {
        if (!sid) {
          setCosts(null);
          return;
        }
        try {
          const res = await fetch(
            `/api/deepseek-pricing/session-costs?session=${encodeURIComponent(sid)}`,
            { cache: "no-store" }
          );
          let body = null;
          try {
            body = await res.json();
          } catch {
            throw new Error(`HTTP ${res.status}`);
          }
          if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
          setCosts(body);
          setCostError(null);
        } catch (e) {
          setCostError(String((e && e.message) || e));
        }
      }, []);

      // 跟随当前会话（切换会话立即重新计算）
      useEffect(() => {
        setSessionId(typeof getSessionId === "function" ? getSessionId() : null);
        if (typeof subscribeSessions !== "function") return undefined;
        return subscribeSessions(() => {
          setSessionId(typeof getSessionId === "function" ? getSessionId() : null);
        });
      }, [getSessionId, subscribeSessions]);

      // 会话费用：每 10 秒自动刷新（每轮对话结束后约 10 秒内更新）
      useEffect(() => {
        loadCosts(sessionId);
        const timer = setInterval(() => loadCosts(sessionId), 10000);
        return () => clearInterval(timer);
      }, [sessionId, loadCosts]);

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

      // 会话费用区块（置顶）：本轮 + 会话总花费 + 逐轮明细（每轮按实际发生时刻计价）
      const renderCostSection = () => {
        if (costError) {
          return h("div", { style: STYLES.costError }, `${t("sessionCost")}: ${costError}`);
        }
        if (costs === null) {
          return h(
            "div",
            { style: STYLES.costEmpty },
            sessionId ? `${t("costLoading")}…` : t("noSession")
          );
        }
        const turns = costs.turns ?? [];
        const lastTurns = turns.slice(-10).reverse();
        return h(
          React.Fragment,
          null,
          h("div", { style: STYLES.groupLabel }, t("sessionCost")),
          h(
            "div",
            { style: STYLES.costSummary },
            h(
              "div",
              { style: STYLES.costCard },
              h("div", { style: STYLES.costLabel }, t("totalCost")),
              h(
                "div",
                { style: STYLES.costValue },
                cny(costs.totalCny),
                h("span", { style: STYLES.costUsdSub }, `≈ ${fmtUsd(costs.totalUsd, 6)}`)
              )
            ),
            h(
              "div",
              { style: STYLES.costCard },
              h("div", { style: STYLES.costLabel }, t("turnCost")),
              h(
                "div",
                { style: STYLES.costValue },
                cny(costs.currentTurnCny),
                h("span", { style: STYLES.costUsdSub }, `≈ ${fmtUsd(costs.currentTurnUsd, 6)}`)
              )
            )
          ),
          turns.length > 0
            ? h(
                React.Fragment,
                null,
                h(
                  "div",
                  { style: STYLES.groupLabel },
                  t("turnsDetail"),
                  h("span", { style: STYLES.turnsCount }, ` · ${t("turnsCount").replace("{n}", String(turns.length))}`)
                ),
                h(
                  "div",
                  { style: STYLES.turnList },
                  lastTurns.map((turn) =>
                    h(
                      "div",
                      { key: turn.turn, style: STYLES.turnRow },
                      h(
                        "span",
                        { style: STYLES.turnRowHead },
                        `#${turn.turn} · ${shortTime(turn.startedAt)} · ${turn.model ?? "—"}`
                      ),
                      h(
                        "span",
                        { style: STYLES.turnRowMeta },
                        `${turn.tokens.input + turn.tokens.cacheRead}/${turn.tokens.output} tok · ${cny(turn.costCny)}（≈ ${fmtUsd(turn.costUsd, 6)}）`
                      )
                    )
                  )
                )
              )
            : null
        );
      };

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
          ? costs
            ? [
                h(
                  "div",
                  { key: "total", style: STYLES.badgeRow },
                  h("span", { style: STYLES.badgeRowLabel }, t("totalCost")),
                  h("span", { style: STYLES.badgeRowValue }, cny(costs.totalCny)),
                  h("span", { style: STYLES.badgeRowUsd }, `≈ ${fmtUsd(costs.totalUsd, 4)}`)
                ),
                h(
                  "div",
                  { key: "turn", style: STYLES.badgeRow },
                  h("span", { style: STYLES.badgeRowLabel }, t("turnCost")),
                  h("span", { style: STYLES.badgeRowValue }, cny(costs.currentTurnCny)),
                  h("span", { style: STYLES.badgeRowUsd }, `≈ ${fmtUsd(costs.currentTurnUsd, 4)}`)
                ),
              ]
            : [h("span", { key: "l", style: STYLES.badgeLabel }, t("label"))]
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
                // 会话费用（本轮 + 总花费 + 逐轮明细）置顶显示
                h("div", { key: "costSection", style: STYLES.costSection }, renderCostSection()),
                h("div", { key: "prices", style: STYLES.groupLabel }, `${t("prices")} · ${t("cnyRateNote").replace("{r}", String(data.cnyRate))}`),
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
                        h("td", { style: { ...STYLES.td, textAlign: "right" } },
                          h("div", null, usd(p.cacheHit)),
                          h("div", { style: STYLES.tdCny }, cnyPerM(p.cacheHit * data.cnyRate))),
                        h("td", { style: { ...STYLES.td, textAlign: "right" } },
                          h("div", null, usd(p.cacheMiss)),
                          h("div", { style: STYLES.tdCny }, cnyPerM(p.cacheMiss * data.cnyRate))),
                        h("td", { style: { ...STYLES.td, textAlign: "right" } },
                          h("div", null, usd(p.output)),
                          h("div", { style: STYLES.tdCny }, cnyPerM(p.output * data.cnyRate)))
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
                        `${t("total")}: ${cny(estimate.totalCny)}（≈ ${usd(estimate.totalUsd)}）`
                      ),
                      h(
                        "div",
                        null,
                        `${t("details")}: ${t("hit")} ¥${(estimate.hitCost * (data?.cnyRate ?? 7.2)).toFixed(4)} · ${t("miss")} ¥${(estimate.missCost * (data?.cnyRate ?? 7.2)).toFixed(4)} · ${t("output")} ¥${(estimate.outCost * (data?.cnyRate ?? 7.2)).toFixed(4)}（${tierLabel(t, estimate.tier)}）`
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
      const injectProps = () => ({
        getSessionId: () => ctx.sessions.list.getSnapshot().current ?? null,
        subscribeSessions: (fn) => ctx.sessions.list.subscribe(fn),
      });
      ctx.slots.inject(
        "sidebar.footer.action",
        () =>
          ctx.slots.register(
            {
              name: "sidebar.footer.action",
              id: "deepseek-pricing-panel",
              locale: NS,
              label: () => t("label"),
              inject: injectProps,
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
