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

复用了施工阶段已完成的真实本机模型 Web/原生 Electron 隔离验收，未再次调用模型；见 [工坊实现报告](personal-training-workshop-2026-11-17.md)。发布阶段重新构建并以安全脚本核对/同步相邻源码关联的 `BetterMe.app`，598 个资源的清单 SHA-256 仍为 `acf813dc3094fdd67ed11ba600779c30b712ccd7723904f55ad8120236d09467`；本轮首个备份为相邻 `.unified-agent-app-Bu0pm8/previous-dist`，夹具修正后再次 9/9 构建与同步的备份为 `.unified-agent-app-0or8Tx/previous-dist`，更早施工前备份保持。未重启正式窗口或服务，未更改用户资料。

本轮完整命令原始日志留在本机 `/tmp/betterme-workshop-release.XNnwKl/`，未纳入 Git。

## 远端门禁

源码提交的 [Actions 44087472335](https://github.com/nanfengovo/better-me/actions/runs/44087472335) 实际结果：四平台原生打包/成品启动、Docker、Linux 生产/Pages 子路径共六项成功；Windows 完整普通套件 5,126 项，5,101 通过、23 条件跳过、2 失败，后续简历质量与协议门因此没有执行。不能称本轮 CI 全绿。仓库流程要求 Windows 质量门、Linux 构建、Docker 持久化恢复和四平台原生打包/启动烟测通过后，版本标签才会生成正式 Release。

基线 `49ad513` 的 [旧 Actions 44055949744](https://github.com/nanfengovo/better-me/actions/runs/44055949744) 实际有两项 Windows 夹具失败：本机向量搜索用例以及 Vite 敏感文件测试的首页状态 403。两文件在本机定向复验 12/12；新提交的向量搜索用例已过，Vite 首页 403 再次出现，另有采集器模型取消测试失败。

### 发布门失败的最小复现与修正

- 取消测试记录的唯一失败断言为 `Date.now() - start < 2000`，其中 `start` 在真实 Git 准备之前。将合成准备阶段由 250ms 延长为 2,100ms，定向用例稳定重现同一断言失败。保留大于两秒准备，改为检查取消信号触发后、模型 Promise 仍未返回时，真实 capture 能否在下一事件循环前结束；本机由红转绿。临时取消生产 `abortable` 包装时，新断言真实失败；包装已还原且生产文件零 diff。错误码、信号传播、无写入、丢弃迟到结果、禁止自动重试断言全部保留，不延长生产预算。
- Vite 6.4.5 实际依赖源码在 Windows 对含 `~` 的文件路径直接拒绝，即使在 `fs.allow` 内。仅在隔离 harness 选择这个 Windows 分支，真实 Vite HTTP 结果为 alias 首页 403、realpath 首页 200，四种 `.env` 查询均 403 且不包含 marker。这个受控分支实验不是原生 Windows 验收。夹具把 `mkdtemp` 结果先 `realpath`，不放宽 `strict/allow/deny`；正式 Windows 最终结果由修正提交的 CI 核实，首页失败时附合成根和响应体便于定位。
- 两文件未改前的本机定向 17/17，修正后同一命令仍 17/17；类型16/16、lint零warning、Memory Bank/diff检查通过，并把文件安全测试纳入现有 Windows 前置门。随后完整 `pnpm test` 再次退出0：独立PDF1/1、普通5,099通过/20条件跳过/0失败、简历质量64/64。完整命令和正式发布依赖不删减。

## 修正提交与正式发布流水线

修正提交 `97997aced38c1297250752526fb872ca170bf88a` 已普通推送。[Actions 44094307792](https://github.com/nanfengovo/better-me/actions/runs/44094307792) 的最终结论为成功：Windows 原生前置门、完整普通5,103通过/23条件跳过/0失败、独立PDF1/1、简历质量64/64及后续协议门均成功；Linux生产构建、Docker和四平台成品启动均成功。

这轮 macOS arm64 首次因 GitHub hosted runner 容量不足，15分钟没有分配执行机、没有运行任何步骤而取消；GitHub annotations 已明确说明。只重跑该作业及依赖（attempt 2），没有改源码、跳过测试或借用其他平台结果；实际原生打包/启动随后成功。

已创建并普通推送不可变注释标签 `v1.2.0`，剥离后精确指向 `97997ac`，没有覆盖既有标签。[正式标签 Actions 44098811836](https://github.com/nanfengovo/better-me/actions/runs/44098811836) 全部发布门成功：Windows 完整质量、Linux 生产构建、Docker、四平台原生安装包烟测和最终发布作业均为 success；Pages 仅 main 才部署，本轮按设计跳过，没有更改 main。

## 已发布附件与发布后核对

[BetterMe v1.2.0](https://github.com/nanfengovo/better-me/releases/tag/v1.2.0) 于北京时间 **2026-11-17 22:27:31** 发布。公开 API 确认为 `draft: false`、`prerelease: false`，以下六个安装包/归档及四份清单全部为 uploaded 且非空。

| 附件 | 字节数 | GitHub SHA-256 |
| --- | ---: | --- |
| `BetterMe-1.2.0-linux-x64.AppImage` | 317,950,005 | `00dd2f95bdbb6b228538efe57c1416cbfedb73461c4f648cda9bf711cde48298` |
| `BetterMe-1.2.0-macos-arm64.dmg` | 321,775,384 | `8a4a3030c24f06766ad7c1b2e7522c1f4180f201b11862d8052a7b642883cf03` |
| `BetterMe-1.2.0-macos-arm64.zip` | 312,044,110 | `c8852256918a3ed21700c027aee19e7fadd4eb6af9336c986fc565e0c15387c4` |
| `BetterMe-1.2.0-macos-x64.dmg` | 329,758,833 | `596387d4777742612435cd77c63bf2273d3e0d9623f8f49de09604ca46ea6b2a` |
| `BetterMe-1.2.0-macos-x64.zip` | 319,982,829 | `04a2cf96ca13d73419da47466e7d5e1eccd29b2bdd7136c098f0f3620a40ccee` |
| `BetterMe-1.2.0-windows-x64-setup.exe` | 289,894,023 | `abb2ba2ce9c39503f2358ab159f3271a7ac0b12025a9c15f6157f311e01a4ac2` |

四份公开清单为 `SHA256SUMS-darwin-arm64.txt`、`SHA256SUMS-darwin-x64.txt`、`SHA256SUMS-linux-x64.txt`、`SHA256SUMS-win32-x64.txt`。已实际下载到本机隔离日志目录：四份清单的字节摘要与公开 API digest 一致；清单内六项二进制摘要与 GitHub 对应附件 digest 全部一致，无重复或遗漏。

发布作业日志在 14:26:58Z 和 14:27:00Z 两次记录六项安装包/归档及平台校验成功，然后于 14:27:32Z 返回正式 Release URL。CI 在发布前对下载的实际二进制执行完整 SHA-256；发布后本机只再下载四份小清单并核对 GitHub 二进制 digest，没有声称重新下载约 1.9GB 全部安装包或逐平台人工使用。发布说明的报告链接已通过受限编辑改成指向本标签的绝对链接，不依赖 Release 页相对路径解析。

收尾阶段工作区出现另一批并行未提交源码修改；没有带进不可变 `v1.2.0`，也不进入本次按路径限定的回执提交。后续纯文档回执不改变已发行的构建源码 SHA。原有研究文件、私人简历/账号/密钥、正式服务和浏览器状态保持，不强推、不移动标签、不自动安装或重启。
