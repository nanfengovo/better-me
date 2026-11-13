# 完整原始输出读取与恢复

2026-11-12，`agent-os`。完整 R1–R8 目标仍进行中；本阶段补齐原始输出正文读取，随后开始独立四轴 Eval，后者见 [评测回执](resume-quality-eval-2026-11-12.md)。当前桌面资源/回退已更新至[直接候选回执](task-direct-candidate-2026-11-12.md)；本文c22309e2…与以下安装记录保留为紧邻前版快照。

## 已实现

`TaskOutputArtifactSchema` 作为公开契约导出；序列化形状不变。`task-output-client.ts` 是唯一共享只读客户端，`TaskOutputArtifacts` 同时用于共享根账、单次任务和对练恢复视图。根账会列出当前实际成员任务的所有 artifact，其他任务类型不需要另造读取通道；尚未显式关联的无 scope 历史不冒称已自动出现。

| Before | After | Why |
| --- | --- | --- |
| 仅显示 artifact 元数据，正文不可读 | 明确点击“读取完整原文”后 GET 原任务私有文件 | 历史可核对，不重新推理 |
| 普通 text 解码可能丢掉 UTF-8 BOM | 完整 arrayBuffer，核对字节数/SHA-256，再 fatal UTF-8 解码且保留 BOM | CRLF、首尾空白、Unicode 与文件逐字节一致 |
| 各面板分别实现读取容易分叉 | 同一 owner-bound client + reader | 统一取消、错误和账号切换行为 |
| 超长内容可能被省略或当 HTML 渲染 | 安全文本 pre、完整滚动、复制及 Blob TXT 下载 | 不执行模型 HTML，不用 line-clamp/slice 裁短 |
| 重开自动读正文可能恢复不必要的共享状态 | 元数据可恢复，正文每次明确手动读；本页不缓存正文 | 恢复不授予模型许可或增加任务调用 |

客户端捕获 identity lease，校验 task/output ID 与 immutable metadata；原 owner-aware fetch 保留凭据/no-store。仅 GET `/api/v1/agent/tasks/:taskId/outputs/:outputId`，不重试、不新增执行器或持久化副本。文件短读、同长篡改、MIME/编码错误均不返回部分成功。取消或账号变化清除本页全文、丢弃迟到响应并禁用旧 reader；原私有文件和任务历史保留。现有 Host 输出 endpoint 的 owner/path/size/hash 守卫不放宽。

## 当前回归

- **67/67 Host/Web**，10 个文件：task-output-client、task-output-artifacts、agent-task-ledger、one-off-task-http、mock-interview-http、career-task-panel、agent-sidebar、free-chat-task、free-chat-task-http、career-chatgpt-http。日志 `/tmp/betterme-task-output-goal-regression.log`。
- **14/14 Desktop**：lifecycle、isolated-qa、agent-host-runtime，日志 `/tmp/betterme-task-output-goal-desktop.log`。本集合共81项，不叠加此前17项或UI19项。
- Web 类型、Host 构建、定向 ESLint 和完整 `pnpm desktop:build` 已通过，原始日志 `/tmp/betterme-task-output-{types,host-build,lint-delivery,desktop-build}.log`。后续只增加测试/隔离夹具及独立 Eval，没有再次改生产 Web。HTTP React act、Atlas Node 外置化/大 chunk 提示保留，不称整仓零警告或全绿。

## 实际 Electron 两进程

`apps/desktop/tests/task-output-smoke.cjs` 使用真实安装 preload、源码 React/默认 client、临时认证 Host 与虚构 OAuth 回答；不访问正式账号或外部模型。

- 实际伴侣单次按钮创建任务 → oversize 输出停止并保存 artifact → 明确手动读取 → root ledger 再读 → 实际 Blob 下载完整 TXT。
- 原始输出 **564,050 字节**，包括 BOM、CRLF、emoji 和末尾空格；全文 SHA-256 `39564a5b67c117e5f45e3e86598933ecc444b7eb7517b2e9d39d89365c056556`。
- task `ct_793e6bb8a77a9da56541e315d9f18fdd`；第一进程2次 body GET、第二独立进程手动1次 GET；始终1次合成模型、2个 task POST，fallback/external 为0。第二进程初始只显示元数据，没有自动读取正文/恢复许可；完整任务记录 hash 不变。
- 复制回调用页面内存接收并验证全文，**未操作系统剪贴板**，不冒称已验证原生剪贴板。实际下载文件逐字节/hash 核对。
- 最终日志 `/tmp/betterme-task-output-electron-ready.log`；目录 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-output-YWiYER`，临时 Host `betterme-account-browser-2G0VDG`。
- 完整规范任务记录 hash `59f535ca30b45b03a605964e3bde2e766faf1e3a66dbb2bce5097ed6c28507e6`；records JSON 文件 hash `7da61052a871b55b8318d6cd50573a82bbca05e160d4278b4e7b0e783a96303c`；restore-summary hash `02097e006a33c3a89c7d188dbae5814095b02165ce5982b27249cd56acd550bc`。

初次脚本的按钮 aria-label、就绪/输入 settle 观察点及异步 WebCrypto 测试等待曾修正；失败均为终态后才重新启动隔离夹具。没有放宽生产授权/身份/完整性条件，也没有因观察超时重发活动任务。

## 实际浏览器与重开

继续原存活句柄96912和 Playwright `betterme-task-output-1112`，没有重建账号或再次派送。临时 Host `betterme-account-browser-ZoiCTg`。

- task `ct_3e42cd35e5aa24fd3462b041ab94b2fc`；完整任务 JSON hash `031de17e6ee3f38c12f500e43126232e3317e8817674769b87f48724a4961e5d`。
- 展开根账前/后 body GET=0；手动读取后=1，全文等于完整合成原文，字节/hash与 Electron 相同，`pre-wrap`、`line-clamp:none`、`overflow:auto`。
- 重开同一URL后任务 ID/全文 hash/2个task POST/1次模型不变，正文不自动读取；再次明确点击后 body GET=2，原文 hash不变，模型/写入仍不增加。
- 1400×900 浅/深色以及390×740深色新图已目视：无横向溢出，窄屏3个全文操作按钮均44px，全文保留204,034个JS字符。图片 `output/playwright/task-output-reader-{light,dark,narrow}.png`，是合成材料，不是真实账号或触屏真机。
- 本轮浏览器旧favicon404不作为产品失败或零错误证明。验收后仅关闭自有浏览器及5299服务，原5173/5179与用户窗口不动。

## 当前桌面资源与回退

完整Web/Electron构建后已可恢复同步533文件；本轮再次独立按路径/大小/SHA-256核对 **预期533、安装533、差异0**。没有刷新用户窗口、重启原Host或重新替换已一致的资源。

- 安装清单：`c22309e299dbc57dc9d80b8cbf196db140dd293875cded41eab372e0aced8543`。
- Web清单：`4db7f49d45cfdb5a5ace83f4c57d95494fc2b1fab7fc9b03d3de1081ecaec8b4`。
- 紧邻前版：`cdb867ee53adb69c67b4ee4da56dab31f94a8697c4d7f37d8e670fed931db8d1`，回退 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-sLxtdG/previous-dist`。
- 同步/独立核对日志 `/tmp/betterme-task-output-{sync,manifest}.json`。
- 安装成品离线 Electron34.2.0 main/preload/React、两个窗口重开通过，3 assets/4 synthetic reads，独立profile、0实际服务/模型调用。摘要 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-DRDh03/summary.json`。GPU context 提示未阻止断言，不把登录页 smoke 当已登录业务证明。

## 未完成范围

R1/R2 仍需旧无scope任务显式关联、资料/授权变化及中断接手和其他调用路径审计。R4仅来源核查；R5/R6已有独立四轴离线实现和回归，但真实脱敏标签、从task output自动冻结候选、真实多模型可比报告及周期调度仍待完成。R8全目标成品审计尚未完成，目标保持 active。真实资料/FactBase/凭据/原窗口与并发Git改动保留；未提交、推送、换分支或调用外部模型。
