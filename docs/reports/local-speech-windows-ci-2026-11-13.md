# 本机朗读与 Windows CI 排查验收 · 2026-11-13

## 范围与停点

本人明确要求先排查 Windows CI 两项失败，并把本机朗读接到 Agent 回复，使用 DeepSeek、Ollama、OpenAI、Google 四种模拟回复在 Web 和桌面验证启停、重开不自动播，不改变现有简历和求职数据。

沿原 `agent-os`、基线 `71089f7` 实施。本机实施验收阶段没有提交推送，随后本人已明确授权将本片提交推送并跟进 Windows 两项 CI，失败继续排查修复直到通过。发布不新建分支、不强推、不创建 Release，也不改现有简历和求职数据。本片不接入收费 TTS、录音/语音识别、OXR、PDF 翻译或 DeepTutor。两个 Agent 对话入口共用同一前端本机朗读能力，不为每个文本供应商新增语音协议或凭据。

本机原生双端验收已通过；发布与远端 Windows 复验正在执行，最终提交与作业结论见本文后续发布回执，不能将本机修正写成 Windows CI 已修绿。完整测试与最终资源同步结果见下方验收记录。

## 实现与安全边界

- `apps/web/src/lib/local-speech.ts`：将成功、完整的 assistant 正文转换为不超过 180 个 Unicode 码点的句段，区分中英文；排除推理标签、围栏代码、Markdown 图片、链接目标和纯 JSON。错误、fallback、截断、空回复及缺少成功元数据的历史记录不提供朗读按钮。
- `AgentSpeechControl.tsx`：接入 Agent 伴侣和岗位工作区助理对话，回复旁明确点击“本机朗读”，播放时切换为“停止朗读”。只选择 `localService === true` 的系统音色；所有段落所需语言在播放前检查，不使用远程默认音色兜底。音色尚未加载或缺失时保留文字并提示稍后重试/安装。
- 每个窗口共用一个队列；点击另一回复先取消原队列，旧回调不能继续排队。音色实际启动/结束/报错驱动状态；启动无回调 10 秒即停止，不自动重试。
- 关闭入口、切换到其他任务、组件卸载、页面退出或隐藏均停止。播放状态只存在内存，历史与草稿恢复不恢复播放授权。不会因音色后来就绪、刷新或重开而自行播报。
- 只调用系统 Web Speech 合成接口，不请求麦克风，不发起语音服务/模型调用，不改模型配置、账号身份、资料共享或原有恢复格式。控件复用现有主题与布局，键盘可操作、有 focus 状态和状态提示；粗指针高度 44px，减少动态效果偏好下关闭按压缩放与过渡。

接口语义参考 [Web Speech API 规范](https://webaudio.github.io/web-speech-api/#dom-speechsynthesisvoice-localservice)。音色选择遵守系统报告的本机标志；其他设备的音色安装和浏览器支持仍需该设备实际验证，不能由 macOS 验收推定。

## Windows CI：实查失败与修正

排查对象是基线对应的 [Actions run 43387764396](https://github.com/nanfengovo/better-me/actions/runs/43387764396)，不是更早的历史绿灯。

| 失败作业 | 观察结果 | 本片修正 |
| --- | --- | --- |
| Lint, types and tests (Windows / Edge)，job 131760180134 | `pnpm test`：4,888 项，4,835 通过、33 失败、20 跳过 | 修正 Git 根路径比较及测试清理/时序/平台预期；保留安全拒绝 |
| Desktop package (windows-x64)，job 131760180194 | `pnpm test:desktop`：21 项，15 通过、4 失败、2 条件跳过 | macOS 场景夹具固定使用 POSIX 路径；QA 配置夹具改用宿主绝对临时路径 |

普通测试的主要共因：

1. Git for Windows 返回的 `C:/…` 与 `fs.realpath` 的反斜线路径被直接字符串比较，造成多项 `repository_root_mismatch`。生产代码改为再次 `realpath` 后精确比较同一规范目录；仍拒绝相对路径、控制字符及其他目录，不使用前缀或大小写模糊匹配。新增 3 个 `path.win32` 生产模块回归，包含异目录拒绝。
2. 测试在一个 fixture 中重开 SQLite，但先注册的清理钩子先删除目录，后注册的连接尚未关闭，Windows 报 `EBUSY`。相应 badge、harvester、committee、scope-association 夹具先关闭所有自己创建的连接再清理自己的临时目录。
3. Windows 尚无经过审查的 MCP OS-sandbox provider。实际产品正确返回 `mcp_os_sandbox_unavailable`，原测试却期待沙箱成功。Windows 分支现在断言该真实拒绝且没有网络连接；没有跳过安全断言、取消沙箱或共享宿主权限。
4. 130ms 预算在慢磁盘上可能于首次模型派送前耗尽；测试改按实际派送计量核对，仍要求后续 3 次修复全部计费。另一个 20ms metadata 超时用例冻结落盘时间，等待实际 callback 进入后推进同一计时器，仍断言中止且推理次数为 0，没有延长生产预算。

桌面 4 项中，3 项是 macOS Bundle 路径的测试被 Windows 的 `node:path` 解释；先用 `path.win32` 注入复现了同样的 `source-unavailable`，再明确模拟平台的 POSIX 语义。另 1 项是 QA 配置使用 `/tmp/…` 而非 Windows 的规范绝对路径。Windows 私有 QA profile 未获 ACL 支持时继续安全拒绝，原有 2 项条件跳过不改成假通过。

本机定向回归覆盖以上关联 Host 用例共 92 项：91 通过、1 原有 opt-in 跳过；桌面本机 21/21。Windows runner 对这些改动的最终结果仍待推送后重新运行。

## 完整回归额外发现的身份清理异常

第一遍普通全仓阶段实际 4,895 项：4,874 通过、1 失败、20 条件跳过；因此后续 `test:resume-quality` 未执行，不合并成“全绿”。唯一失败 `legacy-workflow-http.test.ts` 单独重跑仍是 `unhandledRejection`，不是朗读引擎失败。

原因是身份代次切换已经中止旧请求，`ownedFetch` 正确抛出 `IdentityBoundaryError`，但其 best-effort `response.body.cancel()` 会再次拒绝，遗留未处理的取消异常。新增“旧流取消自身抛 AbortError”回归先红，再只处理这条清理 Promise 的拒绝；原身份拒绝、后续请求与跨账号保护不放宽。新增及既有身份、真实合成 HTTP、朗读和伴侣输出定向回归 35/35 通过。

## 双端原生验收

使用独立 `127.0.0.1:5326` UI lab，直接渲染实际 `AgentCompanion` / `AgentWorkspace`；新建合成 UUID 和四条带真实协议元数据的模拟回复，外加一条不应可朗读的错误回复。没有导入个人文件、历史资料或正式账号。

Web 使用新的 Playwright Chrome context；桌面使用新的临时 Electron profile、实际构建 preload 及同一 React 组件，保留 sandbox/contextIsolation，禁用非 fixture 网络与权限。不使用真实 5173/5179/岗位服务。原生验收的 engine 没有替换：只旁观 `speak/cancel`，记录操作系统合成事件。

| 模拟回复 | Web 伴侣 | Web 工作区 | Electron 伴侣 | Electron 工作区 |
| --- | --- | --- | --- | --- |
| DeepSeek | 原生启动、停止通过 | 原生启动、停止通过 | 原生启动、停止通过 | 原生启动、停止通过 |
| Ollama | 原生启动、停止通过 | 原生启动、停止通过 | 原生启动、停止通过 | 原生启动、停止通过 |
| OpenAI | 原生启动、停止通过 | 原生启动、停止通过 | 原生启动、停止通过 | 原生启动、停止通过 |
| Google | 原生启动、停止通过 | 原生启动、停止通过 | 原生启动、停止通过 | 原生启动、停止通过 |

16 组启停均观察实际原生 `start`、选中本机音色及停止后 `speaking=false/pending=false`。Web 与 Electron 还分别观察中文句段 `end` 后英文 `en-US` 句段的实际 `start`，没有用 mocked engine 成绩替代原生播放。这里验证的是本机原生引擎行为，不声称人工听评或四家真实模型生成/云端音质。

恢复与交互另验：

- Web 刷新、关面板再开、工作区卸载再恢复：队列为空、朗读调用不增长，合成未发送草稿原样保留，错误回复无朗读按钮。
- Electron 实际退出进程后，沿同一独立临时 profile 再启动：四条回复与后来通过真实输入框保存的草稿保留，重开 `speak` 调用 0、队列空。不是只隐藏窗口后声称进程恢复。
- 快速切换回复只有一个“停止朗读”，旧回复不续播；Space 键能启动和停止；卸载会话停止，恢复会话不自动播。
- 深/浅色已截图目视；Web 1320×908 和 390×844 无横向溢出，390px 粗指针稳定按钮高度为 44px，关闭按钮与草稿输入仍可见。聊天历史采用原有滚动，不要求所有历史回复同时出现在视口内。
- 所有本轮双端模拟验收的 `modelCalls=0`；fixture fetch 只返回合成结果，没有真实模型/付费 TTS、麦克风或个人资料请求。原正式窗口和服务未刷新、重启或停止。

本机截图与临时 profile 保留在 `betterme-local-speech-LBgWMQ/`，包含 `web-dark-playing.png`、`web-dark-workspace-playing.png`、`web-touch-narrow.png`、`electron-playing.png`、`electron-reopened.png`。它们不入 Git，截图中的连接异常是有意断开模型的合成验收环境，不是生产连接状态判断。

## 最终构建与回归记录

- `local-speech.test.ts`：10/10；包含四供应商、正文净化、非本机音色拒绝、迟到回调、所有权、音色后来就绪不自播、引擎错误和启动 watchdog。
- 身份/合成 HTTP/伴侣输出/朗读相关：35/35。
- 最终 `pnpm test` 完整命令退出 0：普通阶段 4,896 项，4,876 通过、0 失败/取消、20 原有条件跳过；随后独立简历评测 58/58，通过且 0 跳过。最终普通阶段约 262 秒，评测约 98 秒，原始完整日志只在本机 `betterme-speech-full-tests.sxIIAB` 保留。
- 最终 `pnpm typecheck` 16/16、`pnpm lint` 零 warning、`pnpm desktop:build` 9/9、`pnpm test:desktop` 21/21 均通过。构建仍有既有 Atlas Node 模块外置与大 chunk 提示，没有将它们当成新增语音错误或零构建提示。
- 最终执行 `scripts/sync-local-desktop-dist.mjs`：相邻 `BetterMe.app/Contents/Resources/app/dist` 共 536 资源，候选构建与安装清单精确一致；只移动/替换明确的构建目录，未改变进程或用户数据。当前安装清单 SHA-256 为 `1c159a2869bf95623224fef217775f75b44c3fc7f75641e901796a8451f73bb3`，Web 清单为 `16dffeb18c32390b1de4ee8ff32d314cd542cc68e900fb31b984d7bcacb25d54`。
- 完整直接上一版保留于 `../.unified-agent-app-DbFITq/previous-dist`，清单 `512b47b4206464c2f795081e6cea52a8269dfcc18fb21ec3cf9ecf98d80f3800`；语音实施前完整版本仍保留于 `../.unified-agent-app-dJHbal/previous-dist`，清单 `f005adcf729def4de6bf1347b3945fe2d4b19add4c16b58ea7b86b1fe6f0ab38`。没有删除任何备份或个人记录，没有打开默认 App/profile。
- `pnpm memory:check` 与 `git diff --check` 通过；个人事实三份 SSOT 无变更。实际原生语音验收是隔离 Electron 加载共享 React 与构建 preload；安装资源的验收是构建/清单同步，不冒称默认安装账号窗口或 Windows 成品已经做过音质验收。

## 复验与下一门

```sh
pnpm exec tsx --tsconfig apps/web/tsconfig.json --test apps/web/tests/local-speech.test.ts apps/web/tests/agent-companion-output.test.tsx apps/web/tests/identity-boundary.test.ts apps/web/tests/legacy-workflow-http.test.ts
pnpm exec tsx --tsconfig apps/web/tsconfig.json --test apps/agent-host/tests/git-root-portability.test.ts
pnpm test:desktop
pnpm typecheck
pnpm lint
pnpm test
pnpm desktop:build
pnpm memory:check
```

原生 UI lab 启动入口：

```sh
pnpm --filter @better-me/web exec node dev-server.mjs --config tests/ui-lab/local-speech.config.ts
```

访问 `/tests/ui-lab/local-speech.html`，`?theme=dark` 可检查深色，`?pane=advisor` 可直达工作区。Electron 的 `tests/local-speech-entry.cjs` 必须由测试进程提供全新私有临时目录和显式 preload；不使用默认 profile。系统音色异步加载须等待 `getVoices()` 有所需本机音色后明确点击，加载完成本身不授予自动播放权限。

本人已授权的下一门是沿现有分支提交推送后，跟到新 Windows 普通/桌面 Actions job 完整结果；失败按日志继续修复重跑，不取消安全校验或绕过失败测试。实际 Windows/Edge 系统音色的人工设备验收与 CI 打包/合成测试分开，macOS 的本机通过与 `path.win32` 回归不冒充该设备音质验收。没有自动恢复此前暂停目标或接入其他四方向的真实外部引擎。

## 后续发布回执

本人授权发布后已实际 fetch：本地 HEAD、tracking ref 和远端 `agent-os` 同为 `71089f7`，没有分叉；待发布文件仅本片源码、合成测试与技术交接，临时账号、截图、构建成品、数据库及凭据不入 Git。提交前重新验证关联用例，最终提交 SHA、Windows 作业链接和结论以本片发布后的实查回执为准，不引用旧运行当作新代码结果。
