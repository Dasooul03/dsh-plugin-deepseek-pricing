# dsh-plugin-deepseek-pricing

DeepSeek 官方模型**实时定价查询**与**费用预估**的 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件。

- `deepseek_pricing`：查询 DeepSeek 官方模型的实时定价（每 1M tokens，USD）
  - **峰谷价按 UTC 时间自动判定**：高峰时段 01:00–04:00 与 06:00–10:00 UTC，其余时间为谷时（半价）；
    峰谷计价正式生效前自动使用官方现行统一价
  - 默认开启 **liveSync**：从官方定价页 <https://api-docs.deepseek.com/quick_start/pricing>
    实时拉取并解析（30 分钟缓存，失败自动回退内置表），保证价格与官方同步
- `estimate_cost`：按 **输入 token（缓存命中 / 未命中）+ 输出 token** 预估一次 API 调用的费用，
  自动套用当前生效的峰谷价；支持直接传 `text` 让模型按文本长度粗略预估输入 token 数（进阶用法）

## 安装

在 DSH 中，插件通过 loader entry 加载（`cordis.patch.yml`），包本体放入 profile 的 `node_modules`。
本插件为**自包含依赖**（自带 `node_modules`），因此本地 `file:` 链接也能正常解析依赖。

```sh
# 1) 安装插件包依赖（本插件目录内）
cd dsh-plugin-deepseek-pricing && npm install

# 2) 让 dsh 的 web profile 认识它（任选其一）
#    方式 A（推荐，官方途径，需要 pnpm）：
dsh plugin --profile web add /绝对/路径/dsh-plugin-deepseek-pricing
#    方式 B（免 pnpm，直接软链到 profile 的共享 node_modules）：
ln -s /绝对/路径/dsh-plugin-deepseek-pricing ~/.dsh/profiles/node_modules/dsh-plugin-deepseek-pricing

# 3) 在 profile 的 cordis.patch.yml 里登记 entry（web profile 即
#    ~/.dsh/profiles/web/cordis.patch.yml；改完会被热重载）：
```

```yaml
# cordis.patch.yml（追加到顶层数组）
- insert:
    - id: deepseek-pricing
      name: dsh-plugin-deepseek-pricing
      config:
        liveSync: true        # 官方定价页实时同步（默认 true）
        cacheTtlMs: 1800000   # 同步结果缓存 30 分钟
        cnyRate: 7.2          # 估算时的 USD→CNY 参考汇率
```

改完后可直接在对话中让 Agent 使用：

> 「查询 deepseek-v4-flash 当前是高峰价还是谷时价，每百万 token 多少钱」
> 「估算一下：deepseek-v4-pro，输入 5 万 token（其中 1 万缓存命中）+ 输出 2 万 token，要多少钱」

## 配置项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `liveSync` | `true` | 是否从官方定价页实时同步（失败自动回退内置表） |
| `pricingSourceUrl` | 官方定价页 | 数据源地址 |
| `cacheTtlMs` | 1800000 | 同步结果缓存时长（毫秒） |
| `fetchTimeoutMs` | 8000 | 拉取超时（毫秒） |
| `cnyRate` | 7.2 | 估算时 USD→CNY 参考汇率（仅估算，非实时汇率） |
| `customPricing` | `null` | 完整定价文档覆盖（结构见 `DEFAULT_PRICING`，含 `periods` 数组） |

## 工具说明

### `deepseek_pricing`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `model` | 否 | 只查某个模型（如 `deepseek-v4-flash`）；缺省列出全部 |
| `at` | 否 | ISO 8601 时间点，按该时刻判定峰谷（"如果那时调用会是什么价"） |
| `refresh` | 否 | 强制重新拉取官方定价页 |

返回：当前 UTC / 北京时间、峰谷状态（`flat` / `peak` / `off-peak`）、生效周期、
各模型的缓存命中 / 未命中输入价与输出价、数据来源与同步时间。

### `estimate_cost`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `model` | 是 | 模型 id |
| `inputTokens` | 否 | 输入 token 总数（非负整数） |
| `outputTokens` | 否 | 输出 token 数（默认 0） |
| `cacheHitInputTokens` | 否 | 其中命中上下文缓存的输入 token 数（默认 0，≤ inputTokens） |
| `text` | 否 | 未给 `inputTokens` 时，按文本长度粗略预估输入 token（启发式，非精确 tokenizer） |
| `at` | 否 | ISO 8601 时间点，按该时刻的峰谷价计费 |

返回：当前峰谷档位与单价、token 拆分、各项费用与合计（USD 与约合 CNY）。

## 定价数据

- 内置默认表随插件发布（`DEFAULT_PRICING`），离线可用；
- `liveSync` 开启时以官方定价页为准，页面解析失败自动回退并如实标注 `source: bundled`；
- 峰谷规则取自官方公告：高峰 01:00–04:00、06:00–10:00 UTC，谷时为峰时半价。
- 注意：本插件的价格与估算仅供参考，实际扣费以 DeepSeek 官方账单为准。

## Web 界面面板

配套界面包 [dsh-plugin-deepseek-pricing-ui](../dsh-plugin-deepseek-pricing-ui/) 会在
dsh Web 界面侧边栏加入「DeepSeek 定价」面板（实时价格表 + 峰谷状态 + 费用预估器），
数据通过本包导出的纯函数在 host 端提供（`GET /api/deepseek-pricing/snapshot`）。
详见该包 README。

## 开发与测试

```sh
npm install
node test/smoke.mjs                    # 纯逻辑冒烟测试
DS_PRICING_HTML=/tmp/pricing.html node test/smoke.mjs   # 附带真实页面解析测试
```

代码为 ESM，入口 `lib/index.js`（含详细注释），导出 `{ name, inject, Config, apply }`
供 dsh loader 加载，另导出全部纯函数便于复用与测试。
