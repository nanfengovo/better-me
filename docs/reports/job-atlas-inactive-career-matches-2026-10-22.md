# 企业招聘发现跳过不可用的旧来源匹配

2026-10-22，修复企业招聘发现把“名称命中已登记来源”误当作可以使用的来源。此前只要 `matchedSources` 非空，工具就返回 `matched-existing`；禁用、待核实或不可用记录会因此阻断用户这次明确提交的官网读取和宿主配置的搜索。

现在只有至少一条来源同时满足 `enabled: true` 与 `status: active` 时，才保留命中后零网络请求的早返。其他命中仍原样出现在 `matchedSources`，同时继续已有的受限fallback：显式官网／种子仍须有效的独立发现策略；name-only 搜索仍只能调用宿主配置的 provider。禁用来源保存的 `entryUrl`、homepage、secret引用和访问策略都不成为外部读取授权。

候选仍标记为未核实；来源提案保持禁用／待审。工具不会注册来源、同步岗位、改动来源配置或写入岗位。active状态也不证明该来源实际具备岗位采集能力。本切片不增加数据库迁移，不扩大网络权限，不代表全网搜索、招聘归属验证、原岗读取或办公地址精度提升。

共享工作树本机验证结果：

- `packages/source-adapters/tests/career-discovery.test.ts`: **31/31**。
- `apps/job-service/tests/application.test.ts`: **17/17**；覆盖共享应用工具对SQLite来源快照的读取，发现操作前后备份相同。
- `apps/web/tests/atlas-company-careers-panel.test.tsx`: **18/18**；禁用匹配与新候选同时展示，没有启用禁用来源的按钮。
- source-adapters 全包 **355/355**、job-service 全包 **353/353**；这些本机结果来自含并行未提交成果的共享工作树，独立提交验证见下方远端 CI。
- `@better-me/source-adapters`、`@better-me/job-service`、`@better-me/web` 类型检查通过；四个改动的TS源码／测试文件ESLint通过。
- `@better-me/web build` 通过。Vite仍报告既有的大包警告；无构建失败。

独立导出精确提交 `22a81bc`（树 `de5e23f69b4067469cf909a8e95f95c0d5d55c2e`）另做隔离验证：离线冻结安装、上述 **66/66** 定向测试、memory 检查、类型 **10/10**、lint 与构建 **6/6** 全部通过；没有使用并行未提交的 Career Agent 文件，也没有改动共享暂存区。本机未在该快照重跑全量，完整提交的全量结果以下方 CI 为准。

精确产品提交 `22a81bc38fbcb2946cb899c7f5ec669b71f968da` 已正常推送至 `main`。[GitHub Actions 39705148333](https://github.com/nanfengovo/better-me/actions/runs/39705148333) 首次运行四项任务全部成功：Windows lint／类型／测试、Linux 生产与 Pages 子路径构建、Docker 构建与 HTTP 检查、GitHub Pages 部署。Windows 实际日志为 **2827/2827**，失败、取消、跳过和 todo 均为 0，没有重跑。

本切片没有发起外部搜索 provider、岗位来源采集或私人索引写入，没有启动、停止或重启 5173／5178。默认后端另行只读核对：原 5173 的同源 `/api/atlas/status` 返回 `configured: true`、`status: ready`；浏览器已有页面显示本机索引 89 岗／revision85。该状态检查不证明运行中的 5178 已加载本次发现器改动，后端升级仍需按原数据目录、配置与备份流程安排。修改限于共享发现逻辑、对应的领域／应用／界面回归和工具说明。
