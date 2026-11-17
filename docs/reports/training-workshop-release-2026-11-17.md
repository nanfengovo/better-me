# 按需训练工坊：README 与 v1.2.0 发布回执

用户明确要求“推送，发布，更新 readme”。在既有 `agent-os` 上提交，不新建分支、不覆盖 `main` 或既有版本标签。原有未跟踪的语音/OCR/PDF 研究文件保留，不进入本次发布。

## 源码和文档

- 功能提交：`5afb22be04340a11141d9b87d2e3f4bd8e0d9d01`，`feat(learning): build sandboxed personal training tools`。30 个文件，包含工坊、双端 UI、契约、回归、隔离验收脚本、README 和发布说明。
- README 新增工坊入口、三类生成方式、步骤、本机模型/协议前提、调用上限、保存/换题及不认证能力的边界；仓库和桌面版本均为 `1.2.0`。
- 提交前检查新增行的常见真实密钥模式，没有命中；安装包、模型、账号库、浏览器资料、私有简历和测试截图不进入 Git。这不是对整个历史的秘密审计。
- 默认 SSH 和 HTTPS Git 传输曾受本机网络影响；最终使用现有代理的 HTTP CONNECT 正常 SSH 推送。远端接收原提交，哈希一致，没有改登录凭据或全局 Git 配置，没有强推。

## 本机复核

在受支持的 Node `26.7.0`、pnpm `11.9.0` 下完成：

| 命令/阶段 | 结果 |
| --- | --- |
| `pnpm test` 的独立有界 PDF 解析 | 1/1，通过 |
| `pnpm test` 的完整普通套件 | 5,119 项：5,099 通过、20 条件跳过、0 失败/取消 |
| 随后的完整简历质量回归 | 64/64，0 跳过/失败/取消 |
| `pnpm typecheck` | 16/16 Turbo 任务成功 |
| `pnpm lint` | 无错误、无 warning |
| `pnpm test:desktop` | 23/23 |
| `pnpm test:runtime` | 10/10 |
| `pnpm desktop:build` | 9/9，包含 Web/main/preload/runtime |
| README 本地文件链接、版本一致性、Memory Bank 和 diff 检查 | 通过 |

复用了施工阶段已完成的真实本机模型 Web/原生 Electron 隔离验收，未再次调用模型；见 [工坊实现报告](personal-training-workshop-2026-11-17.md)。发布阶段重新构建并以安全脚本核对/同步相邻源码关联的 `BetterMe.app`，598 个资源的清单 SHA-256 仍为 `acf813dc3094fdd67ed11ba600779c30b712ccd7723904f55ad8120236d09467`；本轮同步前的完整资源保存在相邻 `.unified-agent-app-Bu0pm8/previous-dist`，更早施工前备份保持。未重启正式窗口或服务，未更改用户资料。

本轮完整命令原始日志留在本机 `/tmp/betterme-workshop-release.XNnwKl/`，未纳入 Git。

## 远端门禁

源码提交的 [Actions 44087472335](https://github.com/nanfengovo/better-me/actions/runs/44087472335) 实际结果：四平台原生打包/成品启动、Docker、Linux 生产/Pages 子路径共六项成功；Windows 完整普通套件 5,126 项，5,101 通过、23 条件跳过、2 失败，后续简历质量与协议门因此没有执行。不能称本轮 CI 全绿。仓库流程要求 Windows 质量门、Linux 构建、Docker 持久化恢复和四平台原生打包/启动烟测通过后，版本标签才会生成正式 Release。

基线 `49ad513` 的 [旧 Actions 44055949744](https://github.com/nanfengovo/better-me/actions/runs/44055949744) 实际有两项 Windows 夹具失败：本机向量搜索用例以及 Vite 敏感文件测试的首页状态 403。两文件在本机定向复验 12/12；新提交的向量搜索用例已过，Vite 首页 403 再次出现，另有采集器模型取消测试失败。

### 发布门失败的最小复现与修正

- 取消测试记录的唯一失败断言为 `Date.now() - start < 2000`，其中 `start` 在真实 Git 准备之前。将合成准备阶段由 250ms 延长为 2,100ms，定向用例稳定重现同一断言失败。保留大于两秒准备，改为检查取消信号触发后、模型 Promise 仍未返回时，真实 capture 能否在下一事件循环前结束；本机由红转绿。临时取消生产 `abortable` 包装时，新断言真实失败；包装已还原且生产文件零 diff。错误码、信号传播、无写入、丢弃迟到结果、禁止自动重试断言全部保留，不延长生产预算。
- Vite 6.4.5 实际依赖源码在 Windows 对含 `~` 的文件路径直接拒绝，即使在 `fs.allow` 内。仅在隔离 harness 选择这个 Windows 分支，真实 Vite HTTP 结果为 alias 首页 403、realpath 首页 200，四种 `.env` 查询均 403 且不包含 marker。这个受控分支实验不是原生 Windows 验收。夹具把 `mkdtemp` 结果先 `realpath`，不放宽 `strict/allow/deny`；正式 Windows 最终结果由修正提交的 CI 核实，首页失败时附合成根和响应体便于定位。
- 两文件未改前的本机定向 17/17；修正后再次跑同一命令与类型/lint，并把文件安全测试纳入现有 Windows 前置门。完整 `pnpm test` 和正式发布依赖不删减。

正式标签、四平台附件与发布结论在对应门禁结束后补齐；此时不能把“源码已推送”描述为“安装包已发布”。
