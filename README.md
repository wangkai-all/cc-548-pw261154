# 实验室回执对单

实验室回执偶尔比采样登记早到，相同样本号还可能在不同工厂重复使用。本演示页把这条业务链做成一次可核对的本地操作：

- **接收早到回执**：来信先保存；能按「工厂 + 批次 + 样本号」匹配到有效登记就立即对单，匹配不到则保留为待处理（孤立回执），可一直等待，也可请求补登记。
- **撤销一份登记**：撤销后，与它已对单的回执退回「待处理」，抽样结论从看板撤下；可重新登记同一样本或恢复原登记来重新认领。
- **查看抽样对单**：按工厂 → 批次 → 样本号汇总，重复回执单独标识、不重复计入已对单样本。

页面右侧「操作证据」卡片在每次操作后展示同一份业务结果的前后计数、逐条状态迁移和原始 JSON，便于核对操作前后内容；业务结果区带 `data-evidence-result` 属性，并在每次操作后同步写入 `data-evidence-action` / `data-evidence-ok` / `data-evidence-before` / `data-evidence-after` / `data-evidence-changes`，可直接从 DOM 读取操作前后计数。

## 运行

```bash
node server.js            # 默认 http://127.0.0.1:3000
PORT=8080 node server.js  # 读取 PORT 环境变量
```

- 仅使用 Node.js 内置模块（`http` / `fs` / `path` / `node:test`），无第三方依赖。
- 固定绑定 `127.0.0.1`，不连接任何外部服务。
- 数据保存在进程内存中，重启即恢复演示数据；页面上可随时点「恢复演示数据」。

## 本地样例

`data/demo-scenario.json` 是唯一的演示数据来源，按业务时间顺序执行：早到回执、跨厂同样本号、同批次同样本号、重复投递、孤立回执 + 请求补登记。样例时间固定在 2026-11-20（页面按 `Asia/Shanghai` 展示）。

演示数据初始口径：

| 指标 | 数值 |
| --- | --- |
| 登记 | 8（4 已对单 / 4 待回执） |
| 回执 | 8（4 已对单 / 3 待处理 / 1 重复） |
| 已对单样本 | 4 |
| 对单样本数（工厂 + 批次 + 样本号去重） | 11 |

推荐演示顺序：

1. 点「接收早到回执」→ 选快捷项「重复投递 · 华东一厂 / B-2405 / S-1003」并提交：回执记为**重复回执**，`已对单样本` 不变，`重复回执` +1。
2. 点「撤销一份登记」→ 选 `华东一厂 / B-2406 / S-1001`（已对单）确认撤销：`已对单样本` 4 → 3，`待处理回执` 3 → 4，证据区出现「回执退回待处理」的状态迁移。
3. 点「查看抽样对单」：看板刷新，`华东一厂 / B-2406` 批次提示「1 份回执因登记撤销退回待处理」，S-1001 的回执变回「待处理」。

也可在「采样登记」页对撤销的登记点「恢复」，验证回执重新对单。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/board` | 看板数据（计数、登记、回执、对单摘要） |
| GET | `/api/reconciliation?factory=` | 抽样对单结论（可按工厂筛选），附 `VIEW_RECONCILIATION` 证据 |
| POST | `/api/reports` | 接收回执，字段 `factory` `batch` `sampleNo` `result`，可选 `receivedAt` `messageId` `id` |
| POST | `/api/registrations` | 建立采样登记，字段同上（`registeredAt` 可选） |
| POST | `/api/reports/:id/backfill` | 请求补登记，可选 `note` |
| POST | `/api/reports/:id/return` | 人工退回待处理回执，可选 `reason` |
| POST | `/api/registrations/:id/revoke` | 撤销登记，必填 `reason` |
| POST | `/api/registrations/:id/restore` | 恢复已撤销登记并重新认领回执 |
| POST | `/api/reset` | 恢复演示数据 |

所有写接口与对单查询都返回 `evidence`：

```json
{
  "action": "REVOKE_REGISTRATION",
  "ok": true,
  "summary": "登记 REG-0003 已撤销，1 份回执退回待处理",
  "changes": [
    { "entity": "registration", "id": "REG-0003", "from": "MATCHED", "to": "REVOKED", "note": "..." },
    { "entity": "report", "id": "LR-0006", "from": "MATCHED", "to": "PENDING_MATCH", "note": "..." }
  ],
  "before": { "matchedSamples": 4, "pendingReports": 3 },
  "after": { "matchedSamples": 3, "pendingReports": 4 }
}
```

失败时返回 4xx 与 `{ ok: false, error: { code, message }, evidence }`，`evidence.ok === false`、`before/after` 为 `null`，页面据此展示错误而不污染上一次的成功证据。

## 业务口径

- 样本唯一键：**工厂 + 批次 + 样本号**（比较时忽略大小写与首尾空格），所以不同工厂可复用同一样本号。
- 重复回执判定：同键已存在有效回执（未被退回）时，新回执记为 `DUPLICATE` 并指向首份回执，**不增加已对单样本数**；`messageId` 相同的重复投递直接幂等返回原回执。
- 登记撤销：与之关联的已对单回执退回 `PENDING_MATCH`，待处理回执不再关联该登记；撤销无回执的登记不会凭空产生待处理回执。
- 已对单回执不能直接退回，需先撤销登记（保证「结论撤回」只有一条路径）。
- 同一键存在有效登记时拒绝重复登记，撤销后允许重建。

## 测试

```bash
node --test
```

覆盖：

- 领域：早到/晚到回执对单、跨厂与跨批次同号隔离、重复回执不计数、`messageId` 幂等、撤销登记退回待处理、重新登记/恢复后重新认领、补登记、人工退回、参数校验、重复撤销、聚合口径。
- HTTP：`PORT` 解析、全部接口的正常与错误结果（400/404/405/409）、演示数据重置、静态资源与路径穿越、页面关键按钮与 `data-evidence-result` 存在性，以及「接收早到回执 → 撤销登记 → 查看对单」在同一次会话内前后结果可核对。
- 演示样例：JSON 可独立载入、覆盖四类情形、撤销→退回→恢复全流程。
