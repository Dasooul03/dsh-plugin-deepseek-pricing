# DSH Price Monitor（价格监控）

> 技术包名：`dsh-plugin-deepseek-pricing`

DeepSeek 官方模型**实时定价查询**、**会话费用统计**与**费用预估**的 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）插件。**单一插件包**同时提供 Agent 工具与 Web 定价面板。

## 功能亮点

### 🧰 Agent 工具（任意 profile 可用）

- **`deepseek_pricing`**：查询 DeepSeek 官方模型实时定价（每 1M tokens，缓存命中/未命中输入、输出）
  - **峰谷价按 UTC 时间自动判定**：高峰 01:00–04:00、06:00–10:00 UTC，其余为谷时（半价）；
    官方统一价阶段自动识别，峰谷计价生效时间点自动过渡
  - 支持 `at` 参数按任意时刻评估、`refresh` 强制同步官方定价页
- **`estimate_cost`**：按输入 token（拆分缓存命中/未命中）+ 输出 token 预估一次调用费用，
  自动套用当前峰谷价，输出 USD 与约合 CNY；也支持传 `text` 由文本长度粗略预估输入 token

### 🖥️ Web 定价面板（左侧边栏底部）

- **未展开**：徽标直接显示 **会话总费用** 与 **本轮对话费用**（人民币）
- **展开面板**（从上到下）：
  1. **会话费用**（置顶）：本轮对话 / 会话总花费两张卡片（人民币为主、美元为辅），
     下方附**逐轮明细**（轮次 · 发生时间 · 模型 · token 数 · 费用）
  2. 价格表：两个模型的每 1M tokens 价格（USD + 人民币换算），高峰/谷时双档显示，当前档位高亮
  3. 费用预估器：选模型 + token 数（可拆缓存命中）→ 实时算出 USD 与约合 CNY
- **自动跟随当前会话**：切换会话立即重算；每 10 秒自动刷新（每轮对话结束后约 10 秒内金额更新）

### ⏱️ 会话费用计算原理

- 每一轮（turn）的费用 = 该轮内每条模型消息上报的用量
  （`inputTokens` 缓存未命中、`cacheReadTokens` 缓存命中、`outputTokens` 输出）
  按**该消息自身的 time 时间戳**取当时生效的峰谷价格逐条计价后求和
- 模型按该轮消息来源分别计价（`deepseek-v4-flash` / `deepseek-v4-pro`），未知模型自动回退并注明
- 数据来源：优先读内存中的活动会话，其次从持久化会话日志（JSONL）读取，**历史会话同样可算**

### 📡 数据实时性

- 默认从 DeepSeek 官方定价页 <https://api-docs.deepseek.com/quick_start/pricing> 拉取解析
  （30 分钟缓存，失败自动回退内置表）
- 峰谷状态随 UTC 时间实时判定，到点自动切换，无需任何操作

## 快速开始

```sh
# 1) 安装依赖
cd dsh-plugin-deepseek-pricing && npm install

# 2) 软链到 dsh profile 共享的 node_modules（所有 profile 通用）
ln -s "$PWD/dsh-plugin-deepseek-pricing" ~/.dsh/profiles/node_modules/dsh-plugin-deepseek-pricing

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

> headless profile 同样登记（仅 Agent 工具生效，无 Web 面板）。
> 需要 pnpm 时也可用 `dsh plugin --profile web add <包路径>` 安装。

### 生效方式

| 改动 | 生效方式 |
| --- | --- |
| 客户端 bundle（`lib/client.js`） | **刷新浏览器页面**即可 |
| host 端代码（`lib/index.js` / `lib/ui.js`，如新增路由） | **重启 `dsh web`** |
| `cordis.patch.yml` 配置 | 热重载，无需重启 |

## 配置项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `liveSync` | `true` | 是否从官方定价页实时同步（失败自动回退内置表） |
| `pricingSourceUrl` | 官方定价页 | 数据源地址 |
| `cacheTtlMs` | 1800000 | 同步结果缓存时长（毫秒） |
| `fetchTimeoutMs` | 8000 | 拉取超时（毫秒） |
| `cnyRate` | 7.2 | 费用换算的 USD→CNY 参考汇率（界面人民币显示与预估均使用） |
| `customPricing` | `null` | 完整定价文档覆盖（结构见 `DEFAULT_PRICING`，含 `periods` 数组） |

## 代码结构

| 文件 | 内容 |
| --- | --- |
| `lib/index.js` | 插件入口：配置、共享定价状态（TTL 缓存）、Agent 工具注册、`apply()` |
| `lib/pricing.js` | 定价数据模型与纯函数（峰谷判定、周期解析、官方页 HTML 解析、费用数学） |
| `lib/ui.js` | Web 路由（快照 / 会话费用）与快照、逐轮费用计算（host 半边） |
| `lib/client.js` | 浏览器 bundle：侧边栏定价面板（经 `dsh.client` 声明动态加载） |

## 与 Agent 配合使用

在任意对话中可直接让 Agent 查询或估算：

> 「查询 deepseek-v4-flash 当前是高峰价还是谷时价，每百万 token 多少钱」
> 「估算一下：deepseek-v4-pro，输入 5 万 token（其中 1 万缓存命中）+ 输出 2 万 token，要多少钱」

## 开发与测试

```sh
cd dsh-plugin-deepseek-pricing && npm install && node test/smoke.mjs
```

测试覆盖：峰谷时段边界、周期切换、费用数学、官方页面 HTML 解析、按时间戳逐轮计价、
未知模型回退、会话费用路由（活动会话/持久化兜底）、客户端 bundle 工厂、工具注册。

## 许可

MIT
