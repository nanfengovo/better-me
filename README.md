<p align="center">
  <img src="apps/web/public/brand/betterme-icon.png" alt="BetterMe 资产之核图标" width="112" />
</p>

# BetterMe 个人职业工作台与 Agent

**让真实经历成为可积累的职业资产，让 Agent 帮你把目标推进到有依据的结果。**

BetterMe（迈向更好）是一个本地优先的 Personal Career OS。Career Workspace 管理事实、证据、简历、岗位与版本；Personal Career Agent 围绕你的目标理解项目、分析差距、提出修改并执行经过授权的任务。模型的建议不是事实，工具执行成功也不等于业务已经完成：重要变更需要核对、确认和可追溯的结果。

Local-first career workspace and personal agent. Ground experience in evidence, tailor applications, and retain control over your data and decisions.

[![agent-os CI](https://github.com/nanfengovo/better-me/actions/workflows/ci-pages.yml/badge.svg?branch=agent-os)](https://github.com/nanfengovo/better-me/actions/workflows/ci-pages.yml)
[![Release](https://img.shields.io/github/v/release/nanfengovo/better-me)](https://github.com/nanfengovo/better-me/releases)

[下载安装包](https://github.com/nanfengovo/better-me/releases) · [网页预览](https://nanfengovo.github.io/better-me/) · [源码运行](#源码开发) · [产品边界](CONTEXT.md) · [路线图](docs/ROADMAP.md)

## 你可以用它做什么

- **整理真实经历**：导入 PDF、DOCX、图片或文本，核对提取结果；将事实与展示方式分开，避免把模型补充当成个人经历。
- **与 Agent 一起理解项目**：先对齐业务背景、个人职责、技术选择和证据，再生成候选表达；查看差异后决定是否采用。
- **面向目标岗位修改简历**：拆解 JD 原句，逐项关联已有证据，区分已展示的能力、表达不足和需要进一步确认的差距。
- **维护多份简历与历史**：复用职业资料，管理不同目标的简历视图、命名检查点与版本恢复；导出 PDF、DOCX、Markdown、JSON 和 RenderCV YAML。
- **管理求职机会**：关联岗位来源、投递材料、联系人、跟进状态与地图。地点精度取决于来源证据，不把城市中心当成真实办公地址。
- **按需连接模型和工具**：使用自行配置的云模型或本机 Ollama；原生 CLI、招聘浏览器与实验性渲染能力按当前平台、授权和实际探测结果开放。

> 岗位链接可能需要登录或人工验证；读不到正文时可粘贴原文。匹配结果不是录用概率，简历表达优化也不会自动提高真实能力。

## agent-os 功能明细（2026-11-13）

以下描述当前源码工作区。既有 Release 附件不会因分支推送自动更新；实验能力、合成测试和实际模型效果分别记录。

本轮功能分组提交、远端整合取舍、验证结果与本机资源回退记录见 [2026-11-13 工作区发布回执](docs/reports/agent-os-workspace-publish-2026-11-13.md)。

### 1. 统一 Agent 任务与可追溯执行

- **统一任务内核**：顾问与伴侣聊天、经历润色、项目理解、JD 匹配、岗位元数据提取、截图 OCR、职业指导、模拟面试，以及 Studio 分析和委员会审阅通过任务协议执行。
- **同根预算**：父子任务继承固定运行时与根额度，模型、工具、修复与证据读取分别计量；暂停、重开和恢复不会清零原账。
- **显式授权与恢复**：校验账号、来源快照和运行时代次。读取历史不自动执行；未知创建结果先核对，恢复需要本人明确操作，账号变化拒绝迟到采用。
- **完整输出**：保存原始输入、回复、修复与失败记录；超长输出可按完整 artifact 读取、复制和下载，并核对字节数与 SHA-256。容量超限明确失败，不把截短文本当完整成功。
- **旧入口兼容**：旧的独立推理、职业 workflow 和委员会生成 HTTP 返回 410；配置、模型目录、登录及已有历史仍保留。兼容历史不是重新执行许可。

实现与验收：[统一内核](docs/reports/unified-agent-kernel-2026-11-10.md)、[全入口迁移与剩余清单](docs/reports/unified-agent-expansion-2026-11-11.md)、[旧推理退役](docs/reports/legacy-inference-retirement-2026-11-12.md)、[输出全文读取](docs/reports/task-output-artifact-reader-2026-11-12.md)。

### 2. 有依据的写作、岗位对齐与面试

- **共享写作方法**：项目背景、个人动作、可证结果分别表达；缺少指标先澄清，不把团队规模、项目目的或工具能力改写成个人业绩。
- **来源绑定候选**：候选引用对应来源 ID、全文 hash 与精确位置；检查跨组借用、任职遗漏、日期和明显来源冲突。候选仍需本人逐条核对，规则不保证识别所有语义错引。
- **JD 原句拆解**：区分职责、硬性资格、优先条件和约束，展示原句与已有证据；岗位定制采用独立简历视图，不直接覆盖原版事实。
- **岗位链接与截图**：规则提取不调用模型；模型辅助元数据与 OCR 走授权任务。截图保留原图字节与来源，识别结果先供核对，再决定采用。
- **多轮模拟面试**：由 JD 攻防入口进入独立子任务，保留材料、逐轮作答、追问、手动结束与完整回执下载；普通顾问草稿不被替换。
- **职业成长指导**：规划、练习及反馈沿用统一任务与证据协议；练习观察、模型建议和已确认事实分开保存。

参见 [写作方法](docs/reports/resume-writing-method-2026-11-10.md)、[JD 匹配](docs/reports/jd-match-kernel-2026-11-12.md)、[JD 元数据](docs/reports/jd-intake-task-runtime-2026-11-12.md)、[截图 OCR](docs/reports/jd-ocr-task-runtime-2026-11-12.md)、[模拟面试](docs/reports/mock-interview-kernel-2026-11-12.md)。

### 3. Career Studio 与证据资产（含实验能力）

- **证据收件箱与岗位观察**：保存来源、观察和待核对项；Git 证据采集受授权范围约束，公开岗位与已核验观察分开管理。
- **多角色委员会**：围绕证据完成角色审阅、交叉检查和裁决；生产调用与实际证据复用计入原任务根账，旧 SQLite 历史仅作只读兼容。
- **架构白板与技能星图**：提供结构化架构模型、故障分析与技能关系视图；推断不自动变成个人履历事实。
- **布局编译与成品诊断**：将来源、布局约束、诊断和最终产物关联，检查实际分页与成品，不通过裁页或缩小文字伪装一页简历。
- **回放与反馈**：保留决策、反事实分析和结果反馈；没有真实结果时维持未知。
- **隐私、发布与 MCP**：区分本机私有材料与允许披露的摘要；候选分身、架构图及徽章发布需要审阅与来源校验，MCP 访问单独授权。

参见 [运行配置与边界](docs/reports/career-os-runtime-configuration-2026-11-09.md)、[委员会阶段闭环](docs/reports/committee-retirement-2026-11-12.md)、[布局编译器](apps/web/src/lib/layout-compiler/README.md)、[架构实验台](apps/web/src/lib/architecture-lab/README.md)、[技能星图](apps/web/src/lib/skill-constellation/README.md)。

### 4. 受审沙箱工具成长（实验能力）

- 将内置预设编译与模型写代码分开；使用冻结用例、固定模型指纹与独立 QuickJS 验证候选。
- 支持针对失败项修复、全用例回归、最佳候选与持久检查点；账号 lease、预算、取消和进程重启后的接手均有边界。
- 生成成功只代表待审候选；安装精确版本与新任务使用仍需分别授权。QuickJS 是受限 JSON 工具环境，不是任意 npm、React 应用或通用系统命令沙箱。

使用说明：[Coding Sandbox](docs/sandbox-coding-lab.md)。该路径的循环尚未全部迁入统一内核，不把脚本化模型验收当成真实模型编程成绩。

### 5. 草稿恢复与桌面交互

- 顾问、伴侣、岗位抽屉、成长模式和外部协作草稿按账号与工作区隔离；导航、刷新与重开后可恢复已落盘内容，不自动恢复许可或重发请求。
- 存储失败、坏记录与跨窗口冲突保留原记录并提示备份；不会认领无主历史，也不能找回从未保存的旧内容。
- 公共菜单栏可显式开启自动隐藏，以顶边或 F10 唤出；窄屏与触屏常显，保留业务组件与草稿挂载。
- 工作区右侧/底部贴边、侧栏分隔、完整任务详情与浅深色主题同步调整；macOS 关窗与重新打开不重复注册 IPC 或重启已有任务。
- 发行包使用内置持久化后台；本机旧版源码关联 App 保留开发壳路径。隔离 QA 使用全新 profile，不连接真实账号和生产端口。

参见 [桌面菜单栏](docs/reports/desktop-menubar-autohide-2026-11-10.md)、[工作区边界](docs/reports/desktop-workspace-edges-2026-11-11.md)、[Agent 面板](docs/reports/agent-panel-polish-2026-11-11.md)。

### 6. 可复现的简历质量评测

- 独立评估 JD/证据对齐、事实与来源风险、STAR 编辑信号和实际 A4 排版；结构通过或来源内支持不等于简历优秀。
- 从真实任务完整记录冻结只读候选，包含失败、修复、超量与无输出的原计划分母；可重建归档、源审和报告，不覆盖旧成绩。
- 五组公开来源脱敏配对保留原版本、映射和许可说明；原始个人联系方式与私有快照不进仓库。它们是构造的评测组合，不是原作者真实申请记录。
- 批次比较核对协议、预算、材料及实际模型权重；同权重不同别名不算第二模型，条件不同时不排名。有限离线重算不是常驻调度或新增模型推理。

运行入口：`pnpm test:resume-quality`、`pnpm evals:resume-quality`、`pnpm evals:career`。详细参数见 [评测说明](evals/resume-quality/README.md) 与 [数据集许可](evals/resume-quality/gold/v1/NOTICES.md)。采样脚本会执行模型请求，应先核对授权、端点及预算，不是默认测试步骤。

### 尚未完成的验收

回放、采集器、隐私模型步骤和 Coding Sandbox 等剩余循环迁移；新任务类型的检索与精确位置逐类验收；更广的多根/授权版本接手；真正不同模型的同条件比较，以及整体审计仍待完成。现有源审也发现项目遗漏、通用职责照搬及部分错引风险，不能宣称写作质量已整体过关。Personal Growth OS 系统设计属于提案，不是本次已交付产品。

完整范围以 [R1–R8 清单](docs/reports/unified-agent-expansion-2026-11-11.md) 为准，阶段完成与整体完成分别记录。

## 桌面安装

从 [GitHub Releases](https://github.com/nanfengovo/better-me/releases) 下载对应系统和架构的附件。**附件上传完成才代表该平台已经发行**；源码 ZIP 和 CI 通过标志不等于安装包。

| 平台 | 发行格式 | 架构 |
| --- | --- | --- |
| macOS | `.dmg`、`.zip` | Apple Silicon arm64、Intel x64 分开提供 |
| Windows | `.exe` 安装程序 | x64 |
| Linux | `.AppImage` | glibc x64，要求 glibc ≥ 2.34；CI 使用 Ubuntu 22.04 |

桌面包包含 Electron 运行时、应用页面及本地后台依赖，不需要另行安装 Node、pnpm 或 Docker。云模型、Ollama、招聘浏览器、CLI 和 vork 等外部能力不随安装包自动配置或授权。

### 安装与首次使用

1. 下载与你的系统匹配的文件，并与同一 Release 的 `SHA256SUMS-*` 文件核对 SHA-256。
2. macOS 将应用拖到“应用程序”；Windows 运行安装程序；Linux 给 AppImage 添加执行权限后启动。
3. 在应用内创建或登录本机账号，导入资料并核对原文，再配置需要的模型。

当前桌面发行使用 macOS ad-hoc 签名；**没有 Apple Developer ID 公证或 Windows Authenticode 发布者证书**。系统可能显示未知开发者提示。请只从本仓库官方 Release 下载，按系统提供的人工确认流程操作，不要全局关闭安全保护。哈希用于核对文件完整性，不代替发布者签名。

### 数据位置与更新

- 应用使用系统分配的 BetterMe 用户数据目录；桌面会话与后台资料分开存放。
- 工作台通过稳定的本机地址 `http://127.0.0.1:32741` 提供页面；后台服务只绑定 loopback。端口被占用时会停止启动，不接管其他进程或静默切换资料库。
- 卸载程序不主动删除职业资料。更新前建议先导出 JSON 备份；不要手动删除用户数据目录来解决启动问题。
- 浏览器版、旧开发版和桌面版不自动认领彼此的草稿或账号。需要迁移时，先从原环境导出，再在目标环境明确导入。
- 目前不包含自动更新器；下载新版本后正常更新应用即可，保留原用户数据目录。

## 三种运行方式

| 方式 | 适用场景 | 能力边界 |
| --- | --- | --- |
| 桌面客户端 | 日常本地使用 | 页面与后台一起启动；外部能力另行配置 |
| Docker 完整版 | 自托管或浏览器使用 | Web、Agent Host、岗位 SQLite；容器不接管宿主机浏览器登录态 |
| GitHub Pages | 快速预览界面与编辑器 | 静态站点，不自带本机后台或招聘浏览器 |

### Docker 本机运行

```sh
git clone --branch agent-os https://github.com/nanfengovo/better-me.git
cd better-me
docker compose up -d --build --wait
```

打开 `http://127.0.0.1:8080/`。`docker compose down` 停止服务并保留命名卷；不要使用删除卷的选项作为普通更新步骤。详见 [Docker 部署](docs/deployment.md)。

### 源码开发

需要 Node.js `^24.15.0 || >=26` 和 pnpm `11.9.0`。

```sh
git clone --branch agent-os https://github.com/nanfengovo/better-me.git
cd better-me
pnpm install --frozen-lockfile
pnpm dev
```

开发入口为 `http://127.0.0.1:5173/`，Agent Host 和岗位服务由开发入口管理。不要用正式桌面包的数据目录运行开发测试。

```sh
pnpm desktop          # Electron 开发窗口
pnpm desktop:build    # 编译页面、主进程、预加载脚本与后台入口
pnpm desktop:dist     # 在当前系统和当前架构上制作安装包
pnpm desktop:smoke    # 用全新临时资料目录验收已打包的客户端
```

在目标系统原生构建：macOS arm64、macOS x64、Windows x64 和 Linux x64 分别由 CI runner 制作并验证，避免混入其他架构的原生依赖。产物位于 `release/<platform>-<arch>/`。

## 可信协作流程

1. **确认目标与范围**：选定岗位、项目和允许使用的资料。
2. **理解与核对**：保留来源，澄清个人贡献、工程细节及未知信息。
3. **产生候选**：生成建议、差异与理由，不静默改写职业事实。
4. **人工决定**：核对后逐项采用，重要修改保留业务版本与回执。
5. **持续积累**：将真实反馈带回工作台；模型推断与已确认事实继续分开。

职业资产归 Workspace 管理。Agent 是受控执行者，不是第二套个人事实库，也不承诺自动获得 Offer、零幻觉或未经授权的自动投递。

## 数据与隐私

“本地优先”指主要职业资料保存在本机，**不等于所有操作都离线、不等于启用云模型后资料不出本机**。

| 操作 | 资料去向 |
| --- | --- |
| 本地编辑、规则检查、版本与导出 | 当前浏览器或桌面应用的数据目录 |
| 云模型分析、AI OCR、生成建议 | 授权内容及请求参数发送到你选择的模型服务商 |
| 本机 Ollama | 发送到配置的本地模型端点；其他外部工具仍有自己的边界 |
| 招聘来源、地图与在线字体 | 可能请求相应第三方服务，受网络、来源和许可约束 |
| 原生 CLI 与外部工具 | 需要独立安装、明确授权和通过对应平台的隔离检查 |

不要提交 `.env`、API Key、账号凭据、真实简历、SQLite 数据库或个人导出文件。构建与 CI 使用隔离目录和合成资料，不导入开发者的真实账号与求职记录。

## 架构

```text
apps/web          职业工作台、简历编辑预览、岗位地图与同源网关
apps/desktop      Electron 外壳、打包、私有本机后台与发行验收
apps/agent-host   Agent 路由、资料授权、执行记录与能力服务
apps/job-service  岗位来源、索引与 SQLite 持久化
packages/core     事实规则、简历投影、JD 拆解与业务逻辑
packages/storage  文档、历史、恢复与存储适配
packages/*        岗位领域、来源适配及跨进程契约
evals/            简历质量、来源审阅与职业分析的隔离评测
```

新图标采用“资产之核”：中心代表用户持有的职业资产，外围结构提供支撑与连接，金色接点代表经过核对后接受的成果。三个非字母化探索方向保存在 [品牌概念目录](docs/branding/concepts/)。

## 质量与发行

```sh
pnpm memory:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:runtime
pnpm test:desktop
pnpm desktop:build
```

CI 分别检查 Windows 质量门禁、Linux 生产构建与 Docker，以及四组原生桌面包。SQLite 使用稳定 Node-API 依赖，另测检查点与待完成写入跨连接恢复、事务回滚；正式桌面启动不接受内存回退。桌面烟测启动真实打包客户端，检查界面挂载、后台健康和退出清理；不把它当作所有输入格式、招聘站、模型或设备都已验收。

版本标签必须与 `package.json` 一致。只有质量、Docker、生产构建和全部桌面包门禁通过，才上传版本 Release；发布前再次核对平台附件集合及 SHA-256。参见 [发行流程](.github/workflows/ci-pages.yml) 和 [v1.1.0 说明](docs/releases/v1.1.0.md)。

## 当前边界

- 复杂扫描件、多栏原稿和 DOCX 的跨环境版式仍需逐份核对；模板重排不等于原稿保真编辑。
- 地图真实办公坐标覆盖、招聘来源稳定性和通勤信息受来源条件限制。
- vork/Metal 为可选实验能力，不是 Windows、Linux 或所有 Mac 都默认可用的功能。
- 原生工具的可用性取决于平台隔离、版本和授权，不因“已安装”就自动开放。
- [路线图](docs/ROADMAP.md) 与设计文档中的研究项不等于当前发行能力。

## 文档与许可

- [领域语言与产品定位](CONTEXT.md)
- [开发路线图](docs/ROADMAP.md)
- [模板与授权目录](templates/CATALOG.md)
- [部署说明](docs/deployment.md)
- [账号与身份部署](docs/deployment-auth.md)
- [版本发布记录](https://github.com/nanfengovo/better-me/releases)

第三方代码、模板、地图数据和图标资源遵循各自的 LICENSE / NOTICE，安装包保留相应授权资料。仓库目前未声明项目整体的统一开源许可证；公开可读不代表所有资源采用相同授权。欢迎通过 Issue 或 Pull Request 讨论问题和改进。
