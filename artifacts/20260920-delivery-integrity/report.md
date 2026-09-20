# 交付契约修复验证报告

日期：2026-09-20。修改保存在当前工作区，未提交、推送、部署或重装插件。

## 已修复

- 验收子进程通过 IPC 发送命令开始/结束和计数，供 ACP 心跳、事件流和进度文件使用。
- 前置阶段失败在模型执行前拦截；阶段报告的符号链接不能越过工作区。
- 测试设施、环境、未知故障不计入产品独立缺陷聚类；明确计数单位为命令。
- 产物持久化失败不再返回成功；重试撤销旧成功报告，检查路径边界及文件大小。
- 持久化报告补全命令、验收、清理、源码提交、脏状态、真实 Git diff 摘要和文件快照摘要。
- 已暂存/已提交的冻结断言变化保留相对初始 HEAD 的 diff。
- 清理 Docker 资源必须同时满足新增资源和任务归属标签，保留无法确认归属的资源。
- 报告生成后更新恢复快照；重试忽略未变的插件产物，但仍检测产物篡改。

## 验证

`node tests/run-tests.mjs`：191 项通过，0 失败，0 跳过。

`git diff --check`：通过。Git 的 LF/CRLF 提示不属于校验失败。

新增 `tests/delivery-integrity.test.mjs` 共 11 项回归测试，包含真实 Node 验收子进程 IPC。
Docker 清理使用可控命令替身验证归属匹配，不连接生产 Docker。

唯一旧测试期望调整位于 `tests/capabilities.test.mjs`：未知故障的 independentDefects 从 1 改为 0，
并新增 failureClusters=1，纠正将未知故障当成产品 Bug 的统计语义；未放宽产品验收断言。

## 验证限制与后续边界

- plugin-creator 的 validate_plugin.py 未完成：捆绑 Python 缺少 PyYAML；尝试安装到工作区专用目录时没有可用发行包。
- 本轮未调用真实 Grok 会话、构建或推送镜像。现有自动测试含模拟运行器；不能据此宣称真实 Grok/Docker 发布链路已端到端通过。
- 统计仍按验证命令计数，未新增 Maven/JUnit 等用例级结果解析；根因分类/聚类仍是启发式。
- Git diff/sourceTreeHash 为验收时证据，未实现镜像构建时 OCI labels、SBOM、远端 digest 的独立核验。
- stage 名称仍兼容现有 inspect/implement/verify/package/publish；未新增自动执行完整 DAG 的调度器。
- 未带 io.grok-safe.job-id 标签的 Docker 资源会保留并报告，不保证所有资源自动清理。

本目录保存全量测试输出及 SHA-256 清单。功能边界详见 docs/verified-delivery.md。
