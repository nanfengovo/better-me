# JD 元数据归入统一任务内核

2026-11-12 · `agent-os` · **字段提取本阶段已完成隔离双端验证，完整 R1–R8 目标仍 active。** 本页资源段保留当时快照；当前安装资源、回退与后续门以[OCR 回执](jd-ocr-task-runtime-2026-11-12.md)为准。使用合成资料、签名虚构 OAuth 与脚本回答；0 外部/真实模型调用，不是模型质量或正式账号实跑成绩。

## 实际改动

- 新增真实 `jd_intake` task（当前 `mode: metadata`），冻结完整来源及可选来源 URL；Host 持有逐次发送、修复、暂停/恢复、owner/lease、固定底座和原根预算。创建不推理，也不创建岗位、改简历或写 FactBase。
- 共享 `jd-intake.ts` 仅提供纯提示与严格结果校验。职位、公司、薪资、地点分别为 `null` 或 `{value,start,end}`；UTF-16 坐标必须与全文 `slice(start,end)` 逐字一致。未知留空，不用本地猜测填补模型未知项；原文中的指令仍是数据。
- 删除 `jd-link-parser.parseJobWithLlm` 及其 `text.slice(0,3000)`、模型异常吞并。链接正文获取/本地规则解析不调用模型；显式“授权模型提取并填入”才调用认证 tasks。模型调用在静态/浏览器正文获取的 catch 之外，模型失败不会再打开浏览器、重试第二次模型或回退 API。
- 生产 `AgentWorkspace`/默认 client 只通过 `/api/v1/agent/tasks` 及子路径派送字段提取，沿用 Provider 的 rootScope 与当前明确模型/账号/原生底座。同一完整来源重新进入只读原任务；恢复必须核对完整来源、底座、已有输出并重新勾选许可，使用精确原 ID，不另建任务清账。
- 完整输入、部分输出与字段坐标可在任务详情滚动查看。输入上限 120000 字符、私有任务存储预算、输出解析上限均明确拒绝，不静默截取；超过 126000 字符的原始输出完整保存在私有 artifact。格式/坐标修复最多三次尝试，每次先计同根账；未完成输出只暂停，不自动续答。
- 切换来源/底座使旧观察失效；关闭只停止观察，明确停止才请求 Host 暂停。任务结果在版本/底座守卫后一次性填表，避免延迟打字动画在来源切换后继续写入。规则读取原有表单动画与其行为不扩改；旧关闭定时器也核对请求代次。

## 验证与发现

最终 **74 定向 +61 相邻 +14 Desktop =149 项通过**，三组文件不重叠，不把前序 26/73 等批次重复相加。Host 类型/构建、定向 ESLint `--max-warnings 0`、脚本语法、diff 检查及完整 `pnpm desktop:build` 通过。不是整仓全绿；既有 Atlas Node 外置/大 chunk 提示保留。

- 内核/生产 client → 实际认证 HTTP：超过 3000 字符的尾部字段、CRLF/Unicode、错误坐标与无据企业名拒绝、完整无效输出与收费修复、根预算用尽、未知 null、incomplete 暂停、超大 artifact 全文、停止/迟到结果、另一 owner/未认证/授权变化拒绝。配置 SDK 与原生 phase 各一次实际协议派送，测试没有独立免费重试。
- 浏览器实际生产按钮：规则读取 0 模型；全新账号夹具的 4265 字符来源与 242 字符部分输出保留。刷新、重新核对原任务均不增调用；手动勾选恢复原任务后总计 2 次，四个字段坐标均大于 3000。完成后刷新/再读仍 2 次，fallback=0，旧推理 HTTP POST=0。
- 最终 Electron 全链：实际安装 preload + 源码 React/Provider/default clients + 认证临时 Host。先用伴侣聊天建立根，再规则读取、显式元数据暂停、刷新核对、勾选恢复。共 2 任务、同账号/根累计 3 次，字段任务原 ID、本身用量 2 次，完整来源及尾部坐标逐字一致。未点击“授权当前简历并开始拆解”，不越权分析或采用。
- 第二独立 Electron 进程：来源和表单完整恢复，授权未勾选。明确读取已有完成任务后，完整任务 JSON hash、所有 task POST 和调用数保持不变，仍为 3 次。与下方成品离线启动是两项不同证据。
- 初轮夹具失败均保留为测试发现：空岗位漏传必填的 `job={null}`；元数据提示被旧聊天解析器提前读取；脚本在账号/实际底座尚未都就绪时点按钮。分别修正夹具的传参、分支与真实就绪等待，重新使用全新 Host/profile 验证；未更改生产空岗位 schema、放宽授权或补造岗位。配置协议测试改用支持结构化输出的合成 provider，与其他 wire 测试一致。
- 只读资源核对最初按全路径排序与深度优先排序混比，产生顺序差异；改为按路径比较大小/hash 后，533 对 533、差异 0。不是内容差异，不据误报替换资源。

原始 Electron 目录：`/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-intake-X2yTHi`。`complete-tasks.json` SHA-256 `8115723916ba825058421d383840448f9070f5b167bebe448348a3c3fb624450`，`restore-summary.json` `bef2dc5a9e3ea5a626d1e59619885e4521f2e26fb5ddb840ed955870b3f2626b`。Host 目录 `betterme-account-browser-sWhd8B`，原字段任务 `ct_b529d94fce88e600c0596858c3e298f0`；均为合成私有数据。

复现入口（Electron 每次用全新隔离 Host）：

```sh
pnpm exec tsx --test apps/agent-host/tests/jd-intake-task.test.ts apps/agent-host/tests/career-task-runtime.test.ts apps/web/tests/jd-intake-http.test.ts apps/web/tests/jd-link-parser.test.ts
pnpm exec tsx apps/web/node_modules/vite/bin/vite.js --config apps/web/tests/ui-lab/chatgpt-task-live.config.ts
node apps/desktop/tests/jd-intake-smoke.cjs '/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app/Contents/Resources/app/dist'
```

最终日志在 `/tmp/`：`betterme-jd-intake-regression-final.log`（74）、`betterme-jd-intake-neighbor-final.log`（61）、`betterme-jd-intake-desktop-tests.log`（14）、`betterme-jd-intake-electron-final.log`、`betterme-jd-intake-desktop-final-build.log`、`betterme-jd-intake-offline.log`。26 项聚焦集合是 74 的子集，不另计。

## 当前安装资源与保护

- 相邻 BetterMe.app 的 533 文件已可回退同步；最终构建后独立按路径/大小/hash 再比对 0 差异。安装清单 `54b8ec2a8762603d7228f420f907d46d7770df6651326108acc38ca791214d1c`，Web 清单 `eb82243221639e0866b821d3429bd81b39046a98afb52d72864e1a045c101e1d`。
- 紧邻前版备份：`/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-3uaKR9/previous-dist`，清单 `101d90131760daed4f950d82f959bb4995c6b29c416c08103b512b4ff8f18289`。本阶段前成长成品 `5df0ce5e…` 保留在 `.unified-agent-app-CRJjNW/previous-dist`，未覆盖。
- 最终安装 main/preload/React 离线两窗口重开通过，摘要 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-Cbi0iP/summary.json`：Electron34.2.0、4 次合成读取、0 真实服务/模型调用。GPU context 提示没有影响断言。
- 自有 5299 Host/浏览器和测试进程已关闭。真实窗口、5173/5179 原服务、简历/FactBase/凭据、未发送草稿与其他 Git 改动未操作；未提交/推送/发布。用户原窗口没有强制刷新。

## 下一步与完整目标

1. OCR 后续已完成：`JdMatchModal → recognizeJdScreenshots` 现为真实 `jd_ocr` / tasks，任务私有存储保留 6 图 / 单图 10 MiB / 总 24 MiB 原字节及完整空白；不支持图片明确停止。114 项和隔离双端证据见[OCR 回执](jd-ocr-task-runtime-2026-11-12.md)，不重复迁移。
2. 全部实际调用者迁完再关闭旧独立推理 HTTP；历史无 scope 显式关联、范围变化/中断接手、artifact 全文 UI 与账号实际攻防按钮跨 Workspace 全链仍待完成。
3. R4–R6 的 5–10 组真实脱敏、来源/许可/人工标签 Gold 集，四维矩阵及可复现周期真实模型比较仍未完成。合成机制测试不算 Gold，也不算真实模型优劣或正式账号结果。整体目标保持 active。
