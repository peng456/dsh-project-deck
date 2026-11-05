# 自主推进协议（Autonomy protocol）

每个项目有一个三档开关：`off` / `assist` / `auto`。默认 `off`。

| 档位 | agent 可以做什么 |
|---|---|
| `off` | 只汇报，不提案、不动手 |
| `assist` | 卡住时给出 2–3 个选项 + 推荐 + 理由，等你一句话；不动手 |
| `auto` | 自己查事实、自己选方案、做**可逆**的动作（调查/写代码/开分支/跑测试），把**不可逆**的放进审批队列 |

## 红线（任何档位都必须先问）

- push 到主分支 / 合并 / 打 tag
- 删除文件、分支、数据
- 发布（npm、公众号、部署到线上）
- 花钱、开通服务
- 对外发送消息（微信、邮件、评论）
- 修改全局配置（DSH profile、launchd、系统设置）

## 怎么用

```bash
deck autonomy                    # 看所有项目的模式
deck autonomy my-app auto        # 打开自主推进
deck autonomy my-app assist --max 5
deck decide my-app --question "ORM 选型" --options "Prisma|Drizzle" --choice Drizzle \
  --why "更小、SQL 可控、现有 schema 直接映射" --reversible
deck ask my-app --question "要不要删掉旧后台" --options "删|保留|先归档" --recommend "先归档"
deck approvals                   # 待你拍板
deck approvals --approve ap-1234 --choice "先归档"
deck decisions --limit 20        # 我替你做过的决定
```

## agent 执行协议（在会话里工作时）

1. 先 `deck approvals`：有待批的先处理（你能拍板就直接处理；不能就跳过）。
2. `deck autonomy <id>` 看模式与今日预算；`off` 就只汇报。
3. **卡点先分类**：
   - 事实不清 → 自己查（日志、代码、命令），查不到再问；
   - 方案选择 → 自己选，用 `deck decide` 记录理由；选错成本高就升级为 `deck ask`；
   - 价值/风险/不可逆 → 一律 `deck ask`，然后**继续做别的**，不要干等。
4. 可逆动作优先：先分支、先备份、先 dry-run。
5. 连续 3 次尝试失败（测试红 / 命令报错）→ 停手，`deck ask` 一条说清「卡在哪 + 我试过什么」。
6. 每日自主动作上限（默认 3）用完就降级为 `assist`，不要绕过。

## 审计

- `~/.project-deck/decisions.jsonl`：每一条自主决策（时间、项目、问题、选项、选择、理由、是否可逆）；
- `~/.project-deck/approvals.json`：等你拍板的队列；
- 播报里会出现「等你拍板：N 项」和「自主推进：auto N · assist N」；
- 不信任随时 `deck autonomy <id> off` 一刀切。
