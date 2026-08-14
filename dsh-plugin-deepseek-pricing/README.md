# dsh-plugin-deepseek-pricing

DeepSeek 官方模型**实时定价查询**、**会话费用统计**与**费用预估**的 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件。单一插件包同时提供 Agent 工具与 Web 定价面板。

## 功能

### 🧰 Agent 工具（任意 profile 可用）

- **`deepseek_pricing`**：查询 DeepSeek 官方模型实时定价（每 1M tokens，USD）
  - **峰谷价按 UTC 时间自动判定**：高峰时段 01:00–04:00 与 06:00–10:00 UTC，其余时间为谷时（半价）；
    峰谷计价正式生效前自动使用官方现行统一价
  - 默认开启 **liveSync**：从官方定价页 <https://api-docs.deepseek.com/quick_start/pricing>
    实时拉取并解析（30 分钟缓存，失败自动回退内置表）
  - 支持 `at` 参数按任意时刻评估、`refresh` 强制同步
- **`estimate_cost`**：按输入 token（缓存命中/未命中）+ 输出 token 预估一次调用费用，
  自动套用当前峰谷价，输出 USD 与约合 CNY；支持传 `text` 由文本长度粗略预估输入 token

### 🖥️ Web 定价面板（侧边栏底部）

- **未展开**：徽标直接显示 **会话总费用** 与 **本轮对话费用**（人民币）
- **展开面板**：
  1. **会话费用**（置顶）：本轮对话 / 会话总花费卡片（人民币为主、美元为辅）+ **逐轮明细**
     （轮次 · 发生时间 · 模型 · token 数 · 费用）
  2. 价格表：每 1M tokens 价格（USD + 人民币换算），高峰/谷时双档，当前档位高亮
  3. 费用预估器：选模型 + token 数 → USD 与约合 CNY
- 自动跟随当前会话，每 10 秒自动刷新；价格档位每 30 秒刷新；「刷新」按钮强制同步官方页

### ⏱️ 会话费用计算

- 每一轮（turn）的费用 = 该轮内每条模型消息的用量
  （`inputTokens` 缓存未命中、`cacheReadTokens` 缓存命中、`outputTokens` 输出）
  按**该消息自身的 time 时间戳**取当时生效的峰谷价格逐条计价求和
- 模型按消息来源分别计价（flash / pro），未知模型自动回退并注明
- 数据来源：活动会话（内存）优先，其次持久化日志（JSONL），**历史会话同样可算**

## 安装

```sh
# 1) 安装依赖
cd dsh-plugin-deepseek-pricing && npm install

# 2) 软链到 dsh profile 共享的 node_modules（所有 profile 通用）
ln -s "$PWD" ~/.dsh/profiles/node_modules/dsh-plugin-deepseek-pricing

# 3) 在 profile 的 cordis.patch.yml 中登记 entry
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（追加到顶层数组）
- insert:
    - id: deepseek-pricing
      name: dsh-plugin-deepseek-pricing
      config:
        liveSync: true
        cacheTtlMs: 1800000
        cnyRate: 7.2
```

> headless profile 同样登记（仅工具生效）；`dsh plugin --profile web add <包路径>` 亦可（需 pnpm）。

### 生效方式

| 改动 | 生效方式 |
| --- | --- |
| 客户端 bundle（`lib/client.js`） | 刷新浏览器页面 |
| host 端代码（`lib/index.js` / `lib/ui.js`） | 重启 `dsh web` |
| `cordis.patch.yml` 配置 | 热重载 |

## 配置项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `liveSync` | `true` | 官方定价页实时同步（失败自动回退内置表） |
| `pricingSourceUrl` | 官方定价页 | 数据源地址 |
| `cacheTtlMs` | 1800000 | 同步缓存时长（毫秒） |
| `fetchTimeoutMs` | 8000 | 拉取超时（毫秒） |
| `cnyRate` | 7.2 | USD→CNY 参考汇率（面板人民币显示与预估均使用） |
| `customPricing` | `null` | 完整定价文档覆盖（结构见 `DEFAULT_PRICING`） |

## 代码结构

| 文件 | 内容 |
| --- | --- |
| `lib/index.js` | 插件入口：配置、共享定价状态（TTL 缓存）、工具注册、`apply()` |
| `lib/pricing.js` | 定价数据模型与纯函数（峰谷判定、周期解析、HTML 解析、费用数学） |
| `lib/ui.js` | Web 路由（`/api/deepseek-pricing/snapshot`、`/api/deepseek-pricing/session-costs`）与快照/会话费用计算 |
| `lib/client.js` | 浏览器 bundle（侧边栏定价面板），经 `dsh.client` 动态加载 |

## 测试

```sh
node test/smoke.mjs
```

覆盖：峰谷时段边界、周期切换、费用数学、官方页面 HTML 解析、按时间戳逐轮计价、
未知模型回退、会话费用路由（活动/持久化）、客户端 bundle 工厂、工具注册。
