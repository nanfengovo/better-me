# 本机朗读与 Windows CI 排查验收 · 2026-11-13

## 范围与停点

本人明确要求先排查 Windows CI 两项失败，并把本机朗读接到 Agent 回复，使用 DeepSeek、Ollama、OpenAI、Google 四种模拟回复在 Web 和桌面验证启停、重开不自动播，不改变现有简历和求职数据。

沿原 `agent-os`、基线 `71089f7` 实施。本机实施验收阶段没有提交推送，随后本人已明确授权将本片提交推送并跟进 Windows 两项 CI，失败继续排查修复直到通过。发布不新建分支、不强推、不创建 Release，也不改现有简历和求职数据。本片不接入收费 TTS、录音/语音识别、OXR、PDF 翻译或 DeepTutor。两个 Agent 对话入口共用同一前端本机朗读能力，不为每个文本供应商新增语音协议或凭据。

本机原生双端验收已通过；发布后的历次 Windows 失败、修正与复验逐轮保留在本文。最新推送的机器结论以 [agent-os Actions](https://github.com/nanfengovo/better-me/actions/workflows/ci-pages.yml?query=branch%3Aagent-os) 的同一 `head_sha` 为准，只有普通质量与桌面成品两个 Windows 作业均最终成功才结束本阶段；本文本机通过不替代远端结果。完整测试与最终资源同步结果见下方验收记录。

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

实施阶段本机定向回归覆盖以上关联 Host 用例共 92 项：91 通过、1 原有 opt-in 跳过；桌面本机 21/21。此处为推送前快照，后续 Windows runner 的实际结果逐轮列在发布回执，不从本机推定。

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
- 最新重新构建/同步的即时备份为 `../.unified-agent-app-Gkh2eh/previous-dist`，与当前安装清单相同；前轮的 `../.unified-agent-app-kOSywz/previous-dist`、`../.unified-agent-app-bJAcIA/previous-dist`、`../.unified-agent-app-7TvfQG/previous-dist` 与 `../.unified-agent-app-eTDuTb/previous-dist` 仍保留。前一不同版本保留于 `../.unified-agent-app-DbFITq/previous-dist`，清单 `512b47b4206464c2f795081e6cea52a8269dfcc18fb21ec3cf9ecf98d80f3800`；语音实施前完整版本仍保留于 `../.unified-agent-app-dJHbal/previous-dist`，清单 `f005adcf729def4de6bf1347b3945fe2d4b19add4c16b58ea7b86b1fe6f0ab38`。没有删除任何备份或个人记录，没有打开默认 App/profile。
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

- 已正常提交推送 [`c3e4fb2`](https://github.com/nanfengovo/better-me/commit/c3e4fb2365368e6b7ce1ecc95a597a54625a1100)，共 28 个相关文件。实际 `ls-remote` 与本地 SHA 一致，提交后工作树干净，没有强推、新分支或 Release。
- 提交前复验身份/合成 HTTP/语音/伴侣与 Windows Git 根共 38/38，桌面 21/21、Memory 与 staged diff 检查通过；暂存新增行检查未见真实密钥格式、个人绝对路径或数据/构建产物。
- 新运行为 [43427883983](https://github.com/nanfengovo/better-me/actions/runs/43427883983)，严格对应 `c3e4fb2`。Windows 桌面 [job 131893717291](https://github.com/nanfengovo/better-me/actions/runs/43427883983/job/131893717291) 已最终成功：测试、构建、打包、成品启动/自有服务清理及产物上传全部通过，耗时 6分8秒。
- Windows 普通 [job 131893716809](https://github.com/nanfengovo/better-me/actions/runs/43427883983/job/131893716809) 实际普通阶段为 4,903 项：4,880 通过、3 失败、20 条件跳过，没有取消。不同平台的有效测试分母不同，不与本机4,896直接相加。三个新失败在下节记录；桌面 21 项为19通过/2原有平台条件跳过/0失败。监控的 GitHub API EOF 已自动重连，传输中断不等于 CI 失败。

### Windows 第二轮修正

第一轮原33项失败的共因已修正，剩余三个失败均在既有 HTTP 合成夹具，未改用户数据或生产权限：

1. `apps/agent-host/tests/studio-committee-http.test.ts` 的隐私拒绝测试在 Windows 耗时约62秒，超过夹具60秒预算而正确进入 `budget_exhausted`。用实际HTTP+受控逻辑时钟每次模型调用5秒，6.6秒内先复现同一失败；夹具允许180秒后通过，新增精确断言14次共70秒仍计入同一任务。其他完整协议夹具沿同一测试预算，生产默认预算与专门耗尽测试不变。
2. `legacy-workflow-http.test.ts` 用10ms等待猜测“旧响应已到”，慢Windows上可能先中止尚未完成的HTTP handler，清理发生 `ENOTEMPTY`，且没有真正测到迟到响应。改为HTTP响应头实际就绪的 Promise barrier 后切换身份，仍要求拒绝、只读历史不变、0模型/外部调用；没有用重试删除或吞掉清理异常替代边界。
3. Web `studio-committee-http.test.ts` 用200次轮询作为归档等待窗口，不能代表Windows实际持久化。大回复刻意增加3秒迟到交付后，在本机先复现同一“归档未保留”失败；改为最多30秒等待完整私有归档条件，每次核对原文精确相等，同时断言未采用为结果、未新增模型计量。实际条件达成即返回，不盲等满30秒或跳过归档校验。

修正后的两个HTTP文件、旧历史HTTP与身份边界共26/26通过。Windows第一次作业从启动到失败已16分14秒，后续58项独立评测/协议/runtime门尚未执行；只将CI作业总上限20调到30分钟以容纳完整门，不更改产品任务时限、跳过检查或取消沙箱。第二轮提交与新运行结论继续从对应SHA实查。

- 第二轮已正常推送 [`c67f5d1`](https://github.com/nanfengovo/better-me/commit/c67f5d123036a711888e7f362416410ac857b939)，运行 [43431952687](https://github.com/nanfengovo/better-me/actions/runs/43431952687)。Windows桌面 [job 131907374817](https://github.com/nanfengovo/better-me/actions/runs/43431952687/job/131907374817) 再次通过：19通过/2原有平台条件跳过、构建/打包/成品启动和自有服务清理成功；Linux生产/Docker及另三种桌面架构通过。
- Windows普通 [job 131907374136](https://github.com/nanfengovo/better-me/actions/runs/43431952687/job/131907374136) 仍失败：4,893项，4,871通过/2失败/20条件跳过。一个是40ms的生成超时夹具在预检阶段先耗尽，另一个是 `network-proxy.test.tsx` 的原生进程退出 `3221226505`，不是13项断言全通过。进程中断导致部分子用例未注册，分母减少不算删掉测试。前轮3个HTTP用例本轮已通过。
- 第二轮修正的本机完整 `pnpm test` 再次退出0：普通4,876通过/0失败/20条件跳过（约239秒），独立评测58/58（约82秒），完整日志 `betterme-speech-ci-fix-full-tests.6g2XgS` 仅留本机。脚本协议 `evals:career` 与运行时10/10也通过；仍不拿本机结果代替远端Windows。

### Windows 第三轮修正

1. 生成超时夹具：保持40ms预算，给实际metadata预检增加60ms合成延迟后，在本机两次先红，均在同一生产预检结束路径抛 `coding_budget_exhausted`。这说明原测试没有保证进入它要测试的生成阶段。改用冻结的持久化时钟和真实生成回调barrier；进入后先推进39ms仍未中止，再推进1ms触发实际abort，核对40ms扣费、1次尝试、迟到回复不采用、重开不重试。相邻独立metadata耗尽测试保留0次生成断言；未延长生产预算或把预检时间免计费。
2. 原生TCP退出：本机代理13/13通过，但不能在macOS复现Windows native fast-fail。对照 [Node官方已确认问题 #63620](https://github.com/nodejs/node/issues/63620) 与 [24.16.0发行记录](https://nodejs.org/en/blog/release/v24.16.0)，当前CI的24.15.0含已知Windows TCP连接崩溃、24.16.0带libuv修复。该匹配是本次故障的首要推断，没有本次native dump，不声称已定位到同一C栈。仅将Windows两个作业的Host Node固定到同一24 LTS的24.16.0，Linux/macOS及应用Electron版本不变；完整检查前额外连续运行5次真实代理文件，任一次非零即失败。保留所有完整检查、并发数、安全拒绝与原分母，不以重试整套直到碰巧通过代替验证。

本机生成/预检/计量/恢复15项与代理13项的定向回归执行通过；Windows版本修正与原生短循环须在新Actions实际验证。第三轮没有改Web/Host生产实现或安装资源，沿用第二轮已核对的536文件清单与可恢复备份。

### 本机完整复验补充：UI 回执等待

第三轮正常推送 [`897f423`](https://github.com/nanfengovo/better-me/commit/897f423dea48113adfa5c5a293f3f7021dab824e)，运行 [43435709198](https://github.com/nanfengovo/better-me/actions/runs/43435709198)。Windows实际5轮代理文件检查全部成功（每轮13项），桌面 [job 131920125832](https://github.com/nanfengovo/better-me/actions/runs/43435709198/job/131920125832) 完整打包/成品启动最终成功；质量 [job 131920125608](https://github.com/nanfengovo/better-me/actions/runs/43435709198/job/131920125608) 最终失败：普通4,903项，4,880通过/3失败/20条件跳过，0取消，后段独立58项未运行。前轮40ms生成与HTTP用例本轮均通过，其余平台验证也成功。40ms用例另在本机连续10轮通过，重复执行不计作10个不同测试。

本机并行完整复验另有1项失败：普通4,875通过/1失败/20条件跳过，独立58项评测因前段失败未运行。`career-studio-workspace.test.tsx` 的micro-card等待审阅采用回执，原helper仅循环80次setImmediate，实际不到一次异步业务回执所需时间。给真实采用callback增加150ms合成延迟后，复现同一末端“等待readback-version”断言失败；不是简历采用权限失效，也没有采用真实资料。

仅将该测试helper改为最多5秒等待真实UI条件、每5ms在React act内让出；保留150ms迟到回执作为持续回归，并完整保留本人原话/独立审批/0提前采用/模型摘要不作Fact/原合成FactBase不变等断言。整个UI文件8/8通过。随后按仓库双端规则再次构建9/9、桌面21/21、536安装资源同hash可回退同步，未重启原服务/真实窗口。

修正后的本机完整 `pnpm test` 实际退出0：普通4,896项，4,876通过/0失败或取消/20原有条件跳过（约236秒）；随后独立58/58（约84秒），日志 `betterme-speech-ci-ui-full-tests.KLCGey` 只留本机。保留上述4,875/1失败的原始记录，不用定向8/8替代完整重跑。

### Windows 第四轮：真实就绪、稳定批注 ID 与原生监听路径

第三轮的3个失败按原始日志分别修正，未修改生产业务逻辑、权限或数据：

1. `career-replay-feedback-ui.test.tsx` 在“载入当前版本”后只等3个事件循环，就向仍被禁用的文件控件派送事件。生产的 busy guard 正确拒绝该竞争事件。给真实合成 identity 请求增加60ms延迟后，在本机复现相同2秒等待失败；改为等待内容快照已提交且busy结束，再断言fieldset启用后选择真实File。保留60ms延迟及原2秒上限，继续核对字幕全文、文件名、单独导出审批/hash、1次规则应用/1次导出/0安装。
2. `resume-copilot.test.tsx` 保存时按 `updatedAt` 排序，原测试却把数组第2个按钮当作片段批注；毫秒时间戳不再相等就选中了整段。明确将片段置为晚1ms后在本机复现相同错文断言；改按稳定 `data-annotation-id` 选择，并分别覆盖片段早/晚1ms两种真实排序，断言选中、序号、精确片段与实际textarea焦点。新增1个独立用例，不删除旧断言或改用户批注排序。
3. `vite-middleware-reload.test.tsx` 在 Windows 出现明确C断言：`!_wcsnicmp(filename, dir, dirlen)`，`src\win\fs-event.c:72`。这与第二轮无堆栈的TCP退出分开记录。夹具临时根先经 `realpath`，不把 `RUNNER~1` 短名交给原生监听。规范目录不变量在macOS原 `/var` 别名下先红，再修绿；这只是该不变量的本机复现，不冒充Windows C崩溃复现。真实Vite子进程、HTTP before→after、恰好2次启动/最大1个运行、相同字节或`.d.ts`不重启、自有清理均保留。

原生监听崩溃同时核对了 [Node 上游修复 #65118](https://github.com/nodejs/node/pull/65118)：libuv 对8.3短目录与长事件名的前缀处理触发断言。[Node 24.21.0 LTS 发行记录](https://nodejs.org/en/blog/release/v24.21.0) 明确收录该修复。因此仅将两个 Windows CI 的 Host Node 从第三轮24.16.0固定到同一24 LTS的24.21.0，保留前轮TCP修复；Linux/macOS、Docker、应用Electron及本机安装的Node不变。规范夹具与修正运行时同时保留，不用跳过真实监听来规避崩溃。

本机上述4个Web文件（含micro-card）完整57/57通过；类型16/16、lint零warning、双端构建9/9与桌面21/21再次通过，536资源同hash同步至上方最新备份，0进程/用户数据变更。Windows完整检查前新增生成时限/这4个Web文件的早期回归门，沿用实际生产边界；原5轮TCP回归、完整 `pnpm test`、独立评测、协议、runtime、ACL与桌面检查全部保留，不降低完整测试并发、不跳过失败或重试碰运气。

这批4文件修正后的本机完整 `pnpm test` 再次实际退出0：普通4,897项，4,877通过/0失败或取消/20原有条件跳过（约240秒），随后独立58/58（约95秒）；新增的1项是明确的另一种批注排序，不与重复执行数混算。日志 `betterme-speech-ci-fourth-full-tests.nA2owv` 仅留本机。推送前fetch确认本地/远端同为第三轮 `897f423`，限定本批8个测试/CI/交接文件，个人三份SSOT相对实施基线无差异。第四轮及后续推送的最终作业结论从文首同一SHA的Actions核对，不预先把这份本机回执写成Windows已通过。

### Windows 第五轮：迟到归档的读写竞争

第四轮正常推送 [`374aa45`](https://github.com/nanfengovo/better-me/commit/374aa45b57762acb936d55c48c852e5f3ebd1515)，运行 [43440809655](https://github.com/nanfengovo/better-me/actions/runs/43440809655)。Windows桌面 [job 131937607691](https://github.com/nanfengovo/better-me/actions/runs/43440809655/job/131937607691) 最终成功（5分27秒），含成品启动、自有服务清理和产物上传；其他平台也通过。Windows质量 [job 131937608270](https://github.com/nanfengovo/better-me/actions/runs/43440809655/job/131937608270) 的5轮TCP及新增前置门全过，但完整普通4,904项为4,883通过/1失败/20原有条件跳过、0取消（约819秒），独立58项尚未运行。第三轮3个失败本轮全部通过。

唯一剩余失败为 `apps/web/tests/studio-committee-http.test.ts` 暂停后的大文本迟到归档，32秒内未见完整artifact。第二轮30秒有界等待没有完全解决此场景。本机原样单跑这两个实际owner用例2/2通过，不据此说Windows无故失败。优先区分外部直接轮询私有文件与原子替换竞争、回调返回早于归档，以及实际写入失败；原日志无底层文件系统错误码，不能凭空断言具体syscall原因。

在真实HTTP/owner/kernel路径为该合成任务的最终JSON替换增加受控“外部独占读取”守卫，其他文件和实际写入照常执行。旧测试在归档前打开私有快照，约4秒稳定复现原 `retained: false` 断言及 `sharingCollision: true`。此为原竞争模式的受控复现，不冒称捕获了Windows原生错误码。修正仅在测试：先通过生产GET加入kernel串行写入队列，等暂停版本之后的新修订及artifact指针已发布，再一次读取私有快照和完整原文；保留守卫防回退，并核对HTTP/磁盘修订与artifact元数据相同。

30秒上限、3秒合成迟到交付、全文逐字比较、0已完成角色/无任务结果、最终paused、模型计量1次与总调用2次等断言全部保留；不改变生产写入器、预算、权限或数据，也不吞掉真实归档失败。修正后同一守卫与两条迟到用例2/2通过，并将这个文件加入Windows前置门；完整检查仍照常执行。最终平台结论须核对下一推送同SHA的Actions。

两个完整HTTP文件、旧历史HTTP与身份边界的26/26关联回归再次通过；类型16/16、lint零warning、双端构建9/9、桌面21/21、Memory与diff检查也通过。依Web测试变更的双端交付规则，536资源同hash可回退同步至本节最新备份；未打开默认profile、重启正式服务或改变用户资料。

第五轮补丁的本机完整 `pnpm test` 已实际退出0：普通4,897项，4,877通过/0失败或取消/20原有条件跳过（约273秒），独立58/58（约83秒）。原始日志 `betterme-speech-ci-fifth-full-tests.06Dz7D` 仅留本机。提交前fetch确认本地与远端均为第四轮 `374aa45`，本批限定测试、CI与三份技术交接共5文件，个人三份SSOT相对基线仍无差异；新Windows最终结论只认同SHA的Actions，不拿本机这份通过提前盖章。

### Windows 第六轮：独立评测的逻辑清单路径

第五轮正常推送 [`a59be31`](https://github.com/nanfengovo/better-me/commit/a59be31399da1cb3f904d8a900a0cef8ce181154)，运行 [43446485326](https://github.com/nanfengovo/better-me/actions/runs/43446485326)。Windows桌面 [job 131957159581](https://github.com/nanfengovo/better-me/actions/runs/43446485326/job/131957159581) 最终成功（4分55秒）；普通质量 [job 131957159788](https://github.com/nanfengovo/better-me/actions/runs/43446485326/job/131957159788) 的4,904项终于全部完成：4,884通过/0失败或取消/20原有条件跳过（约796秒），包括大文本迟到归档与所有前置门。本机日志不代替这份实际Windows结果。

该作业随后第一次执行到独立58项评测，29通过/29失败/0取消或跳过；29项均源于同一个Gold目录清单断言，不是29个新的模型质量结论。原始差异一一对应：实际为 `cases\\gold-backend.case.json` 等Windows分隔符，冻结清单为 `cases/gold-backend.case.json`，文件名/数量本身一致。源审与基线差异核对排除了本轮修改或重建数据集、标签、旧分数及其hash；未拿改清单/hash绕过完整性检查。

将实际递归清单遍历提取为可注入原生路径/读取适配器的 `goldFileList`，生产验证默认仍走真实fs。加入POSIX和Windows两种虚拟原生目录（嵌套/空格/emoji），同一真实遍历函数在修正前POSIX通过、Windows稳定先红，复现同样反斜杠差异，约1毫秒。修正仅将逻辑清单key固定为 `path.posix.join`，实际目录/文件访问仍用原生join；不把实际文件系统当成POSIX。两个平台同时核对确实进行了原生路径lookup，并继续拒绝symlink与非普通文件。

完整Gold文件15/15通过，含原始派生字节/hash、337条证据/147条需求、3个0模型基线、许可、标签隔离、篡改/额外文件/链接拒绝；新加2项是两种路径适配器用例。Windows长套件之前增加该完整Gold文件的早期门，原普通全量、独立评测、协议、runtime与桌面检查均保留。本批只改评测工具/测试、CI与交接，不改Web/Host生产实现或再次替换安装资源，沿用上方536资源与最新可恢复备份；个人三份SSOT和冻结Gold v1相对实施基线仍无差异。

第六轮补丁本机完整 `pnpm test` 实际退出0：普通4,897项，4,877通过/0失败或取消/20原有条件跳过（约232秒），随后独立评测60/60（约88秒）；独立分母增加2为明确的POSIX/Windows路径回归，不删旧58项。完整日志 `betterme-speech-ci-sixth-full-tests.TvJ4zA` 仅留本机。类型16/16、lint零warning、双端构建9/9、桌面21/21、脚本协议 `evals:career`、runtime10/10、Memory/diff与YAML检查均通过。提交前fetch确认本地/远端 `a59be31` 一致，限定本批6个评测/CI/技术交接文件；末次提交和最终两个Windows作业仍以文首Actions同SHA核对，不用旧作业或本机结果替代。

### Windows 第七轮：完整报告清单的 PDF 路径

第六轮正常推送 [`476e59d`](https://github.com/nanfengovo/better-me/commit/476e59de87b3c5a35871136106ca4b521a0114b5)，运行 [43452149622](https://github.com/nanfengovo/better-me/actions/runs/43452149622)。Windows桌面 [job 131976783606](https://github.com/nanfengovo/better-me/actions/runs/43452149622/job/131976783606) 最终成功（6分27秒）；质量 [job 131976782871](https://github.com/nanfengovo/better-me/actions/runs/43452149622/job/131976782871) 的完整普通4,904项再次4,884通过/0失败或取消/20原有跳过（约721秒），Gold及其余前置门均通过。独立60项已改善为59通过/1失败/0跳过或取消（约131秒），原29个Gold差异消除。唯一失败在完整HTTP采样报告：`quality/`前缀的PDF数为0，预期3；前面的五案例、3份已测质量、2份失败、8次原根计量等断言已通过。

原用例本机单跑通过，不能据此声称Windows无错。区分清单路径分隔符、PDF生成缺失、报告发布未完成三个方向后，将报告中同一实际递归遍历提取为 `reportFileManifest` 并保留原逻辑，注入Windows原生路径适配器约2ms复现同一个 `0 !== 3`；POSIX通过。修正仅将逻辑清单key改为POSIX，物理lookup仍原生，所有文件完整字节/SHA-256继续列出，符号链接与非普通文件拒绝保留。批次比较的重复遍历复用同一函数，并在其完整回归中断言可移植key；不覆盖旧报告或更改旧分数。

修正后两平台报告路径加完整Gold17/17通过；新两项覆盖3份模拟PDF名、嵌套/空格/emoji、原生lookup、精确二进制字节/hash与拒绝路径。原真实HTTP→离线模板打印用例另行通过，并新增对3份实际PDF逐一读取文件头、字节数与独立SHA-256核对，保留原五案例/全失败分母/0报告推理/不重派等全部断言。这不是用模拟字节替代原真实打印测试，Windows仍须新SHA实际复验。报告路径文件加入原Gold早期门，普通全量、完整独立评测、协议/runtime/ACL与桌面成品门均保留。

同一第六轮另有macOS x64 [job 131976783555](https://github.com/nanfengovo/better-me/actions/runs/43452149622/job/131976783555) 在DMG卸载阶段报 `hdiutil: couldn't eject "disk2" - Resource busy`。仅只读提取该日志，未将其混记为Windows故障或擅自修改Mac打包逻辑；最后发布时分平台报告实际结论，不把Windows两项成功称为整条工作流全绿。本批仍只改离线评测/测试、CI与交接，不改Web/Host生产或安装资源、正式服务及个人资料。

第七轮补丁的本机完整 `pnpm test` 实际退出0：普通4,897项，4,877通过/0失败或取消/20原有条件跳过（约229秒），独立62/62且0跳过或取消（约87秒），新增2项为两种报告路径适配器。日志 `betterme-speech-ci-seventh-full-tests.cj2cAT` 只留本机；类型16/16、lint零warning、双端构建9/9、桌面21/21、协议 `evals:career`、runtime10/10、Memory/diff与实际YAML解析均通过。提交前fetch及live remote均为 `476e59d`，本批限定9个评测/CI/交接文件，冻结v1和个人三份SSOT相对基线无差异。仍以最终推送同SHA的两个Windows作业完整结论交接，不拿本机结果提前替代。

### Windows 第八轮：全部正向流程等待身份载入

第七轮正常推送 [`d5ca112`](https://github.com/nanfengovo/better-me/commit/d5ca112a3d40d5afa74fc3046f8c05bdb83fcca9)，运行 [43457619995](https://github.com/nanfengovo/better-me/actions/runs/43457619995)。Windows桌面 [job 131995815574](https://github.com/nanfengovo/better-me/actions/runs/43457619995/job/131995815574) 最终成功（5分20秒），macOS x64亦成功（14分35秒），上一轮DMG busy未再现，其余平台也成功；Pages/Release按原分支规则跳过。Windows质量 [job 131995815522](https://github.com/nanfengovo/better-me/actions/runs/43457619995/job/131995815522) 前置门含报告路径全部通过，完整普通4,904项为4,883通过/1失败/20原有条件跳过、0取消（约699秒）。独立62项因前段失败未执行，不把前置门或本机结果当作该段已过。

唯一失败为 `career-replay-feedback-ui.test.tsx` 的完整正常反馈/规则采用回退流程：载入当前版本后只让出3次immediate就勾授权执行，2秒等不到首个模型回调、busy已为none。区分禁用控件期间事件未生效、授权未提交、实际SQLite/WebCrypto慢三个方向，给真实 `/feedback/identity` 合成请求增加60ms后，在本机约2.05秒先红复现同一位置和同一超时；原样单跑通过不替代这个受控反例。

此前第四轮只修了同文件的字幕导入，未覆盖其他载入调用者。这次将60ms延迟放到共享fixture，所有五条正向流程共用 `loadCurrentVersion`：先等真实内容快照与busy解除，断言fieldset可用且尚未授权分析，再交给各流程明确操作。完整文件10/10通过，原2秒上限不变，内容/claim hash、原根新idempotency、规则预览/单独采用/回退历史、完整字幕导出、停止迟到结果与0自动模型调用等断言全部保留。没有改产品budget、业务busy保护或用户授权规则；已有Windows前置门继续覆盖整个文件，无须删除/跳过测试或改变完整并发数。

类型16/16、lint零warning、双端构建9/9、桌面21/21、协议 `evals:career` 与runtime10/10再次通过。按Web测试也需双端同步的仓库规则，536资源同hash可回退同步，最新即时备份见上方 `Gkh2eh`；未打开默认App/profile、重启正式服务或改个人资料。本批仅一个Web合成测试及三份技术交接，最终仍需完整本机与最后SHA的Windows实际复验。

第八轮补丁的本机完整 `pnpm test` 实际退出0：普通4,897项，4,877通过/0失败或取消/20原有条件跳过（约244秒），独立62/62且0跳过或取消（约85秒）；完整日志 `betterme-speech-ci-eighth-full-tests.ZlThmC` 只留本机。Memory/diff和实际YAML解析通过；fetch确认本地/远端均为 `d5ca112`，冻结Gold v1与三份个人SSOT相对实施基线无差异。限定本批4文件正常推送，再以最后SHA的两个Windows作业最终结论交接，先前失败与本机通过均不替代远端。

### Windows 第九轮：Git 准备与非法输出校验分开验收

第八轮正常推送 [`f65b31e`](https://github.com/nanfengovo/better-me/commit/f65b31e390f96a692fca7df8285b4f810b908c78)，运行 [43462234239](https://github.com/nanfengovo/better-me/actions/runs/43462234239)。Windows桌面 [job 132011850777](https://github.com/nanfengovo/better-me/actions/runs/43462234239/job/132011850777) 最终成功（5分10秒），其余平台也成功；Pages/Release按原规则跳过。Windows质量 [job 132011850223](https://github.com/nanfengovo/better-me/actions/runs/43462234239/job/132011850223) 普通4,904项为4,883通过/1失败/20原有条件跳过、0取消（约843秒）；前轮反馈UI已过，独立62项因前段失败未执行。

唯一失败在 `evidence-harvester-service.test.ts` 的非法引用/模拟泄密输出用例：期待模型调用1次，实际0次。原合成policy给真实Git准备与生成合计仅3秒，原日志无entry错误码，不能伪称已捕获其具体超时码。对照准备时限、来源过滤/去重、绑定或校验不同拒绝三种可能，在同一实际 `GitEvidenceSource.capture` 前增加3.1秒准备延迟，本机约3.25秒稳定复现同一个 `0 !== 1`；原样单跑通过不代替该反例。新调用次数断言保留实际 `entry.errorCode`，再次失败能区分准备取消、Git内部时限和输出拒绝。

仅将正向合成policy的 `maxActiveMs` 从3秒设为30秒，保留3.1秒慢准备和原三种非法输出；必须真实派送1次、非准备超时、无引用/无Workspace写入、同提交不重试。另补完整合法JSON中带模拟Bearer泄密的候选，明确断言生产返回 `unsafe_micro_fact_output`；不靠坏JSON失败冒充泄密守卫。生产policy范围、Git自己的8秒时限与原200ms生成超时用例均不变。

新增独立200ms准备时限用例，在实际捕获barrier触发真实组合signal，随后仍执行原Git捕获路径：准备中止、失败留存、0模型/0写入、1次提交尝试计账且再次读取不重试、不变账。完整采集器15/15通过（新增1条独立用例），整个文件加入Windows前置门；所有全量、独立评测、协议/runtime/ACL及桌面成品门保留。本批仅Host合成测试、CI与三份技术交接，不改Web/Host生产或再次同步安装资源，沿用上方536资源与可恢复备份；个人SSOT及冻结数据不改。

第九轮补丁本机完整 `pnpm test` 实际退出0：普通4,898项，4,878通过/0失败或取消/20原有条件跳过（约237秒），独立62/62且0跳过或取消（约82秒）。日志 `betterme-speech-ci-ninth-full-tests.0FXZRI` 只留本机；类型16/16、lint零warning、双端构建9/9、桌面21/21、协议 `evals:career`、runtime10/10、Memory/diff与实际YAML解析均通过。提交前fetch确认本地/远端 `f65b31e` 一致，限定5个测试/CI/技术交接文件，个人三份SSOT和冻结v1相对基线无差异。最终交接仍只认最后推送同SHA的两个Windows作业，不将本机完整结果提前写成远端通过。
