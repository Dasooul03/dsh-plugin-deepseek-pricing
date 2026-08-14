# dsh-plugin-deepseek-pricing-ui

DeepSeek 定价的 **Web 界面包**：在 dsh Web 界面左侧边栏底部注入一个
「DeepSeek 定价」入口，点开即见：

- **实时价格表**：`deepseek-v4-flash` / `deepseek-v4-pro` 的每 1M tokens 价格
  （缓存命中 / 缓存未命中输入、输出），高峰价与谷时价分档显示，当前档位高亮
- **计费状态**：当前是统一价 / 高峰 / 谷时（峰谷按 UTC 时间自动判定），
  显示北京时间、生效日期、高峰时段、数据源与同步时间
- **会话费用（自动）**：跟随当前打开的会话，自动显示
  **本轮对话花费** 与 **会话总花费**（USD + 约合 CNY），并附逐轮明细
  （轮次、发生时间、模型、token 数、费用）
- **费用预估器**：选模型 + 输入 token 数（可拆缓存命中）→ 实时算出 USD 与约合 CNY
- 每 10 秒自动刷新会话费用（每轮对话结束后约 10 秒内更新）；价格档位每 30 秒刷新；
  「刷新」按钮强制从官方定价页重新同步

## 会话费用如何计算

- 每一轮（turn）的费用 = 该轮内每条模型消息上报的用量
  （`inputTokens` 缓存未命中、`cacheReadTokens` 缓存命中、`outputTokens` 输出）
  按 **该消息自身的 time 时间戳** 取当时生效的峰谷价格逐条计价后求和 ——
  高峰 / 谷时按每条消息的实际发生时刻判定，模型按该轮消息来源（flash / pro）分别计价
- 数据来源：优先读内存中的活动会话，其次从持久化会话日志（JSONL）读取，历史会话同样可算
- 说明：客户端运行时未向第三方插件暴露“轮次结束”事件，因此采用
  会话列表订阅 + 10 秒轮询的方式，保证每轮结束后尽快更新金额

## 架构

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| host | `lib/index.js` | 注册同源只读路由 `GET /api/deepseek-pricing/snapshot[?refresh=1]`（实时价格）与 `GET /api/deepseek-pricing/session-costs?session=<id>`（逐轮费用），复用 `dsh-plugin-deepseek-pricing` 的抓取 / 解析 / 峰谷判定逻辑（自带 30 分钟 TTL 缓存） |
| client | `lib/client.js` | `window.__ModuleLoader__` 格式的浏览器 bundle，向 `sidebar.footer.action` 槽注入定价面板 |

客户端插件通过包内 `dsh.client` 声明被发现（`platform: "web"`、`inject: ["slots", "locale", "sessions"]`），
bundle 由 dsh 的 `ClientModuleRegistry` 以 `/plugins/dsh-plugin-deepseek-pricing-ui/client.js`
动态提供给 web 前端，**无需重新构建前端**。

> 注意：修改 host 端代码（`lib/index.js`）后需要**重启 `dsh web`** 才会加载新路由；
> 修改客户端 bundle（`lib/client.js`）只需刷新浏览器页面。

## 安装

```sh
# 1) 安装依赖（会以 file: 链接 dsh-plugin-deepseek-pricing）
cd dsh-plugin-deepseek-pricing-ui && npm install

# 2) 链接到 dsh profile 的共享 node_modules
ln -s /绝对/路径/dsh-plugin-deepseek-pricing-ui ~/.dsh/profiles/node_modules/dsh-plugin-deepseek-pricing-ui

# 3) 在 web profile 的 cordis.patch.yml 中登记（追加到顶层数组）：
```

```yaml
- insert:
    - id: deepseek-pricing-ui
      name: dsh-plugin-deepseek-pricing-ui
      config:
        liveSync: true
        cacheTtlMs: 1800000
        cnyRate: 7.2
```

配置项与 `dsh-plugin-deepseek-pricing` 一致（`liveSync` / `pricingSourceUrl` /
`cacheTtlMs` / `fetchTimeoutMs` / `cnyRate`）。

改完后**刷新一次浏览器页面**（引导清单按页注入），侧边栏底部即出现「DeepSeek 定价」入口。

## 测试

```sh
npm install
node test/smoke.mjs   # host 路由 + client 工厂冒烟测试
```
