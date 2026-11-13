# 委员会旧入口退役与隐私证据复用：阶段闭环

2026-11-12，`agent-os`。本人最新要求是“先检查代码完成这一阶段的闭环后结束目标”。本报告只验收旧委员会执行入口退役、历史读取兼容与新任务证据复用；原始统一 Agent 全目标仍有未完成项，不能标为整体完成。阶段完成后按本人要求停止自动目标。

## 代码审查结论

按上一已验收的 [生产调用回执](committee-caller-adoption-2026-11-12.md) 和本阶段实际改动检查执行权、上下文/账号授权、计量、历史与完整内容。未将整份脏工作区当成本阶段改动，也未宣称做过整仓独立审计。

| 检查项 | 本阶段结果 |
| --- | --- |
| 旧生成权威 | 删除 `CareerStudio.committee()` 的模型/证据循环及其独立预算；直调只校验访问后返回 410。生产 `runHiringCommittee` 执行调用只在 kernel 内 |
| 旧 HTTP | 认证之后 `/career-studio/committee/start` 返回 `studio_committee_moved_to_agent_tasks` 410，不解析、选模型、创建任务或生成；未认证仍 401。旧方法名在 Web client 内分流 tasks 的既有行为保持 |
| 历史兼容 | 旧 SQLite operation 完整读取/列表保持，读取不重写、不生成或迁成新任务。新任务继续为只读投影，不复制 SQLite 执行权威 |
| 新任务证据目录 | `describeStudioCommittee` 仅校验当前任务/授权/冻结快照并提供目录，不读取文件、不声称文件仍新鲜。目录不返回源码正文或授权根 |
| 实际证据复用 | configure/resolve 使用 kernel 当前 review bundle，真实重新读取与授权核验计原任务根账；同一轮多个选择按 operation 共享一次 bundle，不再次免费调用 Broker |
| 失败与权限 | 源码变化、未授权 evidence ID、另一 owner、runtime digest 变化、撤销 context、原工具预算耗尽均拒绝。失败不更新既有 policy；内核安全错误码转换为 StudioError，而非吞成 `privacy_local_failed` |
| 目录异常 | 已失效授权可从当前目录省略；损坏检查点/服务异常不静默伪装为空目录。元数据目录不是新的源码使用许可 |
| 输入输出 | 本阶段没有加入任何截取；历史 CRLF/emoji/首尾空白逐字保留。上阶段的完整 wire/迟到 artifact 机制继续由相邻回归验证 |

主要实现：`apps/agent-host/src/career-studio/{service,http,privacy-sources,committee-tasks}.ts`、`kernel/service.ts`、`server.ts`。旧本地委员会 Adapter 的纯协议回归仍保留，没有生产 HTTP 执行入口。

## 测试与失败处理

- 首轮迁移回归 45 项：38 通过、7 失败。未将失败算完成。修正测试夹具重复创建改变 budget 的问题、旧 403/404 约定、过短轮询，以及失败报告仍应保留 unknown 而非消失的断言；没有放宽生产权限或预算。
- 新真实认证 HTTP 首轮 6 项：4 通过、2 失败，定位到隐私入口吞掉内核安全错误码。实现转换后 6/6 通过；随后纳入最终 Host 合集。
- 最终 Host 合集 124/124，另补完整旧历史用例 1/1；最终 service 全文件复核覆盖该用例及删除旧执行器遗留无效 map 后的实现。按不同用例合计 125，不把重跑累加。
- Web 12/12：生产委员会 client → 认证 HTTP → 原内核，包括停止/明确恢复/迟到全文/原根记账；不是新改 Web 页面，也不是实际模型质量评测。
- Desktop 14/14；Host 类型、Host build、定向 ESLint `--max-warnings 0`、完整 `pnpm desktop:build` 和 diff 检查通过。不是整仓全套测试全绿声明。
- 认证正例实际 14 次脚本模型调用、1 个 owner Adapter、0 旧 complete。两个来源的选择只增加原根 2 次工具费用，同次目录读取不增；再次实际 resolve 再增加 2 次。原 ceiling 耗尽不清账/另开任务。
- 本阶段 0 外部模型调用、0 用户个人简历写入、0 提交/推送。

完整原始成功/失败日志和相关源码快照：`output/agent-runs/committee-retirement-2026-11-12/`。不覆盖上阶段回执或原始评测材料。

## 桌面与运行状态

完整桌面重新构建后，现安装 App 与构建并集独立逐路径/大小/SHA 比较：533 文件、0 差异，因此没有重复替换成品。现安装 DFS SHA `7bdb7347f61e3dbb760d106457e087f7e767bc88ddb9395f48418108854ebf8f`，原回退 `9eb74f029a4848cc89166b19880909b5b031784a000202d7c44a09720497e486` 亦独立核验。可回退目录保持 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-h6gVr5/previous-dist`。

实际安装 main/preload/React 在独立离线 profile 启动与关窗重开两窗口通过，0 真实服务/模型请求。本项只证明成品可启动，不冒称真实用户账号完整业务验收。

真实 5173 PID90086、5179 PID89415 仍在，未重启、刷新或操作用户窗口。Host 使用源码链接，新增 Host 实现需本人下次正常重启加载；没有擅自停止现有服务。全部测试进程均为本轮自有临时环境，终态后不留后台自动任务。

## 停止边界与未完成目标

本阶段闭环不等于原始 R1–R8 全部完成。仍包括：回放/harvester/隐私模型步骤/Coding Sandbox 等循环迁移；新类型检索与精确 offset 逐类验收；简历选材和表达质量；不同第二模型的同条件实跑；更广授权/多根变化与最终全目标审计。详见 [完整要求清单](unified-agent-expansion-2026-11-11.md)。个人候选仍待本人核对，不自动采用或写 FactBase。

按本人“结束目标”的最新要求，本阶段验收后停止自动续跑。系统无取消/清除 action 时使用 `paused` 保存未完事实；不把全目标误标 `complete`。若将来本人明确恢复，再从上述未完成项继续，而非自动开启下一阶段。
