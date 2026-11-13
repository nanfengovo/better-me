# 真实脱敏 Gold Benchmark 来源核查

2026-11-12（Asia/Shanghai）。本次仅核查第一方来源、许可与固定原文字节，没有运行任何模型评测，没有操作真实用户简历、FactBase、账号或服务。

后续状态：五组 v1 已实际脱敏入库、复现与来源坐标核验，见 [入库回执](../reports/gold-benchmark-ingestion-2026-11-12.md)。本文“尚未生成”保留为来源研究当时快照。后端原文包含历史 freelance Rails，独立标签改为部分支持，不将其说成完全不存在；共同 Backend JD 不混入各 specialty 的 Go 要求。

## 结论与交接

已找到 **5 个不同作者的真实自述履历底座 + 5 份 GitLab 官方技术岗位定义**，可以组成五组来源可追溯的评测候选：云原生/SRE、高并发后端、前端、全栈、数据工程。另保留一个前端工程领导履历扩展候选。本报告完成的是来源核查；**还没有完成脱敏映射、逐项人工事实标签、Gold 数据入库、真实模型比较或 A4 质检**，不能据此勾选完整 R4/R5/R6。

完整原始下载快照保存在临时目录：`/tmp/betterme-gold-sources-WAeQAE`。`C01`–`C05` 是五份履历全文，附各作者许可/README；`J01`–`J05` 是五份岗位全文。原文含公开个人信息，**仅留临时取证目录，不直接复制入仓库或 Prompt**。本次写入仓库的只有本报告。临时目录不是长期发布存储；后续必须按下列固定 URL 和 SHA-256 校验后生成去标识化派生集。

这里的“真实”指作者在其本人仓库发布的自述经历、公司正式发布的岗位定义，**不是独立核验的任职/业绩证明，也不是原作者实际申请过 GitLab 的配对记录**。五组是为评测构造的“真实来源材料配对”，并非真实招聘结果样本。GitLab 定义是岗位族文档，不代表 2026-11-12 仍有相应开放职位。来源集中于一家公司的 JD，尚有雇主/语言/地区偏差；不能把这批成绩外推为 C# 工业软件招聘效果。

## 五组候选与匹配边界

| 候选 | 履历底座 / 官方 JD | 可测重点 | 必须保留的差距或限制 |
| --- | --- | --- | --- |
| C01/J01 | System/DevOps/SRE 自述 → Site Reliability Engineer | Kubernetes、多云、Terraform/Pulumi、CI/CD、监控与值班 | 原文角色不是“云原生架构师”；不得擅升职级。工具清单不自动证明每项生产经验。 |
| C02/J02 | Senior fullstack 自述 → Backend Engineering Roles | Django/React 多租户、高容量数据库、API、历史系统迁移 | 原文的 600 requests/second、3 million users 等是作者自述，不是本项目实测；历史 freelance Rails 只部分支持 significant professional depth，不标成完全没有；共同职责不混入 Go specialty。 |
| C03/J03 | Android/React Native + Web 项目自述 → Frontend Engineer Roles | React、响应式 Web、Node 后端、移动端性能优化 | 主职是 Android，不伪装成纯 Web 前端；移动端改进不能直接当成 Web 性能结果。日期字段存在表达不一致，保留原文并标待核对。 |
| C04/J04 | Web Developer & Designer 自述 → Fullstack Engineers | PHP/MySQL、API、响应式页面、CMS、前后端协作 | 项目中有明确写作 fictional company 的练习，不能当成真实商业交付；没有证据的 React/Ruby 等要求列为缺口。 |
| C05/J05 | 物理博士/系统与数据工程实习自述 → Data Engineer（Junior/Intermediate） | Python、数据处理、Airflow、Linux/BSD、开源贡献、转岗表达 | 学术/HPC、个人 VPS 和实习不升级为多年企业数据平台生产经历；中级年限与仓库技术缺口保留。 |

上述履历身份和内容来自作者原始材料：[C01 原始 JSON](https://github.com/blackdesert575/resume/blob/4be6afd7de2ddbac415da8cc2740ca9a846b96d8/content/resume.en.json)、[C02 原始 TOML](https://github.com/olivierphi/my-resume/blob/cd9838fd39603bdc898e5909c099c5f8db0438a8/myresume/data/en/job_experience.toml)、[C03 原始 JSON](https://github.com/underwindfall/resume/blob/2ec3f3e631aab7aa31bf1482f1e1b811b7807a2d/public/data.json)、[C04 原始 HTML](https://github.com/full-stack-web-developer-and-designer/resume/blob/c2fb37a30a56d69ef97c387ed4148e05ac90db68/resume.html)、[C05 原始 LaTeX](https://github.com/liweitianux/resume/blob/b3ccb2ec858f052903ef735300b67f701be266a7/resume-en.tex)。这些是事实标签的自述来源，不是 BetterMe 对其真实性的背书。

## 履历固定版本与许可

以下所有文件均于本次取证返回 HTTP 200，SHA-256 对完整下载字节计算，没有先截取或清洗。

| ID / 作者归属（仅放 attribution） | 固定 commit / 原文路径 | 原文字节 / SHA-256 | 再利用许可与原始声明 |
| --- | --- | --- | --- |
| C01 / Joe (Yung-Hung) Huang；LICENSE 署名 Desert | `4be6afd7de2ddbac415da8cc2740ca9a846b96d8` · `content/resume.en.json` | 8,642 · `3e4bb1ae378d97df80d96b5fdb47d476fba8477fbe98e966124e9724f49be941` | [MIT LICENSE](https://github.com/blackdesert575/resume/blob/4be6afd7de2ddbac415da8cc2740ca9a846b96d8/LICENSE)；[README](https://github.com/blackdesert575/resume/blob/4be6afd7de2ddbac415da8cc2740ca9a846b96d8/README.md) 明确是作者本人求职简历，不是仅供占位的 John Doe 示例。保留原版权署名，不把 GitHub handle 与法定身份当成独立核验。 |
| C02 / Olivier Philippon | `cd9838fd39603bdc898e5909c099c5f8db0438a8` · `myresume/data/en/job_experience.toml` | 5,804 · `ec29601dc23e4042174cde366d85d79ebeef2f401a592c5489c4003502588ba1` | [MIT LICENSE](https://github.com/olivierphi/my-resume/blob/cd9838fd39603bdc898e5909c099c5f8db0438a8/LICENSE)；[README 许可段](https://github.com/olivierphi/my-resume/blob/cd9838fd39603bdc898e5909c099c5f8db0438a8/README.md#license) 明确排除 `myresume/staticfiles/img` 图片；本次只用本人 TOML 履历文字，不取图片。 |
| C03 / Qifan Yang | `2ec3f3e631aab7aa31bf1482f1e1b811b7807a2d` · `public/data.json` | 10,989 · `daa62be7bb26cb0af055d9a2503055f2312e0e86a01fecc9ef163ae7ddec8c98` | [MIT LICENSE](https://github.com/underwindfall/resume/blob/2ec3f3e631aab7aa31bf1482f1e1b811b7807a2d/LICENSE)；[README](https://github.com/underwindfall/resume/blob/2ec3f3e631aab7aa31bf1482f1e1b811b7807a2d/README.md) 将项目标为本人 React 简历。原文包含真实工作/项目自述，不把网站框架技术当成每份工作的技术。 |
| C04 / Mirnes Glamočić | `c2fb37a30a56d69ef97c387ed4148e05ac90db68` · `resume.html` | 13,080 · `a83f7667a8d5ef510999cc01de17fb1684928820cbe31996a9e1f4df9cfad00d` | [MIT LICENSE](https://github.com/full-stack-web-developer-and-designer/resume/blob/c2fb37a30a56d69ef97c387ed4148e05ac90db68/LICENSE)；[README](https://github.com/full-stack-web-developer-and-designer/resume/blob/c2fb37a30a56d69ef97c387ed4148e05ac90db68/README.md) 明确呈现本人履历且许可复用。只提取文字，不复制截图、第三方商标/项目图片。 |
| C05 / Weitian LI | `b3ccb2ec858f052903ef735300b67f701be266a7` · `resume-en.tex` | 8,718 · `c69f14296702cf3fecb74e8bd673985e503dcd7a08ae263650c866a2ae761847` | 内容文件首部直接标注 **CC BY 4.0**；[README 许可段](https://github.com/liweitianux/resume/blob/b3ccb2ec858f052903ef735300b67f701be266a7/README.md#license) 将内容 CC BY 4.0、LaTeX class LPPL 1.3c 和脚本 MIT 分开。派生数据使用内容许可，不把模板许可误套到履历文字。 |

许可/作者说明快照校验：

| 临时文件 | SHA-256 |
| --- | --- |
| `C01-LICENSE.txt` | `3caf4d4d9d2053eebff5b867264318d064df12dc1565ea41f1b70bec52a09031` |
| `C01-README.md` | `519c5042538292e2f7272b65f1a9e612db0240e61285d958a036546975113497` |
| `C02-LICENSE.txt` | `32382a01603dccde8409f4f848565b0f9646946d26a7f33086b1730d86e7d17e` |
| `C02-README.md` | `45b97360f283b110e10234b7b00f0693ab5ab9f3fe9a9d5cc86e576b6e214eb8` |
| `C03-LICENSE.txt` | `f0dd210e34e0a8e7ce8dff1ad5f491c8387bc0fd67282de9fd135975e7f46444` |
| `C03-README.md` | `484d0c3092beece99bd283781ba6ff7133b58777253e7f8ec6276c86e002bafb` |
| `C04-LICENSE.txt` | `ebd461dbb79af51433910a397551af828cfef2b4fecac0290c1086b661881645` |
| `C04-README.md` | `ae7a3fad76453e9ad1e8797c03f4683893bb8aa775b84f5c88796ef8c23c36cf` |
| `C05-README.md` | `4560a07392ccf8fdfe4c9339793ce888a70e457880d6eb5c942ddaa1961fd87e` |

### C06 扩展候选：前端工程领导

[Brittany Chiang v4](https://github.com/bchiang7/v4/tree/539cef0bf60cad438499a69d76dba2c27cc16c9a) 是作者本人网站，不是 starter theme。[MIT LICENSE](https://github.com/bchiang7/v4/blob/539cef0bf60cad438499a69d76dba2c27cc16c9a/LICENSE) 署名 Brittany Chiang；[README](https://github.com/bchiang7/v4/blob/539cef0bf60cad438499a69d76dba2c27cc16c9a/README.md) 明确要求给作者信用及链接，不能冒认其成果。可以在独立 attribution 保留作者和网站后用于去标识化文本评测；不复刻个人视觉身份或声称这些项目是用户经历。

已核对并下载 `content/jobs/Upstatement/index.md`（802 字节，`d504eb577f263294dbe1d5985812fb431a13a8783a60e667a3ea2d1fc01f5b8e`）；LICENSE hash `dd17eff70e915b0ea07aff2b525349eaf20370713063d1c4b101878fcd7a0909`，README hash `8146455ab4aa191181de92eab1466d46e1f21d45f5be85d7b8ba12acebc898f2`。**当前只下载一个工作条目，不把它算成第六份完整履历底座**；若采用 C06，先补齐同 commit 的五份 `content/jobs/*/index.md` 及必要自述技术材料，再独立标注。

## 官方 JD 固定版本

全部固定在 `gitlab-com/content-sites/handbook` commit **`f7efde2339c3ff060bb972805bf22692c534893d`**（提交时间 2026-11-11T15:29:26-05:00）。以下为完整原始 Markdown，而不是搜索摘要。生产网站页面仅作人读入口，构建评测集应从固定 blob/raw 获取、复验 hash。

| ID | 第一方原文路径与在线岗位说明 | 字节 / SHA-256 |
| --- | --- | --- |
| J01 | [`content/job-description-library/engineering/infrastructure/site-reliability-engineer.md`](https://gitlab.com/gitlab-com/content-sites/handbook/-/blob/f7efde2339c3ff060bb972805bf22692c534893d/content/job-description-library/engineering/infrastructure/site-reliability-engineer.md) · [官方 SRE 页面](https://handbook.gitlab.com/job-description-library/engineering/infrastructure/site-reliability-engineer/) | 28,029 · `e0c076c2b54ea164aa8bd3fa58e701622b8ae4f511d7c6c75dbac8a7bff9b1ba` |
| J02 | [`content/job-description-library/engineering/development/backend/_index.md`](https://gitlab.com/gitlab-com/content-sites/handbook/-/blob/f7efde2339c3ff060bb972805bf22692c534893d/content/job-description-library/engineering/development/backend/_index.md) · [官方 Backend 页面](https://handbook.gitlab.com/job-description-library/engineering/development/backend/) | 38,593 · `aee78b7831335acc168966521f02a4b3ec7b994a27b617f8b95f311f9b393ed3` |
| J03 | [`content/job-description-library/engineering/development/frontend/_index.md`](https://gitlab.com/gitlab-com/content-sites/handbook/-/blob/f7efde2339c3ff060bb972805bf22692c534893d/content/job-description-library/engineering/development/frontend/_index.md) · [官方 Frontend 页面](https://handbook.gitlab.com/job-description-library/engineering/development/frontend/) | 16,792 · `fd0f53ac2e38e995a8d0d028b22c6197d08eb72a789959a469cb31387c491b3c` |
| J04 | [`content/job-description-library/engineering/development/fullstack/_index.md`](https://gitlab.com/gitlab-com/content-sites/handbook/-/blob/f7efde2339c3ff060bb972805bf22692c534893d/content/job-description-library/engineering/development/fullstack/_index.md) · [官方 Fullstack 页面](https://handbook.gitlab.com/job-description-library/engineering/development/fullstack/) | 8,751 · `2de27a56827b22b521ae1b89804bdfcd8d60c5d594dca4637084ae9cbedb89b7` |
| J05 | [`content/job-description-library/marketing/enterprise-data/data-engineer.md`](https://gitlab.com/gitlab-com/content-sites/handbook/-/blob/f7efde2339c3ff060bb972805bf22692c534893d/content/job-description-library/marketing/enterprise-data/data-engineer.md) · [官方 Data Engineer 页面](https://handbook.gitlab.com/job-description-library/marketing/enterprise-data/data-engineer/) | 12,293 · `38853991faa7ae097dc9a87a8ce0df1f432313fc965dd9786981b870c3cb66d3` |

每份 JD 可能包含多个职级、specialty、招聘过程和短代码。后续标注须选定实际职级/职责范围，保存原始坐标和上下文；不能把全文所有职级要求混成一个普通工程师岗位，也不能把链接后的其他文件当作已下载证据。

### GitLab 文档许可：不要混淆仓库软件 MIT 和公开内容 CC BY-SA

公开岗位页面在内容末尾显示 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 链接。固定 handbook 的 [go.mod](https://gitlab.com/gitlab-com/content-sites/handbook/-/blob/f7efde2339c3ff060bb972805bf22692c534893d/go.mod) 钉住 `docsy-gitlab v0.4.7`；该 tag 解析到 **`33125b9e6535fd88f677fab7f42beeb002bbe24f`**。同版本 [page-meta-lastmod.html](https://gitlab.com/gitlab-com/content-sites/docsy-gitlab/-/blob/33125b9e6535fd88f677fab7f42beeb002bbe24f/layouts/_partials/page-meta-lastmod.html) 明确对非 internal 站点输出这个内容许可链接，和本次发布页实际观察一致。故 JD 派生文本按 **CC BY-SA 4.0** 保留作者/来源、许可链接和修改说明；公开分发改编文本时保留相同许可要求。仓库 [LICENSE](https://gitlab.com/gitlab-com/content-sites/handbook/-/blob/f7efde2339c3ff060bb972805bf22692c534893d/LICENSE) 的 MIT 文字限定 GitLab Software，不据此把所有内容单方面重新标成 MIT。

取证文件：

| 临时文件 | SHA-256 |
| --- | --- |
| `GitLab-go.mod` | `e041b800de84a01ef0eb65295892be81379d7fbdb4c9d8aa7ac1ae024146e193` |
| `GitLab-content-license-renderer.html` | `ed2c18d8d307b5d57f291ea133a50447debb51db36d5e9f23e7699d617dd4e90` |
| `GitLab-LICENSE-software.txt` | `92ccc4c4528726a949d9387aee90ac4acf3a092c11acf6f651e7fecec3a824aa` |
| `GitLab-SRE-published-license-observation.html` | `df072bca6fba4110d17487dbedb358ff65ff711f08f4b09e6e5bc6a1994be993` |

最后一个是 2026-11-12 获取的发布页面观察快照，不作为不变源文件；固定原文和许可渲染实现才是复现依据。许可核查是工程证据，不是法律意见；作者没有对经历真实性、隐私/肖像/第三方商标权作保证。本批仅抽取必要文字，不使用照片、logo、推荐信或联系人。

## 脱敏与事实标签实施建议

1. **双层保存**：attribution/source manifest 保留原作者、固定 URL、原文件 hash、许可、获取日期；模型可见材料只使用 `candidate-01` 等内部标识，不发送联系方式或原始网页 metadata。公开材料可通过来源重新识别，因此准确称“去标识化/脱敏”，不保证不可逆匿名。
2. **确定性替换**：姓名、邮箱、电话、生日、住址、个人 URL、社交帐号、学校和雇主/客户名分别映射为稳定占位符；同一机构跨段落保持一致。保留技术名称、原始日期或独立计算的任期、角色边界、行动和结果。映射变更有版本与审阅记录，不靠模型自由改写事实。
3. **原文坐标链**：保留原始全文 hash/UTF-8 字节；派生脱敏文本另算 hash，建立原文→脱敏文片段对应关系。模型引用用派生文本精确行号/offset，评测器再映回原始来源，不把清洗后偏移冒充原文件偏移。
4. **来源标签**：自述经历和数字默认 `self_reported`；技能清单与实际行动分开；开源/个人/练习/商业经历分开；明确 fictional 的内容不进入商业交付正样本。没有外部测量回执的百分比、规模和性能数字不能标 `independently_verified`。
5. **独立标签**：逐项给 JD 原句标核心/加分/约束及权重，给履历标支持/部分支持/缺口；同时标 STAR 行动/结果原文。标签由人工核查来源，不从被测模型输出倒推。保留部分不匹配的真实样本，防止奖励编造出缺失技术与数字。
6. **分离许可**：MIT、CC BY 4.0、CC BY-SA 4.0 文件的许可及 notices 单列；集合代码许可与第三方文本许可分开，不给整个 benchmark 套一张 MIT 后删除原归属。若对 CC BY-SA 文本翻译、删改或重排，标明改编和 share-alike。
7. **上线门**：五组逐一完成去标识化检查、PII 检测、原文 hash 验证、许可 notices、人标 anchors 和自述边界后，才纳入 Gold。真实模型执行另经已有模型/资料授权链，记录任务根账、模型版本/预算/完整输出；本报告不授权后台付费或自动上传这些原始个人材料。

## 已排除与保留原因

- **`edunham/resume` 不计入本批**：[固定 resume.tex](https://github.com/edunham/resume/blob/c660d10682888a3ab45562cbf77f47fcd6e2fe79/resume.tex) 首部将 Contents Copyright 与仅用于渲染的 LaTeX code MIT 明确分开。虽然是真实 DevOps 履历、README 提到 MIT，也不能据此认定履历内容已获再利用许可；应另获作者内容授权。原文 6,535 字节，hash `92696bfbe838693a5c1477d0700d175e7aedba9568943556e710d5aeefa545b4`。
- **`daredammy/daredammy` 暂不计入**：[README](https://github.com/daredammy/daredammy/blob/079b779daac744a4e6d21f6098cf690983319fc7/README.md) 自述主体为 Dami Dare，但 [LICENSE](https://github.com/daredammy/daredammy/blob/079b779daac744a4e6d21f6098cf690983319fc7/LICENSE) 版权署名是 Akhil Jacob，可能只继承了网站模板许可。当前不足以确认新增履历文字的权属/许可，不能为了凑数量加入。README hash `7c836d0324039c68fefdc4c9f056200963de9f5ea82f293e49ba693559b3250d`；LICENSE hash `1a3d9dd76f6674c60910eddcf204800e5a4d715f4c774dd66fe619de195cd3ba`。
- **Isaac Bernat homepage 不计入**：[作者 README](https://github.com/isaacbernat/homepage#8-license) 明确源代码 MIT，但文字内容与视觉资产另行保留权利；公开可读不等于可复制做数据集。
- **`suddi/suddi.github.io/public/resume.example.json` 不计入**：虽仓库 Apache-2.0，但当前公开路径明确是 example，未核定为完整本人真实履历；模板示例不能充当真实 Gold 样本。

本次没有联系作者、提交 issue/PR、修改线上内容或执行来源仓库代码。若后续需要扩大许可范围或独立验证事实，应单独获得明确授权；本报告可支持安全的下一步脱敏和标注，但不替代这两步。
