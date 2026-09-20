# 可验证交付契约与清单覆盖情况

本轮优先修复代码写任务的完成判定、验收、隔离与恢复。`grok_rescue`
新增 `acceptance`；CLI 对应 `task --acceptance <JSON>`。契约由调用者填写，
模型最终回答不构成验收证据。自然语言中的测试或提交要求必须同时写入契约。

```json
{
  "prompt": "修复指定问题并补充回归测试",
  "worktree": true,
  "check": true,
  "acceptance": {
    "objective": "修复指定问题",
    "allowedPaths": ["src/**", "tests/**"],
    "forbiddenPaths": [".github/**"],
    "expectedChange": true,
    "requireTests": true,
    "requiredCommands": ["npm test"],
    "requireCommit": false,
    "requireCleanWorktree": false,
    "capabilities": ["read", "edit", "test"],
    "frozenTestGlobs": ["tests/oracle.mjs"]
  }
}
```

指定 `cwd` 为当前项目。需要提交时，必须同时提供最小权限
`allow: ["Bash(git add*)", "Bash(git commit*)"]` 并设置 `requireCommit`。
否则能力预检在启动前返回 `CAPABILITY_MISSING`。
命令采用单命令字符串、直接执行，不经过 shell；不接受管道、重定向、变量展开
或命令串联。Windows npm 通过本机 Node 安装附带的 npm CLI 执行；其他 `.cmd`
启动器需改用对应解释器和脚本命令。命令最长运行 120 秒，失败不会自动跳过。

`requiredArtifacts` 可指定必须产生或更新的非空文件，使用精确的仓库相对路径。
`expectedChange=false` 必须配合明确的验证命令，不能仅靠模型说“无需修改”。
`check=false` 仅关闭额外的未跟踪文件、diff 检查，不能关闭产物或显式契约验证。
新建未跟踪源码必须由 `allowedPaths` 覆盖。路径匹配支持 `*` 和 `**`，相对仓库根目录。

`capabilities` 默认 `read|edit|test`。`buildImage` 允许本地 `docker compose`/`docker build`，仍拒绝 `docker push`。`push`/`deploy` 必须 `sensitiveApproved=true`，并在 `publish.images` 中预览仓库与不可变标签（`latest` 必须另附 `immutableTag` 或 `digest`）。脏工作区默认不能发布，除非 `publish.allowDirtyPublish=true`。`frozenTestGlobs` 匹配到的测试/oracle 文件哈希变化会列入 `oracleChanged`（含 diff）；没有 `oracleChangeReasons[<path>]` 则验收失败。

这些字段都是通用契约，不绑定具体语言或仓库。预检只检查调用方声明的内容：

- `preflight.tools`：额外可执行文件名
- `preflight.env`：必须非空的环境变量名
- `preflight.ports`：必须空闲的端口
- `preflight.composeFiles`：工作区相对 Compose 文件，解析其中的相对 bind mount
- `preflight.diskMb`：最低空闲磁盘；`buildImage`/`push` 默认 256
- `preflight.registry`：为 true 时要求已配置 Docker registry 凭证

`stage` 为可选门控（`inspect|implement|verify|package|publish`）。`inspect` 默认不改代码；后一阶段用 `requires` 指向前一阶段的 `artifacts/<jobId>/delivery.json`（`status` 必须是 `completed` 或 `success`）。`cleanupPolicy` 只清理**本次任务相对预检快照新创建**的容器/网络/卷，镜像默认保留。最终报告写到 `artifacts/<jobId>/`，`manifest.json` 含 SHA-256。

## 结果与工作区

- `processExited` 表示进程已退出；`taskCompleted`、`acceptancePassed` 由插件判定。
- 测试结果含 `failureType`（`product|test_harness|environment|infrastructure|unknown`）和 `testSummary`（失败数、独立缺陷聚类、harness/环境计数）。自动分类是启发式，`unknown` 合法。
- 发布结果含 `images[]`、`productionChanged`、`sourceCommit`、`sourceDirty`、`diffHash`、`remainingRisks`。
- 正常退出但没有交付物或不满足契约时返回 `incomplete`，CLI 退出码非零。
- 结果包含基线、初始和最终 HEAD、变更文件、未跟踪文件、工作区是否干净、
  提交列表与 merge commit、验证命令及真实退出码/时间/输出尾部。
- `resolvedModel` 只来自运行器元数据；没有证据时为 `null`。
- `baseIsAncestor` 由 Git 验证。`cherryPickSafety` 为 `not-checked`：没有目标分支
  就不能推断可安全 cherry-pick，也不会把多个提交标记为“全都已知且安全”。
- 写任务默认使用插件创建的 detached worktree；`worktree=false` 原样执行于现有工作区。
  初始脏改动不会被当作本次结果。Git 仓库必须已有基线提交。
- `worktreeName` 和多个 `bestOfN` 候选明确拒绝；需要多个候选时分别发起监督任务。
- 恢复保留原工作区、基线、验收条件、未提交修改；环境消失、仓库身份/HEAD/文件
  状态改变时返回 `RESUME_CONTEXT_LOST`。运行器更换 session 时明确返回 parent-session。
- `list_worktrees`、`retain_worktree(jobId)`、`cleanup_worktree(jobId)` 对应
  CLI `worktrees list|retain <jobId>|cleanup <jobId>`。失败的空 worktree 尝试自动清理；
  干净、无运行任务且提交被仓库分支保留时才允许删除。任何被 Git 忽略的文件也会阻止清理。
  成功任务默认保留。自动清理的空失败任务随后无法恢复，必须新建任务。

## 行动观测和实时通信

`grok_rescue` 默认使用常驻 ACP，`grok_run` 为通用入口。原生 `x.ai/hooks` 在创建/恢复
会话时注册，执行前检查权限与路径，执行后记录实际结果，停止时处理纠偏与轮次预算。
`grok_send` 支持柔性纠偏、中断替换、下一轮排队；收到回执与模型送达回执分开记录。
`grok_wait` 用事件唤醒和 cursor 增量读取，无固定轮询等待。验收命令运行于独立进程。

`runtime` 分别控制分析、编辑、验证的时间和轮次预算，以及空闲与自动补救次数。
停止钩子的轮次是原生回调次数，不等同于每次内部模型采样；不编造内部轮数。
兼容的 headless 路径仍使用旧流式看门狗，不能提供同样的途中控制能力。

## 敏感检测

默认排除 `.git`、`.venv`、`venv`、`node_modules`、`vendor`、`dist`、`build`、
`__pycache__`、`.cache`。ACP 在实际文件工具调用时对目标文件有界读取并分类；headless 仍在入口按文件名筛选。
不是任意源码的完整凭据或个人信息扫描。

仅含公开证书的 PEM 可通过；私钥优先识别，文件名中的 example/sample 不会绕过
已识别的私钥/令牌。`sensitiveApprovedPaths` 是用户批准的精确相对路径，
`sensitiveDenyTypes` 优先于任何批准。`sensitiveAllowTypes` 仅允许公共证书和测试样例。
`sensitiveExclude` 只能指定已知依赖/缓存目录，不能用 `**` 排除全部凭据。
敏感文件批准不再移除整个默认危险命令 denylist。
这些细粒度敏感参数目前在 MCP 入口执行；直接 CLI 不提供对应参数。

## 本次补齐与仍有边界的项目

| 项目 | 当前实现和边界 |
| --- | --- |
| 1、2、13、14、16、19 | 显式契约、结构化事件、独立验收进程、真实命令记录；通用 grok_run 支持不同产物类型，专用媒体流水线保持原接口 |
| 3、4 | 原生停止/工具钩子、途中纠偏、独立阶段预算、自动补救；内部采样轮次不等于停止钩子次数 |
| 5、6、7 | 工作区基线与恢复验证、空闲连接复用、保守清理；命名工作区和 bestOfN 多候选明确不支持 |
| 8、9 | 原生 CLI 帮助目录、动态模型/effort、实际工具权限检查；部分旧专用命令仍用固定适配器 |
| 10、11、12 | ACP 实际文件路径检测和内容分类、精确批准；不能声称已拦截任意 shell/远程工具返回的全部敏感内容 |
| 15 | 祖先关系、提交列表、merge commit 和 diff 检查；未实现目标分支 cherry-pick 试运行 |
| 17、18、20 | 实际模型元数据、结构化错误和验收故障分类；CLI 版本与模型版本分开 |
| 21、22 | 文件哈希/读取摘要、计划与失败检查点、原会话和工作区恢复；SDK 不支持替换工具结果，未计入虚假的 token 节省 |

2026-09-13 已对 Grok 1.0.30 实测文本会话、文件写入、工具前后钩子、途中纠偏、
中断和同会话续接。测试在临时 Git 仓库执行。不能将已验证的这些能力表述为 22 项全量完成。

## 自动更新

详见 [CLI 更新与实时协作](cli-updates-and-coordination.md)。默认启动时及每 15 分钟检查；
auto-stable 可设置每 5 分钟检查。仅 MCP 服务运行期间检查，无服务端版本推送承诺。
