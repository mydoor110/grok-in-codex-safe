# Codex / Grok 协作效率复盘（2026-09-20）

## 后续修复状态

本报告记录的是修复前基线。随后已完成对应整改：真实协议事件降噪与增量状态响应、
`list_dir`/带路径 `git diff` 兼容、Codex 规划与终审契约、显式有界子 agent、
ACP 每轮及累计 usage、软硬 token 预算、监督响应字节/决策唤醒代理指标、重复读取去重、
失败证据与无进展重试停止、只读 workspace drift 分类、effective effort 记录及风险默认档位。
并发上限之上的任务现在进入可取消 FIFO 队列；阶段依赖校验交付 manifest、成功验收、
阶段顺序及绑定源代码哈希的 Codex 审查证明。大响应只保留一个完整结构表示，游标后的
无变化查询不再重复整份 job。Codex 的真实 token/cache 计量仍由宿主掌握，插件明确标为
不可观测，不用字符数冒充 token。

## 结论与边界

当前插件已经建立可用的受监督执行基础，但尚未实现按任务收益分配模型、token、并发和审查资源的完整闭环。不能据此保证最优性能或每个 token 都被有效使用。

目标应是：在质量门槛达标的前提下，降低每个通过验收任务的耗时和 Codex 用量，让 Grok 承担更多可独立验证的工作。Grok 使用占比可以作为辅助指标，不能作为最大化目标。

审查对象是当前工作目录，包括原有未提交修改；本次复盘不修改运行时代码。基线 HEAD 为 `5b6e334d1ae1e7ecd96c82984e306faa5c751bc3`。已安装插件版本为 `0.5.8-safe.1+codex.20260920104325`，关键运行时、事件、控制、策略、MCP 和路由文件的 SHA-256 与工作目录一致。

本次运行 `node tests/run-tests.mjs`：191 项通过，0 失败，用时约 18.65 秒。另进行两项真实 Grok 只读并行审查，使用实际报告的 Grok 4.6 / CLI 1.0.30。测试通过不等于 token 效率最优，也不能替代完整代码任务的对照基准。

## 已有且应保留的能力

- Codex 最终审查职责明确：`skills/grok-routing/SKILL.md:19` 要求检查完整 diff、新文件和验证证据。验收成功仍保持 `reviewStatus=pending`。
- ACP 支持独立任务并行，默认每个 supervisor 三个活跃任务；本次两个只读任务同时进入运行状态。不同工作树允许并行写，相同写入目录有执行锁。
- `supervisor.mjs:19` 的精简快照、事件游标和落盘证据能够避免重复传输完整输出；`waitMany` 汇总多个任务。
- `supervisor.mjs:211` 起支持热连接及原会话恢复；无需每轮都重新探索代码库。会话恢复验证原工作区与基线，避免静默丢失上下文。
- `supervisor.mjs:288` 将确定性验收失败反馈给同一会话，默认最多两次自动修复；基础设施失败不进入这个模型重试路径。
- `retryVerification` 可只重跑验收，不再次调用模型；独立验证进程减少监督阻塞。
- 重复读取的哈希目前主要用于检测；ACP 回调不支持替换工具输出时明确不声称节省了模型输入 token，这一点是正确的。

## 优先级最高的问题

### P1：精简监督仍放过真实 CLI 的大量常规事件

位置：`scripts/lib/events.mjs:7,97`；`scripts/lib/job-policy.mjs:7,97`。

`supervisionEvent` 过滤 `text/thought/tool_call/tool_call_update`，但实际 CLI 发出的 `tool_call_delta_chunk`、`hook_execution`、`pending_interaction`、`interaction_resolved` 和多种协议通知会继续被当成重要事件。工具参数分片因此进入摘要、占用 24 条分页并唤醒等待。每 15 秒 heartbeat 同样唤醒 Codex，哪怕没有需要判断的新情况。

本次实跑捕获到了这些事件。纯函数检查也确认 `tool_call_delta_chunk` 和正常 heartbeat 均返回 `true`。这不是推测。

建议：按当前协议归一化已知常规事件；参数分片留在磁盘；将“健康检查心跳”和“需要 Codex 决策的通知”分离；首次未知事件保持可见并记录诊断，避免盲目丢弃未知失败。完成、权限拒绝、工具失败、预算阈值和控制回执立即送达。补充真实脱敏事件录制回放测试。

### P1：安全工具适配误拦截正常工作，浪费执行轮次

位置：`scripts/lib/job-policy.mjs:56,133`；`scripts/lib/acceptance.mjs:73`；`scripts/lib/control.mjs:23`。

- 实际 CLI 使用 `list_dir`，已知工具表仅包含 `ls/list_directory` 等名称，导致目录浏览失败。本次两个任务均触发。
- Shell 命令授权复用了文件路径 glob。`Bash(git diff*)` 中的 `*` 不匹配 `/`，导致 `git diff -- plugins/grok-safe/scripts/lib/events.mjs` 被拒绝，尽管 `git diff --stat` 允许。已通过最小调用复现，并在真实审查中发生。
- `&&` 被拒绝属于现有设计边界，不能与上述误拦截混为一谈；提示词应给出有效命令约束，减少无效尝试。

建议：适配已验证的原生工具名和参数；Shell 授权独立使用可执行文件及参数规则，保留路径边界和注入防护，不能简单放宽成任意 shell 权限。

### P1：分工指令与“Codex 主规划、Grok 主执行”目标并不完全一致

位置：`skills/grok-prompting/SKILL.md:25`；`skills/grok-routing/SKILL.md:27,67`；`scripts/lib/design.mjs:16`。

提示词技能明确写着“Do not Inspect the repo yourself”，路由又将模糊架构优先交给 `grok_plan/grok_design`。设计流程由 Grok writer/reviewer 循环主导。虽然 Codex 的最终审查责任存在，但缺少清晰的“Codex 先制定约束和验收 → Grok 调研执行 → Codex 裁决设计”的强制交接契约。

建议：Codex 负责目标、关键接口、不变量、风险、拆分、依赖和验收设计；Grok 承担搜索、候选分析、实现和测试。简单修复直接由 Codex 完成，避免调度固定成本。复杂任务允许 Grok 提供方案，但设计裁决及最终代码审查保留在 Codex。

### P1：多 agent 能力的宣称与默认运行路径冲突

位置：`scripts/lib/control.mjs:86`；`scripts/lib/design.mjs:16,49`；`scripts/lib/supervisor.mjs:73`；`mcp/server.mjs:137,715`。

- 默认 `noSubagents=true`，但设计提示词要求 `spawn_subagent`，execute-plan 提示词要求 worktree 子 agent。
- MCP 对 `bestOfN` 的描述仍是“并行尝试并保留最佳”，默认 ACP 实际拒绝 `bestOfN>1`。
- `grok_run/grok_rescue` 的 ACP 监督与专用 workflow/design/execute-plan 的 companion 路径并不等价。不能把某一路径的预算、实时控制、验收保证推及所有工具。
- `workflow.mjs` 主要发现外部 Rhai 脚本并构造调用提示词；`design.mjs` 的 DAG 执行也是委托原生技能的提示词，不是插件内可审计的 DAG 调度器。底层技能可能具备能力，但当前仓库不提供完整证明。

建议：优先使用 Codex 管理的多个独立 Grok job，保留各自权限、目录、预算和验收。修正不支持选项的文档/工具定义。受控嵌套子 agent 必须另行验证权限继承、预算共享、取消传播和使用量归属，不能直接关闭限制就声称已经解决。

### P1：缺少 token 使用与质量收益的可测量闭环

位置：`scripts/lib/usage.mjs:1`；`scripts/lib/events.mjs:106`；`scripts/lib/supervisor.mjs:229`；`scripts/lib/job-policy.mjs:7`。

Headless 有独立 usage 提取；ACP 只是收到 `usage_update` 后覆盖 `job.usage`。**真实 CLI 1.0.30 的本次事件把用量放在 `turn_completed.usage`，两项任务摘要均未记录 usage，但事件文件包含完整原生计量。** 这是已经复现的数据遗漏，不仅是设计缺口。另未见插件统一定义 session 累计量、单轮增量、恢复轮次及子任务之间的归属和去重。没有任务级 tokenBudget、Codex 监督 token 账本或按预算自动选择执行路线。现有 runtime 限制是时间、轮次和重试次数。

不能据此断言底层 usage 数字错误；插件漏读了实际事件，并缺少统一语义及完整性标记，无法证明两条路径可以横向比较。也不能把账户订阅额度、API token 费用和上下文窗口当成同一个量。

建议：建立统一 usage ledger，记录 provider/model/session/job/round、输入/输出/缓存/推理 token、计量来源和完整性。缺失为 unknown，不填 0；累计量和增量分别处理，不盲目相加。Codex 使用量若宿主不提供，就明确列为不可观测，先记录监督响应字节数和唤醒次数作为代理指标。预算用软阈值→收尾→硬截止，并设置明确的全任务上限。

## P2：并行与复用还需要补齐的环节

1. **并发只有限流，没有收益导向调度。** `supervisor.mjs:56,67` 默认三任务，满额即抛错；未实现自动排队、按任务依赖调度、账户限流退避、CPU/测试压力反馈或按审查负载调节并发。这个三任务上限只覆盖同一个 supervisor 的受管任务，不是全局账户限额。
2. **未提交基线可能造成返工。** `execution-workspace.mjs:25` 新写入 worktree 从 commit 创建，不含本地未提交依赖；已有警告但需要 Codex 明确选择基线。并行结果汇合应绑定基线、变更哈希和依赖版本，再做集成验收。
3. **重复读取指标会把一次逻辑读取算两次。** `job-policy.mjs:145` 的 pre-tool 检查调用 `inspectFile`，`supervisor.mjs:186` 的读取回调再次调用它。本次观察到 filesRead 与 duplicateReads 同步增长；最小调用复现了一次读取即 duplicateReads=1。安全检查与使用量计数应分离，按 toolCallId 和实际范围计数，避免错误的重复读取告警。
4. **重试没有利用完整失败证据。** `supervisor.mjs:289` 回传 `acceptanceFailures` 字符串；可进一步附上有界的失败测试 stderr/断言及证据引用，比较连续两轮失败签名。相同失败无进展时交给 Codex 重新规划，而不是用尽固定重试次数。
5. **审查结论未形成持久闭环。** 结果保留 `reviewStatus=pending` 是正确的安全边界，但仓库缺少与实际 diff 哈希绑定的 Codex 审查结论记录及失效机制。`acceptance.mjs:241` 的阶段依赖只检查上游 JSON status，不是完整 DAG、审查及集成状态证明。
6. **默认 effort 未按任务分级。** 未显式传入 effort 时沿用原生设置；本次原生会话通知显示 xhigh，而 job.effort 未填写。审查任务使用较高 effort 可以合理，但不能假定所有执行任务都会自动选择经济档。应记录 effectiveEffort，并按任务风险显式选择受支持档位。
7. **只读任务会将并发外部修改归因于自身，并尝试无效返工。** 本次 Codex 在第一项审查完成前写入本报告，随后验收报告 `Read-only task changed the workspace` / `Unexpected untracked files: docs/codex-grok-efficiency-review-2026-09-20.md`。`supervisor.mjs:289` 对这个失败启动模型重试，没有区分外部工作区变化与 worker 可修复问题。Codex 随后取消返工。该问题由本次审查操作触发，不能归因于 Grok 擅自写入。建议为只读审查提供固定快照，或将无法归属的并发修改标为 `workspace-drift` 并交给 Codex；禁止要求只读 worker 修复此类验收失败。

## 本次真实运行证据

两项任务的首轮原生 `turn_completed.usage` 如下；这些数字来自 Grok 事件，含缓存输入，不等于非缓存计费量，也不用于推算订阅额度或美元成本。

| 任务 | 输入 token | 输出 token | 原生 totalTokens | 缓存读取 token | 模型调用数 |
|---|---:|---:|---:|---:|---:|
| 运行时审查 `review-mu9ux2by-6h0por` | 338888 | 11880 | 350768 | 264960 | 7 |
| 路由审查 `review-mu9ux6hh-4ssnh0` | 350180 | 7509 | 357689 | 262016 | 9 |

路由审查正常完成，约 181 秒。运行时审查首轮已产生完整结论，约 246 秒；随后受上述 Codex 写报告导致的工作区变化影响进入返工，该额外轮次原生报告 `totalTokens=79481`，其中缓存读取 65664。已取消后续执行；这不是完整成功交付的第二项运行。

路由审查的 1721 条原始事件中，203 条被当前函数视为需要监督，含 56 条工具参数分片、12 条 heartbeat。它们不是实际 Codex 唤醒次数，但证明摘要仍可混入大量常规事件。一次 steer 从收到至交付约 16.6 秒，最终得到 acknowledged，说明控制通道可用，同时存在工具边界交付延迟。

两项 Grok 报告仅作辅助审查。Codex 未采用其中过强的推断，例如“Grok 可代替 Codex 终审”“默认并发三等于存在全局串行锁”“原生 DAG 完全不存在”，也不采纳直接放开子 agent 权限或盲目累加 usage 的建议。

## 建议的协作方式

### 补充：Codex 侧重复上下文与缓存（追查）

问题主要是重复向模型返回内容，不是磁盘缓存文件本身。对上述两个完成/停止后的 job 调用 `publicExecution(job, 'summary')`，JSON 分别为 6833 和 8114 字符；将事件 cursor 推至最新后，事件确实为空，但 `snapshot()` 仍返回整份 job 摘要。这表明 cursor 只增量化 events，没有增量化 job 字段。两项摘要合计 14947 字符，若无变化仍获取十次，仅重复摘要就约 14.95 万字符；这是响应体体积示例，不是实际 token 计费数字。

- `availableCommands` 每个摘要约 1005 字符，此外基线、路径、acceptance、已完成回执与结果前缀均可能反复返回。应将静态元数据首轮返回，后续以 stateRevision 和 changedFields 表达变化。
- `waitMany` 任何一项返回后再次汇总所有目标；已完成且无需处理的目标应由调用者移出等待集合，否则其快照会继续被复述。
- `worker.currentText` 累积多个 assistant text 分片；精简结果取前 2000 字符。实跑结果开头包含多段进度叙述，可能挤占最终结论。应分离 commentary 与 final，并提供有界结构化结论以及证据定位。
- MCP 的完整 30 个工具定义序列化为 73902 字符，多个工具重复公共 schema。宿主可能按需加载，因此不能声称这些字符每轮全部进入 Codex；应检查实际暴露路径并减少无必要描述重复。
- MCP 同时返回 `structuredContent` 与相同 JSON 的 `content.text`；本次 `text(result)` 展示过两份。是否两份都进入模型依赖宿主/调用方式，不能将其作为所有请求必然双倍计费的结论。执行编排应只输出其中一种必要视图。
- 本次审查还存在 Codex 与 Grok 读取范围重叠、工具描述大范围输出和两种结果表示重复展示；这是本次操作层面的可改进消耗。应让 Grok 先返回证据索引，Codex 再读取支持关键结论的代码；最终代码交付仍需完整审查改动。

本地安装目录、旧日志、工作树和事件文件只是存储；不被读入模型就不消耗 Codex 输入 token。清理磁盘不能移除已经进入当前对话的内容。Prompt cache 是对匹配前缀的状态复用；把旧 JSON 再追加成新工具消息仍会增长上下文，不能假设因为内容相同就免费。插件无法观测本次 Codex 的逐请求 cached_tokens、cache_write_tokens 或宿主计费，故目前只能确认重复输入及其字符规模，不能给出浪费比例。

优先改进：真正的增量状态响应、仅决策事件唤醒、静态元数据引用化、commentary/final 分流、单一结果表示、完成任务移出等待集合。保留失败证据、缺口提示和完整 diff 审查能力。

参考：https://developers.openai.com/api/docs/guides/prompt-caching

| 阶段 | Codex | Grok | 交接证据 |
|---|---|---|---|
| 定义任务 | 确定边界、关键设计、不可破坏条件、验收 | 收集指定范围事实，可做候选比较 | 基线、路径、接口、依赖、测试契约 |
| 执行 | 只处理阻塞、设计变化和预算升级 | 独立实现、测试、局部修复，必要时并行 | 改动清单、测试回执、风险、usage |
| 审查 | 阅读完整改动与新文件，判断业务语义及架构 | 回答证据问题，执行定点返工 | 绑定 diff 哈希的审查结果 |
| 汇合 | 冲突裁决、集成验收、最终交付 | 完成指定整合修复 | 最终基线、集成测试、剩余问题 |

建议从现有 2–3 个独立 Grok worker 起步，以基准结果调整；这只是初始实验设置，不是测出的最优值。按不重叠模块分工通常优于三个 worker 全量重复同一个任务。多方案竞争仅用于高不确定性、高返工成本的问题，并设置明确候选数和停止条件。

## 实施顺序与验收

1. **先消除摩擦**：原生工具适配、命令授权误匹配、真实事件压缩、重复读取计量、技能与工具描述一致性。用本次失败命令和事件录制做回归，保证失败/拒绝仍及时可见。
2. **再建立分工与预算**：结构化任务契约、模型/effort 分级、统一 usage、稳定失败升级、审查证据记录。不得把 Grok 的自评当成 Codex 已审查。
3. **最后扩大并行**：队列、依赖与写入范围冲突检查、资源背压、汇合集成验收、可恢复任务状态。必要时增加受控嵌套 agent。
4. **做对照实验**：同一批真实修复/重构任务分别跑 Codex 单独、Codex+单 Grok、Codex+多 Grok；控制基线、测试和质量门槛，多次重复。

核心指标：首次验收通过率、最终缺陷/返工率、端到端 p50/p95 耗时、每个验收成功任务的两端 token、重复上下文比例、Codex 唤醒次数/监督字节数、无进展重试数、并行冲突数。缺失 usage 单独标记覆盖率。只有在质量不退化的前提下，才比较耗时和 token 的改进。

官方 OpenAI 文档也明确指出，多子 agent 会引入额外模型与工具工作，通常比相当的单 agent 流程使用更多 token；因此并行的收益必须用任务完成时间和结果质量衡量。来源：https://learn.chatgpt.com/docs/agent-configuration/subagents

本报告尚不提供“节省百分之多少”的数字：两项只读实跑足以证明兼容性问题和并行基础，不能证明完整开发任务的最优经济性。
