# CLI 更新与实时协作

插件从安装在本机的 Grok CLI 获取命令，而不是把网上示例当成当前版本接口。

## 更新流程

1. MCP 服务启动时检查；之后按 `intervalMinutes` 定时检查，最小 5 分钟。
2. 执行原生 `grok update --check --json`，记录当前版、稳定版、更新时间与错误。
3. `check` 只检查；`auto-stable` 在有更新且空闲时调用 `grok update --stable`。
4. 活跃任务延后升级。先关闭空闲 ACP 进程，再检查其他 Windows Grok 进程；安装锁防止重复安装。
5. 升级后重新读取版本和命令帮助，比较新增/移除命令，检查必要接口，返回兼容性结果。
6. 用户手动升级也会改变二进制指纹，下一次调用自动重建目录。

默认策略是 `check`，间隔 15 分钟。启用自动升级：

```json
{"action":"configure","mode":"auto-stable","intervalMinutes":5}
```

将上面的参数交给 `grok_cli_update`。查询接口：

- `grok_capabilities`：CLI 版本、命令目录、ACP 能力、实时模型与 effort 选项。
- `grok_cli_help`，例如 `{"command":"agent stdio"}`：本机版本的完整帮助。
- `grok_cli_update`，`{"action":"check"}`：只读检查更新。

服务未运行时不会检查。当前官方接口提供检查更新，未发现版本发布推送接口，
所以“第一时间”表示下一次检查或下一次调用；无法承诺发布瞬间或零延迟。
更新失败会保留错误，不报告成功；没有实现自动回滚到旧二进制。

## 协作方式

`grok_rescue` 默认 ACP，`grok_run` 支持通用任务和产物契约。
保留后台任务 ID，通过 `grok_wait` 的 cursor 消费增量事件。

| 控制 | 行为 |
| --- | --- |
| steer | 在下一个支持的原生工具后/停止边界注入补充要求 |
| interrupt | 发送原生取消，结束当前生成后在原会话提交替代要求 |
| queue | 当前 prompt 完成后提交下一条要求 |
| cancel | 取消当前任务并保留验收和工作区证据 |
| resumeSession | 验证原工作区/基线；优先复用空闲连接，否则加载原会话 |

接收与送达分别记回执。消息 ID 去重，等待由事件唤醒；验收命令不阻塞 MCP 主进程。
不把“模型正在思考、执行工具或联网”的耗时算成已消除的通信延迟。

### 减少 Codex 回传消耗

ACP 的 `grok_wait`、`grok_events`、带 jobId 的 `grok_status` / `grok_result` 默认
`detail=summary`。等待默认 60 秒；普通文本、思考、工具进度及成功命令不单独唤醒。
权限拒绝、失败、阶段变化、验收重试、看门狗及消息送达事件继续立即返回，未知事件不隐藏。
所有原始事件仍写入磁盘，权限钩子、验收、纠偏和取消逻辑不变。

每次继续传回上次的 `cursor`，避免事件重放。摘要省略 prompt、checkpoint 和成功测试日志，
结果文本最多 2,000 字符并明确标注截断；保留变更路径、验收条件、测试命令/退出码和失败日志。
`detail=full` 可获取完整结果和保留的原始事件；更早记录可从返回的 `eventsFile` 读取，
完整任务证据位于 `evidenceFile`。`gap=true` 时必须补读遗漏事件。
关键事件有独立保留区，不会被普通文本流挤掉；超过保留容量时明确报告 gap。

Codex 仍须检查完整 diff、未跟踪文件和验证证据。精简结果不是免审批准，插件的验收通过也不代表
Codex 已批准变更。旧 headless 路径和不带 jobId 的列表保持原行为。
这些修改减少的是回传文本和无效唤醒，不能直接换算成实际 Codex token 或套餐额度节省比例。

## 验证记录（2026-09-13）

本机 Grok 1.0.30 与官方稳定版一致，原生帮助目录包含 64 个入口。
真实临时仓库验证已覆盖 ACP 文本、文件写入、工具钩子、途中纠偏和中断续接。
一次中断请求到替代 prompt 的本地交接实测 2 毫秒；这不是模型回复延迟或性能保证。

接口依据：官方源码的 [ACP hooks](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/hooks.rs)
及本机 `grok --help` / `grok update --help`。来源和实际运行版本可能有差异，因此以本机能力握手和实测为准。
