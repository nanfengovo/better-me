# 真实本机 PDF 中译英：链路通过，质量未放行（2026-11-14）

## 当前结论

这是此前[作业协议试点](learning-translation-pilot-2026-11-14.md)的真实运行续片。独立固定引擎、公开离线资源、原创 PDF、本机模型、取消及 Web/Electron/Host 重启恢复已经实际运行；**三个产生 PDF 的作业均被操作者质量审阅拒绝，零份译稿获接受**。最终公式仍把名词项翻成动词短语，不能将工程链路通过写成英文版可用。

全部使用原创三页 `apps/agent-host/tests/fixtures/learning/checkpoint-notes-v1.pdf`，SHA-256 `1bb01c208dcf6f5ca0f1111d1b66da4a100d3d60150cf4f648465abed5d348f2`。未读取真实简历、求职数据或个人事实库；没有云端/收费模型调用，没有修改聊天默认配置、正式 Host 配置或发布代码。仍为 `agent-os`、HEAD `3a31cf29a34ad717ac22ef61fc43230a88b5549c` 之上的未提交实现；旧 Windows CI 不覆盖此片。

## 独立运行时与资源

- 专用目录为相邻 `.betterme-pdf2zh-runtime`；Python **3.12.14**、PDF2zh-next **2.10.2**、BabelDOC **0.7.1**，129 个安装包的依赖检查通过。固定 hash 锁仅针对 macOS 14+ ARM64/Python 3.12；没有 Windows/Linux/Intel 运行结论。
- 实际借用既有可信工具运行时的 Python 3.12.14 作为 venv base；未覆盖机器默认 Python 3.14/PATH。venv 仍依赖该 base 位置，不是可复制的便携包。
- **182** 个公开离线文件、**352,451,566** 字节，均按固定 SHA3-256 验证：34 字体、146 CMap、1 布局模型、1 tiktoken。布局 ONNX 为 75,324,598 字节。下载中的短包、EOF 与 hash 失败保留为失败记录，没有当成可用资产。
- 新准备器 `scripts/prepare-pdf2zh-assets.py` 只读取固定资源元数据，显式下载、限制资源/并发/分段/重试、核对完整 hash；其 5 个 unittest 方法通过。转换期间不下载资源。
- Python、字体、布局权重均未打入 BetterMe 发行包；代码、字体、原始/转换权重的许可应分别核对，独立进程不提供许可豁免。安装、资源及 opt-in 复验见[操作说明](../operations/pdf2zh-local-runtime.md)。

仅使用本机已安装的 `betterme-eval-gemma4-e2b-ctx65536-20261112:latest`，digest `079c2aeeda6f9d859a9d7ed7ca09892af4eaf82bd8d9136966f7afaae0ceff0c`。另一个本机别名与它使用同一约 2B 权重，不能当成第二模型比较；cloud 别名未使用，没有下载新的 LLM 权重。

## 实际作业与质量账单

所有作业均在 5338 专用入口、合成 owner、单次明确同意及原作业预算下启动。下表计量为实际 `/api/generate` 请求，不是计划次数。

| 作业 ID | 实际模型请求 | 结果 / 转换到待审耗时 |
| --- | ---: | --- |
| `lt_555dbdc33dffc09911df86ded8c19636` | 0 | 推理前失败；7,747ms，无候选 |
| `lt_15018267315ca06d9235c599cbe27b51` | 9 | 53,982ms 产生候选；调试标记/标题/公式占位问题，拒绝 |
| `lt_8c4ceaa35c5a3cb53322c09a5a061ac0` | 9 | 生产模式 finish 消费卡住后主动取消；无候选，用量保留 |
| `lt_62475a8fb4a012d7166720e09c876041` | 9 | 69,637ms 产生候选；结构守卫已加，仍有断词与公式措辞，拒绝 |
| `lt_3bac4dbcc5a14a17763106b9670e08a4` | 9 | 冻结六术语的新作业；40,213ms 产生候选；公式名词误译，拒绝 |

累计 **36 次本机模型请求**。耗时为该样本本机记录，包含相关转换开销，不是性能承诺；取消作业的等待/人操作时间不列为翻译速度。未重复请求来伪造成功率，三份拒绝候选及取消均进入分母。

最后作业的单语候选为 3 页、45,973 字节、SHA-256 `346fb32a10c50dac26aadca1fc193e76eeef006eef604433da064ae0a78a061b`；逐页双语为 6 页、94,891 字节、SHA-256 `59809574bc76f44864ab61be536b80e115b869f60566b5e2db55e09c45e2f22f`。输入/输出累计 25,041/2,961 字节。

操作者分别检查最后 9 页实际渲染及完整提取文本；双语原文三页在 90dpi 的 PNG 与原件逐页 hash 相同。固定样本的页数、`op-17`、42 ms、32 次、否定条件、单栏阅读顺序与已知溢出通过；**公式项失败**：`Total steps = have saved steps + subsequent verification steps`。保留 `=`/`+` 并不足以证明公式含义正确。无调试标记/已知断词不等于语义通过；本片不覆盖复杂 TeX、表格、多栏或 OCR。

最终保存 `decision=reject`、六项检查和原因，两项实际查看确认均已记录；这是原创夹具的操作者 QA，不是本人学习/任职事实或外部独立质量认证。没有人工润色后回填为模型成功。

候选统一留在 `output/pdf/translation-20261114/`，均明确标为 `rejected-debug`、`rejected-wrap` 或 `rejected-formula`；原件与各版画布/文本位于 `output/translation-real/pdf-inspection/`。这些不是可用译文交付物。

## 真实取消与双端恢复

- 取消真实卡住作业的 UI 确认约 77ms；待所拥有进程退出后，本次原生临时作业目录为 0，9 次已发生用量不清零。恢复原记录不再次派送。证据 `output/translation-acceptance/real-cancelled.receipt.json`、`real-cancel-reopen.log`。
- 实际 Electron **45.2.3** 加 built preload、独立 profile，分别对加结构守卫候选、六术语待审候选、最终拒绝并已保存审阅的候选运行“全新进程→再次进程→专用 Host 重启后再开”。每个恢复区间成长执行 POST 增量为 **0**，实际模型累计分别保持 9→9、18→18、18→18；原件、产物、请求、审阅和用量一致，单次勾选为 false，朗读 speaking/pending 均 false。
- 最终 Web 刷新后，累计 18→18、adapter 2→2，成长 POST 列表不变；仍为原拒绝结果，不恢复授权或声音。`real-web-final-reopen.log` 与 `real-native-final-reviewed.log` 保留原始观察。
- `apps/desktop/tests/learning-translation-real-acceptance.cjs` 只读取已经导出的真实回执，不启动推理；最终 profile 为 `/private/tmp/betterme-learning-electron-H2ZquJ`，汇总 `output/translation-real/native-observed-summary.json`。

先后合成库完整备份在 `output/translation-real/rejected-debug-store/`、`cancelled-production-store/`、`final-synthetic-store/`。仅专用原创夹具入口记录固定 hash 的真实输入/输出以排查翻译；正常 Host 不增加正文 trace。专用浏览器和所有本次原生窗口已关闭，5338 的自有 Vite 已停止，交接复查无该端口监听；未接管正式服务、个人 profile 或 Ollama。

## 实装发现与回归

1. 实际英文资源含 CJK 回退字体，字体本身已超过旧 256MiB 假设；将显式资源上限设为 512MiB，仍核对每个文件及总量，稀疏超额回归拒绝。
2. 单改 `Path.home()` 没有隔离 `expanduser()`；真实库离线导入先红，随后私有 home 展开、配置/缓存/临时目录和拒绝越界展开实测通过。资源以 APFS/reflink 私有副本（不支持则复制）提供，测试确认修改副本不改变原件，不使用可回写的硬链接。
3. 空环境仍触发 macOS 系统代理发现，真实桥接被连接守卫拒绝、模型 0；仅子进程 `NO_PROXY=*` 后抵达指定代理。没有修改机器代理，Python socket 约束不被称为 OS 沙箱。
4. 固定 SDK 的子进程/事件路径会丢私有约束或 finish 后持续等待。改为单个受管私有子进程直接构造固定 BabelDOC 配置，`debug=False`、收到 finish 即结束；5 秒事件消费者先红再绿，真实取消清理另验。该桥接绑定内部 API；[固定版上游说明](https://github.com/funstory-ai/BabelDOC/blob/v0.7.1/README.md#python-api)不承诺直接使用 BabelDOC API 的支持，升级必须重新核验，不能把这个实验 adapter 宣称为通用稳定集成。
5. 从实际错误抽出明文 completion 组装与 JSON 段落校验：固定编号/数量/字段、非空输出、`{vN}` 顺序和次数必须一致；JSON 字符串不再双重转义。实际缺标记模式先红后绿；结构守卫不认证自然语言语义。

红→绿日志位于 `output/translation-acceptance/real-asset-limit-red.log`、`real-private-runtime-red.log`、`real-private-copy-red.log`、`real-system-proxy-red.log`、`real-bridge-green.log`、`real-finish-event-red.log`、`real-placeholder-red.log`、`real-placeholder-green.log` 等。最后 `real-quality-final-not-released.log` 是**有意失败的固定样本质量门**，没有改名为绿灯；`scripts/check-learning-translation-fixture.mjs` 只是该原创样本的机械哨兵，不是通用语义判分器。

## 最终工程验证与安装资源

最终完整 `pnpm test` 实际退出 0：普通 **4,925 项，4,905 通过、0 失败/取消、20 原有条件跳过**，随后独立 **62/62**。不是拼接定向结果；原始文件 `output/translation-acceptance/real-full-test-guarded-final.log`。结构守卫/原生转换/翻译/HTTP 定向 **13/13**；类型 **16/16**、双端构建 **9/9**、桌面普通 **22/22**、lint 零 warning。真实运行时最后离线探针报告固定版本、privateConfig/privateTemp/offline 为 true、modelRequests=0；资源准备器 **5/5**。这些工程绿灯不覆盖已拒绝的译文质量。

最新同步 `output/translation-acceptance/real-desktop-sync-guarded.json`：相邻 App **616** 资源，清单 SHA-256 `b58b3dfbc05cd58d64c3b900f97bba56c2da09da3603a735d4dbce010c56df17`，Web hash `aa84449af2624ec4b4eb7c31bad6d5ffc0991743973652b1ff58e42b80ac5c3a`；最新完整回退目录为相邻 `.unified-agent-app-AQ2xen/previous-dist`，前序备份保留。

同一资源清单的 actual installed main/preload/React 已跑隔离离线两窗口；真实服务/模型请求 0。证据 `real-installed-smoke.log` 及 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-vhtORY/summary.json`。其中“服务已运行”是合成健康响应，不表示启动正式 5179。

并行壁纸、设置、Autopilot、地图和版式工作保留；打包包含当前工作区组合，不等于本片拥有或发布它们。个人三份 SSOT 与 Gold 无 diff，未提交/推送/创建 Release，未恢复 R1–R8。

## 停点与后续选择

- **已完成**：固定真实引擎/资源准备、原创 PDF 本机转换、真实失败/取消计量、Web 与原生重启不重派、结构回归和完整工程门。
- **未放行**：最终英文公式措辞与通用中译英质量；正式入口尚未配置该可选运行时；Windows 原生隔离/清理、OXR 实装、DeepTutor 服务、STT、实际隔周保持亦不能算通过。
- 用户最新要求转为依据附件扩展方向；当前只分析。强模型能否改善应在同源固定样本上验证，附件的允许外发表述不替代对账号、接收方、资料和预算的明确授权。没有自动切云端、再跑一轮推理或扩大开发范围。
