# JD 截图识别归入统一任务内核

2026-11-12 · `agent-os` · OCR本阶段隔离验证已完成，以下保留当时快照。当前安装资源/回退和旧HTTP后续改动只看[五入口退役与单次任务回执](legacy-inference-retirement-2026-11-12.md)，不是本页旧hash。完整R1–R8仍active；全部合成账号/原图/脚本回答、0外部模型，不是OCR准确率或正式模型质量成绩。

## 实际改动与边界

- `jd_ocr` 是实际任务类型，不是旧浏览器循环的包装。`JdMatchModal → recognizeJdScreenshots → jd-ocr-task-client` 仅通过 `/api/v1/agent/tasks` 及任务子路径执行，沿 Provider 当前明确底座与原 rootScope。每次模型和格式修复均由内核计同一根账；创建、上传、读取不推理。
- 先冻结有序 manifest（名称、MIME、原始字节数、完整 data URL 的 SHA-256），再逐图上传完整原图。保留最多 6 图、单图 10 MiB、合计 24 MiB；没有缩图、转格式、只发已读完的子集或降低旧容量。图片不塞进 8 MiB 任务 JSON，而是归入当前 owner / task 的私有输入目录，每文件 0600、目录 0700，验证 canonical base64、签名、大小和完整 hash。
- 单图请求仍在现有 16 MiB HTTP / 私有 JSON 硬限内，不扩大通用 body 限额。图片必须属于已存在任务的冻结槽位，不能上传任意无主文件。仅统一 tasks 命名空间提供认证 `POST/GET /:taskId/images/:imageId`；另一个 owner、陈旧 revision / source、运行中修改、损坏或不安全链接/权限均拒绝。
- 每次实际推理前重新核对全部原图，再计账并发送有序多模态部件。当前底座不支持图片时在模型计费前明确停止，不换 API / 模型，也不丢图后发送。未完成输出完整保留并暂停；格式校验最多初次加两次修复，每次收费。超 100 万字符原始输出完整保存私有 artifact 后明确失败，不裁剪成假成功。
- OCR `text` 保留首尾空白、CRLF 和全部可见内容；trim 只用于判断是否有可读文字。输出先进入待核对候选，仍须“确认并使用正文”，不会自动分析、创建岗位、改简历或写 FactBase。截图内的指令是来源数据，不成为系统指令。
- 关闭 / 换页只停止观察；显式停止才暂停任务。读取上次任务与原图只 GET，恢复许可不持久化。暂停恢复必须本人重新勾选，使用原任务 ID / 原图 / 固定底座 / 累计账；上传结果未知先核对已提交槽位，不自动重发 POST。来源、图片顺序、账号或底座变化拒绝沿用旧许可。
- 账号租约在异步原图哈希前捕获，哈希后再次核对，避免计算期间换账号后将旧账号图片上传到新账号。Modal 资料 / 运行时代次守卫也挡住迟到结果。

## 回归与实际双端证据

最终 **72 定向 +28 相邻 +14 Desktop =114 项通过**，文件集合不重叠，早期子集不重复计数。Contracts / Host / Web 类型检查、Host 构建、定向 ESLint `--max-warnings 0`、Electron 脚本语法、`git diff --check` 和完整 `pnpm desktop:build` 通过。不是整仓测试成绩；既有 Atlas Node 外置 / 大 chunk 构建提示保留。

- 内核覆盖六图 24 MiB 精确传输、容量 / 顺序 / 重复 / revision / owner / lease / runtime 守卫、损坏 / 权限 / symlink、原根预算、完整部分及无效输出、收费修复、超大 artifact、停止迟到结果与 Host 重启。图片存储外置后，最大输入任务 JSON 仍小于 16 KiB。
- 生产 client → 实际认证 Host：故意在首张原图已提交后丢失响应；再次显式调用先读状态，最终只有 6 个上传 POST，而不是 7 个。聊天 1 次 + OCR incomplete 1 次 + 手动恢复 1 次 = 同根 3 次、1 个 adapter。完成 / 暂停重读不增加模型或 task POST；全量原图 GET 哈希一致。
- 实际 React Modal / 认证 HTTP：真实 FileReader 和文件 input、真正卸载重挂后人工读取 / 恢复、许可未勾选、候选全文一致、原正文与业务保存回调不变。读取中的图片不发送；移除截图时迟到结果不进入新候选。
- 配置 SDK wire 测试核对一次请求中的六个有序 image_url 部件与 OCR strict schema，原生不支持图片时无原生调用或 fallback。这里验证传输机制，不证明某模型的视觉能力。
- 实际浏览器：伴侣先聊天建立根；真实 file input 选入 `[10,10,1,1,1,1] MiB` 六张有效 PNG，浏览器 naturalWidth 均为 1。明确识别后暂停，刷新 / 读取原图不增调用且许可为 false；手动恢复原 ID 后完成。最终重新加载并读取已完成任务，调用仍 3、task POST 仍 11、6 原图 / 完整输出一致，原 JD 正文为空，legacy POST = 0。截图 `output/playwright/jd-ocr-task-complete.png` 仅记录合成上传视图，不代替下方完整断言。
- Electron 三个独立进程：安装 preload + 源码 React / Provider / 默认 client + 认证临时 Host；第一进程聊天后识别暂停（2 次），第二进程只读恢复原图、许可 false / 恢复按钮 disabled，手动勾选后原 ID 完成（3 次），第三进程只读完成回执（仍 3 次）。全程 2 任务、1 根、1 adapter；六原图 / 24 MiB 的 DOM、Host 入模及 manifest hash 完全一致，原 JD 正文不变。第三次完整任务 hash 与第二次相同，task POST 不增，legacy POST = 0。

Electron 原始目录：`/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-ocr-1nndKG`；Host `betterme-ocr-browser-P6NMxb`。完整任务 JSON SHA-256 `ede1781f95e90392b0716e073e4d57f28300de0e50e8de57b9029adbde5a3034`；`restore-summary.json` SHA-256 `8a0c88c6cc23823a0ddbbb206c5a49213c6203fb3511f8361f22927b8a2f6308`。Electron 每阶段阻止 2 个隔离范围外的请求，所有范围外网络均禁止；0 外部模型实际调用。GPU shared-image 提示未影响断言。

初轮 Electron 未通过的原因是测试服务未启动：直接 Vite 缺少 tsx 对源码 `.js` 导入的解析，返回 ECONNREFUSED，0 模型请求。改用既有 tsx 启动方式并确认新 Host 调用为 0 后完成上述三进程链。浏览器 catalogue 的合成响应不代表真实连接或视觉质量，不为消除夹具提示扩大生产配置。

复现（Electron 必须使用全新合成 Host）：

```sh
pnpm exec tsx --test apps/agent-host/tests/jd-ocr-task.test.ts apps/agent-host/tests/jd-intake-task.test.ts apps/agent-host/tests/career-task-runtime.test.ts apps/agent-host/tests/agent-task-kernel.test.ts apps/agent-host/tests/career-task-http.test.ts apps/web/tests/jd-ocr-http.test.ts apps/web/tests/jd-intake-http.test.ts apps/web/tests/jd-import.test.tsx apps/web/tests/jd-match-readiness-ui.test.tsx
pnpm exec tsx apps/web/node_modules/vite/bin/vite.js --config apps/web/tests/ui-lab/jd-ocr-live.config.ts
node apps/desktop/tests/jd-ocr-smoke.cjs '/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app/Contents/Resources/app/dist'
```

最终日志：`/tmp/betterme-jd-ocr-regression-final.log`（72）、`betterme-jd-ocr-neighbor-final.log`（28）、`betterme-jd-ocr-desktop-tests.log`（14）、`betterme-jd-ocr-electron-final.log`、`betterme-jd-ocr-desktop-build.log`、`betterme-jd-ocr-host-build.log`、`betterme-jd-ocr-lint-final.log`、`betterme-jd-ocr-offline.log`。

## 当前安装资源与保护

- 相邻 BetterMe.app 已可回退同步。最终独立按路径 / 大小 / SHA-256 比对：预期 533、安装 533、差异 0。安装清单 `20ce8653d79a269362600c05f49c8283ffa8ec6fcc7eb4e500dbc0d3f39d3ad9`，Web 清单 `61b08ccc8c30b5ddbbab67753fc635ae58930ce2d2fdb07b5092a0c0fb80c8a9`。
- 紧邻前版完整备份：`/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-PtUDXr/previous-dist`；前版清单 `54b8ec2a8762603d7228f420f907d46d7770df6651326108acc38ca791214d1c`。未覆盖原备份。
- 安装 main / preload / React 的离线两窗口重开另行通过，摘要 `betterme-electron-offline-5Snigj/summary.json`：Electron 34.2.0、4 次合成读取、0 真实服务 / 模型调用；它不是上述 OCR 全链的替代证据。
- 自有 5301 / 浏览器 / 测试进程已退出。真实窗口、原 5173 / 5179 服务、真实简历 / FactBase / 凭据 / 未发送草稿与无关 Git 改动未操作；没有强制刷新、提交、推送或发布。当前是已有脏工作区内的 scoped 实现，不声称整仓干净。

## 下一步与完整目标

1. 后续已完成五个旧独立推理HTTP退役及单次任务归核，当前证据见[续作回执](legacy-inference-retirement-2026-11-12.md)。下一步审计职业workflow start/resume及遗留推理helper，再迁实际调用者/退役；保留认证/只读历史/配置。`generateWritingReply`默认生产分支已tasks，函数尚存在不等同实际派送。
2. 历史无 scope 显式关联、来源变化 / 中断接手、artifact 正文完整读取 UI，以及 ChatGPT 账号下实际 JD 攻防按钮 → Workspace 双端链仍待补证。
3. R4–R6：5–10 组有来源 / 再利用许可 / 人工事实标签的真实脱敏 Gold、四维 Eval Matrix、可复现周期真实模型比较仍未完成。合成机制测试不作 Gold 或模型优劣成绩；真实模型比较需明确模型 / 数据许可与费用边界。整体目标保持 active。
