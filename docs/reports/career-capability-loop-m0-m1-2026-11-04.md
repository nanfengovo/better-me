# M0＋M1：本地 Ollama 真实生成、验证、保存与复用

日期：2026-11-04。状态：**本地实现及合成验收完成，独立预览保持运行；未提交、推送或部署。** 用户选择本地 Ollama，未调用云模型、配置新密钥或迁移真实资料。M2–M4、P1/P2 不在本批范围。

## 1. 交付与体验入口

首条业务纵切片是“两批结构化岗位导出 → 要求原文变化 → 私人报告”。统一 Agent 的「任务」中增加默认折叠入口，不新建平级聊天 Agent，不把报告写入共享岗位索引或既有 Agent 历史。

- 已运行：[合成验收工作台](http://capability-regression.localhost:5393/tests/ui-lab/capability.html)。独立 Web 5393 / Host 5399。
- 临时账号：`capability-lab`；临时密码：`synthetic-career-only-2026`。只用于本次全新临时库，不是本人真实账号。
- 下次从仓库根启动：`pnpm dev:capabilities`。入口拒绝占用中的端口，不结束或接管未知服务；每次新建临时库并真实执行首次生成与再次复用。当前已启动，不需重复运行。
- 预览使用正式 `IdentityGate`、身份菜单、能力客户端和任务组件，不是截图或静态成功状态。正常完整版接线已落入 `BetterMeAgentCenter`；未重启正常 Host，不能据此声称原 5173 已加载本次后端。

## 2. 最终真实验收证据

通过真实认证 HTTP 请求调用默认生产 builder，没有注入回归候选。提供方固定为 loopback Ollama，模型 `gemma4:e2b-it-qat`，检查本地 tag 不含 `remote_host` / `remote_model`。仅向模型发送通用格式规格及有限错误反馈，不发送本次岗位正文、简历或已有记录。

| 项目 | 首次任务 | 第二次任务 |
| --- | --- | --- |
| 任务 ID | `a1578e68-72ab-4cfa-b07b-6ce4e93e5c95` | `6729fdce-6ecc-48dc-ba02-cf656bcb17c8` |
| 实际模型构建次数 | **1** | **0** |
| 固定工具 | `job-export-normalize-v1`，版本 1 | 同一版本 1 |
| 源码 hash | `d686df25ce49f26846204161842f21b4f4aa51386572102e64037a7b0d6e1860` | 完全相同 |
| 输入 hash | `26d494f166f1549885c1906a06aa928cc1f31833e5cc1d26319ea1f6ad43bf3a` | `088385d4634af3811ee7b3e2a966c1bde47d4f75e93b9764b863544a473e66e7` |
| 可复算结果 | 新增 PostgreSQL；移除首轮 canary | 新增 Kubernetes；没有首轮 canary |
| 独立任务验证 | passed | passed，独立新验证回执 |
| 私人报告保存回执 | `125ab946-f5d4-4808-b18a-3d9cc8632b1b` | `dbd13adf-affb-46f7-b4a8-6159037d0f4f` |

模型 digest 为 `07ea59a474013479c8b6b802bef095c40e964a1d776ba02f264c0e30e1aede0c`。此次首次构建生成 477 token，模型请求耗时 11,518 ms（不是完整任务耗时或普遍性能保证）。首次工具资格验证包含 3 个留出执行样本及 3 个非法输入拒绝用例；两次实际任务另逐行核对覆盖、来源和要求原文。报告每批 2 行，另有 2 行未配对，明确显示“本批未见不代表关闭”。

最终证据只在本机新建目录：

`/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-capability-live-aLGy3t`

其中合成 owner `fa4841b6-62fe-4eec-9ec8-4f7bc0430331` 的 `accounts/owners/<owner>/career-capabilities-v1/career-capabilities-v1.json` 包含真实生成源码、构建元数据、资格/任务验证、输入和两份报告/回执，文件权限实际为 0600。临时目录可能被系统清理；仓库中的脚本、测试和本报告是可复现入口，不把临时文件当永久产品备份。

首次调试的 JSON 封装输出曾连续失败，达到 3 次预算后停止，未发布或伪造报告；该失败审计保留在独立临时目录 `betterme-capability-live-r5xmc7`。之后改成模型直接返回函数源码，仅移除传输用 markdown 围栏，不手工补写或替换生成源码，才取得真实验证通过。表中 1/0 是最终这一对任务的次数，不是整个开发过程只调用过一次模型。

## 3. 实现与信任边界

| 接口/模块 | 责任 |
| --- | --- |
| `packages/agent-contracts/src/capabilities.ts` | 两种结构化 JSON 格式、任务约定、版本/授权/验证/业务回执和合成输入 |
| `apps/agent-host/src/capabilities/ollama.ts` | 固定本地模型真实生成；最多 3 次构建，每请求 150 秒，不回退云服务 |
| `sandbox.ts` | 每次调用新建 Worker 和 QuickJS WASM realm，只输入/输出 JSON，无宿主桥接 |
| `verification.ts` | 可信来源 oracle、资格样本与反例、实际输入逐行验证；可信差异计算不替代生成工具的执行 |
| `service.ts` | 私有能力目录、构建/执行/晋级、串行原子接纳、幂等报告、撤权和恢复 |
| `http.ts` / `server.ts` | 由认证会话派生 owner；捕获原会话租约，管理和写入均重新检查 |
| `apps/web/src/services/capability-client.ts` | 前后身份代次检查，迟到 headers/body 不污染新身份 |
| `CareerCapabilityTask.tsx` | 按次明确授权、真实阶段/报告/回执、停用/再验证/仅保存恢复；收起不等于伪造完成 |

运行器对生成代码强制限制：源码 64 KiB，输入/输出各 2 MiB，QuickJS 堆 **16 MiB**、栈 256 KiB、解释器执行 2 秒，外围 Worker 最长 4 秒。生成代码作为数据传入 QuickJS，不进入 Node `eval`、动态 import 或页面主上下文。Node Worker 的 `eval: true` 只执行固定可信 bootstrap；没有把生成源码当 Node 脚本执行。取消等待 Worker 终止，不遗留孤儿执行。

这些是引擎/应用边界，不是容器、操作系统沙箱或完整进程 RSS 上限；WASM/引擎漏洞、宿主本地恶意进程不属于本批已证明安全的范围。Node Worker 另有限制 V8 堆，但不把它称为整个进程内存硬限额。选用已有 MIT 许可 [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) 的[资源限制 API](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten/classes/QuickJSRuntime.md)，而非从零编写解释器；许可见[上游 LICENSE](https://raw.githubusercontent.com/justjake/quickjs-emscripten/main/LICENSE)。模型请求使用 [Ollama Chat API](https://docs.ollama.com/api/chat)。

存储与授权规则：

- 新增独立 owner 私有库，不迁移、不改写旧 Agent/简历记录。只有访问能力路由才惰性创建该库。
- 每 owner 单个构建队列；每次晋级/授权变化/报告接纳在同一个串行原子点重新验证会话、任务授权、期限和 catalog revision。请求开始时的检查不是最终提交许可。
- 任务固定原 owner、原会话 hash、输入 hash、授权和 9 分钟总期限；A→B→A 也不能复活原租约。迟到结果最多留原账号审计，不借新会话发布或保存。
- 私人报告与业务回执在同一私有 JSON 原子写入中接纳。保存失败显式标未保存，保留上次持久状态；新授权下只重试保存，不重新构建/执行。
- 逻辑操作 key 同输入查回原任务/回执，异输入 409；目录 revision 冲突不覆盖。报告历史不因版本停用/回滚而删除。
- 使用 [Node SQLite](https://nodejs.org/api/sqlite.html) 的[独占事务](https://www.sqlite.org/lang_transaction.html)取得单写者 OS 租约，崩溃自动释放，不使用会竞争的过期 PID 文件删除锁。它是拒绝第二写者的保护，不是多进程分布式写入支持。
- 版本复用要求源码 hash、契约、执行环境和验证器相符；变更后验证失效，旧报告标待核对而原回执保留。本人停用的原版本可在新授权下独立重验后恢复选择，形成不改历史的回滚。
- 沿用私有 JSON 的 16 MiB 文件上限；到限失败关闭、提示存储失败，不静默裁剪历史。长期增长/分库是后续工程，不隐式清理数据。

## 4. 验收覆盖

专项 32/32，确定性模型替身只用于稳定制造失败和竞态；第 2 节真实生成验收另走生产默认 Ollama，没有拿替身证明生成成功。

| 原验收项 | 本批证据与范围 |
| --- | --- |
| A01 任务约定 | 固定两批输入、只比较来源原文、只保存私人报告、父任务预算；非法输入拒绝，无个人技能推断 |
| A02 正确分流 | `capability-recovery.test.ts` 实测已有回执、组合、缺输入、缺授权、临时故障、真缺口、禁止执行七种结果 |
| A03 真补齐 | 真实 HTTP 验收首次源码生成→资格→固定版本执行→任务验证→保存，见第 2 节 |
| A04 独立判分 | 错误候选预算耗尽不发布；来源伪造/删行/改要求拒绝；重复 ID 不随意配对、不同 namespace 同 ID 不合并、恶意文案按数据处理 |
| A05 受限执行 | `capability-sandbox.test.ts` 宿主文件/环境/网络/子进程探测、死循环、输出膨胀、取消/终止；16 MiB 分配超限明确报 `sandbox_memory_limit`，不是仅等超时 |
| A06 三种结果 | 分开资格、任务输出验证、业务保存；合成保存故障不显示已完成；仅保存恢复产生一个回执且不重生成 |
| A07 真复用 | 最终第二次新输入零构建、同 hash/版本、结果改变、新回执、无首轮 canary；不兼容输入不强行调用 |
| A08 切号/撤权 | 构建后、资格后、发布后、执行后、业务提交前五个边界，分别切号和撤权；A→B→A、忽略取消的迟到 builder、旧会话管理操作均不能借新授权 |
| A09 并发幂等 | 同 owner 并发任务只构建一次、各自产生报告；同 key 同/异输入、旧 revision、提交前撤权拒绝、提交先接受则保留真实回执；重查不制造第二效果 |
| A10 安装/外部服务 | **未开放，属于 M3**。本批没有安装脚本执行、任意 shell、外部服务调用或凭据继承 |
| A11 失效/回滚 | 修改实现/环境使验证失效，历史回执保留；新候选失败不覆盖旧史；停用新版本、重验旧版本后新任务零构建选回旧版 |
| A12 恢复/预算 | 有限 3 次失败修复、取消、错误状态、Host 重启/硬崩溃后中断且旧授权撤销，不自动重发构建；OS 写者租约释放，原回执可查 |

实际 HTTP 测试使用 A/B 同逻辑 ID、伪造 owner、跨账号取消和 A→B→A，原合成连续性记录字节保持。Web 测试覆盖迟到响应体跨身份代次被拒绝。真实 HTTP 与浏览器均使用新建临时库，未读取本人账号资料。

最终门禁：

- `pnpm test`：**3,695 总项，3,685 通过、0 失败、10 跳过**，日志 `/tmp/betterme-capability-final-test-20261104.log`。
- 新专项：**32/32**；既有 identity/OIDC/server 回归另跑 **30/30**。
- `pnpm typecheck`：13/13；`pnpm lint`：零警告；新增测试/脚本/UI 夹具额外 strict TypeScript 检查通过。
- 最终 `pnpm build`：8/8（7 项缓存）；既有地图依赖 externalized/chunk-size 提示仍存在，不当作本批消除。
- 桌面 1280×900 与短屏 390×640 实际浏览器检查，使用同一正式任务组件；390 宽下内容宽 384、无横向溢出、操作按钮可见，两个报告为真实持久记录，无页面业务错误。截图为 `output/playwright/capability-loop-desktop.png` 和 `capability-loop-mobile.png`，截图不代替真实生成/权限测试。
- 启动早期 Vite 先于 Host 就绪，独立页曾有瞬时代理连接错误；Host 就绪后仅重载本次合成页，登录和两份报告正常。没有刷新本人原页面。重启脚本未提供就绪等待 UI，此体验限制不隐瞒。

## 5. 数据保护与交接

所有新测试数据、真实模型验收数据和预览账号均在新建临时目录；模型只接触通用规格。未迁入、覆盖、删除或向模型发送本人真实简历、旧版本、已有 Agent 对话/记忆，也未读取真实账号目录来做本批测试。此结论基于实际操作范围，不冒称对全部真实数据库做过字节级前后校验。

原正常 5173/5178/5179 及本人浏览器页没有主动重启、刷新、登录或保存；开发 HMR 可能检测源码更新。仓库已有大量未提交工作，本批只改能力模块、最小接线、依赖、验收入口及交接文档；并发社交登录/Casdoor 文档和接线保留，不把它们算作本批实现或回滚。没有暂存、提交、推送、换分支、Docker 更新或清理旧验收目录。

收尾保护核对：开始时 169 个 dirty/untracked 文件中，154 个指纹保持，13 个是本批声明的修改/混合交接文件，另外 2 个为并发更新的 Casdoor/社交登录文档；没有原路径消失。新增本批文件 23 个。该比较针对仓库源文件，不扫描真实账号库；并发内容采用最小补丁保留。`pnpm memory:check`、`git diff --check` 和 30 个本地文档链接检查通过，暂存为空，分支/HEAD 保持 `agent-os` / `1668ecfce4bb57f4180d3c47f8bb2d5f62777732`。

下次继续先读本报告。若要把能力应用到真实岗位/简历，先确认具体输入和使用范围；不能以本批合成授权替代本人资料授权。后续业务纵切片 M2、安装/服务 M3、长期调度 M4 另行实施，本批不是通用任意代码 Agent 或公网多租户 SaaS 安全认证。
