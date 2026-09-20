# 可靠性、运行环境与低消耗监管

## 派发前

ACP 在启动模型前检查验证入口及其本地静态导入，并实际启动验证器自检。随后解析要求的
验证命令，检查可执行程序和工作区可写性。错误区分安装不完整、程序不存在、不可支持的
Windows shell 包装器和权限问题。不会自动安装依赖或扩大命令权限。

Grok 接收实际解释器路径、验证命令、执行目录、临时目录用途以及 allow/deny 规则。
原生工具可见不等于可用；文件边界、敏感文件规则和命令拦截继续生效。
项目依赖的动态导入不能仅靠预检证明完整，具体错误仍由测试执行记录。

默认每个 MCP 服务最多同时运行 3 个 Grok 任务；超限明确拒绝，主控可等待后重试。
写任务和会话恢复持有跨进程工作区锁；独立只读任务可以并发。新隔离工作区仍从提交版本创建，
返回 startingState、sourceDirty 和必要的 baselineWarning，不悄悄复制未提交修改。
较大的提示、路径数量或验证命令数量产生范围提示，主控负责语义拆分。

## 状态与验收

任务分别记录 implementationStatus、artifactStatus、testStatus、infrastructureErrors、
reviewStatus 和 integrationStatus。模型说完成不是批准，reviewStatus 保持 pending，
integrationStatus 保持 not-merged。验证基础设施故障保留工作区、结果及可取得的快照，
不会自动让模型反复重写代码。

运行时每 `heartbeatSeconds`（默认 15）发出 `heartbeat` 监管事件，包含 phase、
currentAction、blockingReason、lastActivityAt 和是否 mutatesProduction。心跳会唤醒
`grok_wait`；连续心跳在重要事件列表中折叠为一条。有活动工具或处于 verifying 时
不因空闲判 STALLED。headless 180 秒看门狗同样要求「无工具且无 git 变化」。

验收契约里的预检、阶段和清理都是通用字段：只检查调用方列出的工具名、环境变量、
端口和 Compose 文件，不内置某个产品的 JDK/Maven/登录模式。Docker 清理只对比任务
开始时的资源快照，结束时列出残留。最终报告在 `artifacts/<jobId>/`。

`grok_retry_verification(cwd, jobId)` 对停止的任务单独重跑原有验收，保留验证历史，
不调用 Grok、不修改验收条件、不自动审核或合入。它可能执行用户原先授权的测试命令。
验证基础设施修复后再调用；不能把“重试成功”解释为 Codex 已审查全部改动。

## 事件、控制与成本

`grok_wait_many(cwd, targets=[{jobId,cursor},…], timeoutMs=60000)` 支持 1–8 个任务，
任一任务有监管事件即可返回。等待结束会撤销其他监听，不留下持续轮询。

默认摘要分页最多 24 个监管事件；大型字段返回 evidenceFile / eventsFile 引用。
`hasMore=true` 时用返回的 cursor 继续；gap=true 时补读证据。事件带 jobId、round、
timestamp、replayed；断线后读取明确标注 eventSource=history、liveConnection=false。
终止的服务不会被误报成仍有实时连接，死进程任务改为 interrupted 并要求恢复。

文本和工具明细继续记录，采用批量异步写入；历史加载采用流式读取并缓存，避免每次查询
同步解析全部日志。普通权限钩子的检查点写入合并到短时间窗口，关键生命周期和消息接收仍持久化。
大型结果、测试和错误引用必须在作出相应审核决策前补读，精简输出不是降低审查范围。

消息状态分为 received、delivered、acknowledged；最后一个只表示对应 prompt 已返回，
不代表补充要求已通过验收。验收期间的新消息会在结束前进入下一轮。interrupt-stopped
只在原 prompt 实际返回后出现。执行测试期间的取消需等待受超时限制的验证进程返回，
不声称已即时停止测试或其所有子进程。

指标分别统计已授权操作开始/完成、唯一读取文件和读取版本；未观察到停止边界时轮次为 null。
写入路径计数不是实际 diff，产出判断仍以独立快照和验收为准。重复读取和阶段时间使用到 70%
会告警，附检查点/拆分建议；已有阶段硬预算继续有效。

## 升级

普通执行仅探测必要 CLI 命令，完整帮助目录按需收集。ACP 严格检查协议版本和监管 hooks，
每轮分别验证 stop 回调，只认可明确的 end_turn 为正常完成。未知结束原因不会直接通过验收。
MCP 对支持的协议版本进行协商，不再随意回显未知版本。

Grok 更新后运行实际 ACP 初始化/能力握手；缺少监管能力报告 update-failed、recoveryRequired，
不报告兼容成功。不会自动回滚二进制，因为原生更新可能同时更改配套文件；需恢复已知兼容安装。
新版本的任意语义变化仍需回归测试，能力握手不等于对未来所有版本的保证。

发布前运行 `npm test`，其中 reliability.test.mjs 覆盖真实 ACP 子进程、隔离写入和真实
验证器子进程的完整链路；模型响应使用本地模拟，不消耗 Grok token。
