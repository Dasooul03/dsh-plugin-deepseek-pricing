# dsh-plugin-deepseek-pricing

DeepSeek 官方模型**实时定价**与**费用预估**的 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）插件合集。

本仓库包含两个插件包：

| 包 | 作用 | 说明 |
| --- | --- | --- |
| [`dsh-plugin-deepseek-pricing/`](dsh-plugin-deepseek-pricing/) | Agent 工具 | `deepseek_pricing` 查询实时定价（峰谷价按 UTC 时间自动判定）、`estimate_cost` 按 token 预估费用；liveSync 从官方定价页实时同步 |
| [`dsh-plugin-deepseek-pricing-ui/`](dsh-plugin-deepseek-pricing-ui/) | Web 界面 | 在 dsh Web 侧边栏注入「DeepSeek 定价」面板：实时价格表、峰谷状态、费用预估器 |

## 功能亮点

- **峰谷计价自动切换**：高峰时段 01:00–04:00、06:00–10:00 UTC，其余时间为谷时（半价）；官方统一价阶段自动识别，峰谷计价生效时间点自动过渡
- **实时数据**：默认从 DeepSeek 官方定价页 <https://api-docs.deepseek.com/quick_start/pricing> 拉取解析（30 分钟缓存，失败自动回退内置表）
- **费用预估**：输入 token（拆分缓存命中/未命中）+ 输出 token → USD 与约合 CNY；也支持按文本长度粗略预估输入 token
- **无需重启**：UI 包走 dsh 的 `dsh.client` 动态插件机制，web 实例热加载，浏览器刷新即可见

## 安装

```sh
# 两个包分别安装依赖
cd dsh-plugin-deepseek-pricing && npm install
cd ../dsh-plugin-deepseek-pricing-ui && npm install

# 软链到 dsh profile 共享的 node_modules（所有 profile 通用）
ln -s "$PWD/dsh-plugin-deepseek-pricing" ~/.dsh/profiles/node_modules/dsh-plugin-deepseek-pricing
ln -s "$PWD/dsh-plugin-deepseek-pricing-ui" ~/.dsh/profiles/node_modules/dsh-plugin-deepseek-pricing-ui
```

在 profile 的 `cordis.patch.yml` 中登记：

```yaml
- insert:
    - id: deepseek-pricing
      name: dsh-plugin-deepseek-pricing
      config:
        liveSync: true
        cacheTtlMs: 1800000
        cnyRate: 7.2
    - id: deepseek-pricing-ui
      name: dsh-plugin-deepseek-pricing-ui
      config:
        liveSync: true
        cacheTtlMs: 1800000
        cnyRate: 7.2
```

> 需要 pnpm 时也可用 `dsh plugin --profile web add <包路径>` 安装。

## 测试

```sh
cd dsh-plugin-deepseek-pricing && node test/smoke.mjs
cd ../dsh-plugin-deepseek-pricing-ui && node test/smoke.mjs
```

## 许可

MIT
