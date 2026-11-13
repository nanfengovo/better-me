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
