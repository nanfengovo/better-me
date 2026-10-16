# 简历、模板与排版来源调研

调研日期：2026-10-16。范围：用户指定的 `dyweb/awesome-resume-for-chinese`、`rendercv/rendercv`、`NewFuture/CV`。通过 GitHub REST API 和 raw 文件实时阅读 README、目录、配置、核心渲染文件和许可证；没有安装依赖、执行上游代码或修改本项目业务代码。

## 结论

三个来源解决的是不同层次的问题，不能整体拼装成完整的职业成长 Agent：

| 来源 | 实际性质 | 可以贡献什么 | 不能据此宣称什么 | BetterMe 建议 |
|---|---|---|---|---|
| awesome-resume-for-chinese | 中文简历模板的资源索引，主要是链接与截图 | 发现中文模板、比较信息密度、区分 LaTeX / HTML / Typst 路线 | 自己提供模板渲染 API；收录即获复制许可；已维护的模板包 | 作为选型目录；逐个检查被收录模板，挑少量适配 |
| RenderCV | 结构化 YAML 驱动的简历排版引擎；当前源码使用 Python + Typst | 严格 schema 校验、可版本化输入、多主题、PDF/PNG/Typst/Markdown/HTML 输出 | 成长规划、招聘抓取、自动翻译、JD 推荐和 DOCX 导出引擎；所有 ATS 必过 | 优先规划导出 adapter；继续保留 TS Fact 核心与 Web 默认预览 |
| NewFuture/CV | Jekyll/Liquid 驱动的静态网页简历模板 | YAML/JSON/Markdown 内容与展示分离、响应式网页、打印样式 | 现代 AI 简历工作台、简历事实库、ATS 认证或多端状态管理 | 借鉴数据与样式组织；必要时少量移植至 React，不引入 Jekyll 主栈 |

架构建议：**BetterMe 拥有用户事实、证据、目标、学习和投递状态；上游渲染器只接收已审核的简历视图快照。** 模板更换不能改写事实，也不能把学习计划或 AI 推测自动写成简历成绩。

## 1. dyweb/awesome-resume-for-chinese

### 读取与核实

- 默认分支：`master`；本轮分支提交：`fefc06e7dd667ff78bf7c5cccad715efddaef15f`。
- 根目录只有 `README.md`、`contributing.md`、`image/`，不是可安装的渲染 SDK。
- README 以 `LaTeX`、`HTML/JS`、`Typst` 分类收录项目，包含本轮另行研究的 NewFuture/CV，也包含 JSON Resume 链接。
- 明确列出应届生模板、中文与中英模板、网页式简历、Markdown 和 Typst 等不同形态。选择时需要按求职场景进一步筛选，不能因为同处一个集合就混为同种模板。
- GitHub metadata 的 `license` 是 `null`，`GET /repos/dyweb/awesome-resume-for-chinese/license` 返回 **404**，根目录也未见 LICENSE。404 表示本轮没有发现可依赖的根级许可证，不能擅自当成 MIT 或公有领域。

### 借鉴方法

1. 建一个 BetterMe 模板候选清单：来源 URL、固定版本、作者、许可证、字体/图标依赖、中文支持、照片开关、纸张、栏数、可读文本层、导出方式。
2. 优先自研三种用途明显不同的模板：中文通用、中文校招、英文简洁。照片、教育位置、项目详略和纸张作为显式配置，不单凭“国内/国外”开关决定全部内容。
3. 从集合中进一步挑 1–2 个许可清楚的主题做适配评估。被收录项目的 LICENSE、继承来源和字体许可须独立核查；本次未逐一审查集合中的所有外链仓库。
4. 不搬运整页截图或作者真实简历；为本项目制作匿名样例与预览图。

### 来源

- [仓库](https://github.com/dyweb/awesome-resume-for-chinese)
- [本次 README 固定版本](https://github.com/dyweb/awesome-resume-for-chinese/blob/fefc06e7dd667ff78bf7c5cccad715efddaef15f/README.md)
- [根目录 API](https://api.github.com/repos/dyweb/awesome-resume-for-chinese/contents)
- [许可证 API，本轮 404](https://api.github.com/repos/dyweb/awesome-resume-for-chinese/license)

## 2. rendercv/rendercv

### 实际技术与输入输出

- 默认分支：`main`；本轮分支提交：`1d4b87bc427e4cf61c0ef49623c971b0e2224708`。
- `pyproject.toml` 声明项目版本 **2.8**、Python **>=3.12**。这是本次读取的源码版本，不等于核实了安装源的最新稳定发布版本。
- 基础依赖包括 Pydantic、ruamel.yaml、Jinja2、Markdown；`[full]` 加入 CLI、文件监听、`typst>=0.14.8` 和 `rendercv-fonts>=0.5.1`。
- 当前管线是 **YAML → Pydantic 校验 → Jinja2 生成 Typst → typst-py 编译 PDF/PNG**。不能根据旧印象把当前版本说成需要 TeX Live 的 LaTeX 工具。
- 另一路是 **结构化数据 → Markdown → HTML**。HTML 不是 PDF 的逐像素同款预览。
- 源码中提供 `generate_pdf`、`generate_png`、`generate_typst`、`generate_markdown`、`generate_html`；本轮未发现 DOCX 输出管线，不能靠这项集成直接完成 BetterMe 的 Word 导出。
- README 展示 9 套主题：classic、engineeringresumes、sb2nov、moderncv、engineeringclassic、harvard、ink、opal、ember；可配置纸张、边距、字体、颜色、日期列等。
- 渲染所用 Typst 包与图标包可随 Python 包打包；`pdf_png.py` 通过本地临时 package cache 解析，并未要求每次生成 PDF 都从 Typst Universe 下载。用户自行使用额外包、未缓存资源或网络字体属于另外的部署条件。

### 中文、英文与 ATS 的真实边界

**多语言排版：** 源码有 `mandarin_chinese.yaml`，其中包括“至今”、中文月份等 locale。`rendercv-fonts` 目录有 NotoSansSC 常规/粗体文件；自定义字体可放到输入 YAML 同级 `fonts/`。因此中文并非只能硬改模板，但“locale 支持”不能代替中文断行、标点、字体嵌入和导出质量验收，也不会自动把中文经历翻译成英文。

**ATS：** 仓库有 `scripts/ats_proof/`、已知输入语料、两种文本提取工具的结构检查，以及向 Affinda/Extracta/Klippa 提交的商业解析脚本。这套“结构化输入作为标准答案 → 导出 → 重新解析对照”的测试方法值得借鉴。

但本次读到的 `ats_compatibility.j2.md` 是报告模板，包含“全部正确解析”的上游结论措辞；不能把模板文字当成本轮独立执行的实测结果。其示例语料和报告中写到的五主题范围，也不能自动证明当前九主题、中文姓名、中文日期、照片、多页与国内 ATS 的所有组合都已验证。本次没有运行其测试、没有上传真实简历至任何商业服务。

BetterMe 对用户应展示可检验结果：文本是否可提取、阅读顺序、必填字段、字体/乱码、选定模板与场景的回归样本。应把“排版可解析性”“JD 证据匹配”“招聘方硬门槛”“最终筛选结果”分别说明，不给一个冒充录用概率的万能 ATS 分数。

### 许可证与第三方资产

- 主仓库 LICENSE 为 **MIT**；内置 `rendercv_typst/LICENSE` 也是 MIT。复制或打包相关实现时保留相应版权和许可文本。
- `.gitmodules` 引入 `duskmoon314/typst-fontawesome`；该封装库本身是 MIT，但图标字体的权利不随封装库变成 MIT。
- `rendercv-fonts` 根许可证为 MIT，字体目录保留各自许可证。例如 Noto Sans 的中日韩字体许可证为 **SIL OFL 1.1**；Font Awesome Free 许可明确区分字体文件的 OFL 1.1 与 SVG/JS 图标的 CC BY 4.0。
- 以后若打包字体，只选必要、来源明确的字体并保留许可；不要把系统已有的商用中文字体默认复制进安装包。Font Awesome Pro 也不能因代码支持而直接分发。
- 主题来源、依赖及 notice 应随 adapter 版本锁定。此处是实施前权利边界核对，不代表已完成所有传递依赖的许可审计。

### 与 BetterMe 的衔接方式

建议接口边界：`FactBase + ResumeView → ProjectedResume → RenderCV adapter → YAML + 资源包 → 本地 renderer → PDF/PNG 等产物`。

| BetterMe 数据 | RenderCV 目标 | 注意事项 |
|---|---|---|
| `profile.displayName`、email、phone、location、links | `cv.name`、email、phone、location、website/social_networks 等 | 先按 locale 投影；无法映射为已知社交站点的链接应保留为普通连接项，不丢失 |
| `work` 经历 | experience section / ExperienceEntry | 公司、职位、起止时间及 highlights 对齐；不得增添结果数字 |
| `education` 经历 | education section / EducationEntry | 当前模型 title 混有专业/学位；不可假设一个固定分隔符能无损拆开，必要时提示补充结构字段 |
| `opensource` / `other` 经历 | projects 或自定义 section | 保留 URL、角色、技术栈和要点；开源不等于受雇工作经历 |
| 通过审核、可展示的 claims | highlights / summary | `pitfall`、`interview`、私密证据、未审核数字不发给模板；若显示原文中的数字也须遵循核实规则 |
| `ResumeView` 的 locale、templateId、sectionOrder | locale、design、sections 顺序 | adapter 显式建立主题映射与支持能力，未知项给出诊断，不能静默丢字段 |
| `avatarUrl` 的本地 Data URL | photo 资源文件 | 渲染任务临时目录内落地；按 ResumeView 的照片策略控制，并在任务完成后清理 |

现有 `projectResume` 是可利用的边界，但它尚非完成的通用文档中间层：当前投影未充分消费 `sectionOrder`，英文缺失会回退中文，指标核实上游还有已知缺陷。先修真实性和投影问题，避免只换排版引擎就宣称结果可信。

**建议分两步落地：**

1. 先提供 RenderCV YAML 导出包。纯 TS adapter 可留在 Web；用户可自行渲染，本阶段无需给默认 Web 引入 Python。导出同时生成字段映射/遗漏诊断与匿名示例。
2. 再评估可选本地导出工作进程，固定 Python、RenderCV、Typst、字体版本，并控制临时文件、取消、超时和错误信息。Web 页面不能直接执行 Python；需桌面壳或显式安装的本地组件。若探索 Typst WASM，需要另行验证 Web 包、性能与 API 兼容性，不能直接等同复用整个 Python RenderCV。

不建议：为接入模板把整个核心从 TS 重写为 Python；让 YAML 成为与 FactBase 并行可写的主库；默认将简历发到 rendercv.com；在尚未证明有收益时同时维护浏览器、Python、LaTeX 三套完整渲染实现。

### 精确来源

- [README](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/README.md)
- [pyproject.toml：版本、Python、依赖](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/pyproject.toml)
- [PDF/PNG 编译、字体路径、本地 Typst package cache](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/src/rendercv/renderer/pdf_png.py)
- [Typst 输出](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/src/rendercv/renderer/typst.py)
- [Markdown 输出](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/src/rendercv/renderer/markdown.py)
- [HTML 从 Markdown 生成](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/src/rendercv/renderer/html.py)
- [中文 locale](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/src/rendercv/schema/models/locale/other_locales/mandarin_chinese.yaml)
- [自定义字体说明](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/docs/user_guide/how_to/custom_fonts.md)
- [ATS 报告模板及方法](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/scripts/ats_proof/ats_compatibility.j2.md)
- [商业解析调用脚本](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/scripts/ats_proof/submit_commercial.py)
- [主 LICENSE](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/LICENSE)
- [Typst 模板 LICENSE](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/src/rendercv/renderer/rendercv_typst/LICENSE)
- [子模块声明](https://github.com/rendercv/rendercv/blob/1d4b87bc427e4cf61c0ef49623c971b0e2224708/.gitmodules)
- [字体库目录](https://github.com/rendercv/rendercv-fonts/tree/main/rendercv_fonts)
- [Noto 中日韩字体 OFL](https://github.com/rendercv/rendercv-fonts/blob/main/rendercv_fonts/Noto%20Sans/OFL%20JP%2C%20KR%2C%20SC.txt)
- [Font Awesome 7 资产许可证](https://github.com/rendercv/rendercv-fonts/blob/main/rendercv_fonts/Font%20Awesome%207/LICENSE.txt)
- [typst-fontawesome 封装库 LICENSE](https://github.com/duskmoon314/typst-fontawesome/blob/main/LICENSE)

以上核心仓库来源已固定到本次提交；字体/图标附属仓库链接为本轮读取时的 `main`，实际集成时应补固定版本。

## 3. NewFuture/CV

### 读取与核实

- 默认分支 `gh-pages`，本轮提交 `748b54d843fab4347a82943967ba8eedbeaa4ae6`；GitHub 返回该分支最后提交日期为 **2019-06-29**。不能把它按近年活跃维护的现代应用基座推荐。
- README 支持 Markdown、YAML、JSON 输入，Jekyll/GitHub Pages 生成网站；本地调试要求 Jekyll，因此有 Ruby/Jekyll 运行环境成本。不是 React 组件库，不要求 Python、Typst 或 LaTeX。
- `_data/resume.yml` 定义姓名、语言、照片、联系方式、教育/经历/技能等 section；`_layouts/resume.html` 用 Liquid 渲染。可以嵌套 Markdown 文件，也有可折叠的 summary/detail。
- `_config.yml` 有打印字号、边距、区块参数及 `basic`、`flex`、`block` 三类打印样式；实际导出是 `window.print()` 调浏览器“保存为 PDF”。
- 页面支持 `lang: zh/en` 和相关文本/字体样式，不代表自动翻译或同源双语事实管理。
- 根 LICENSE 为 **MIT**。但 `_layouts/default.html` 直接含 Jekyll HTML 压缩布局的第三方版权：`© 2014–2015 Anatol Broder`、MIT；若搬运对应文件应保留其版权。原仓库图标、头像示例和参考来源仍须分别核实，不直接拷贝作者图像。

### 建议借鉴与不引入的部分

值得借鉴：内容与样式分离；屏幕与打印布局分别设计；小屏显示方式；同一数据生成网页/打印简历；静态作品页可与投递版简历分工。

建议在 BetterMe 的 React 模板中实现同类能力，统一消费 `ProjectedResume`。如需兼容老模板用户，可写 `ProjectedResume → NewFuture YAML/JSON` 的单向导出，而不是把其 `_data/resume.yml` 作为第二主库。

不建议为了这个主题引入 Jekyll 服务，或继续携带 IE6/IE7 兼容分支、旧式 `javascript:` 打印链接、任意 `scripts` 与 `attr` 配置。若接受外部 Markdown/HTML 输入，使用本项目自己的安全渲染路径，不直接照搬 Liquid 中的原样 HTML/属性拼接。

网页简历可以保留更详细的项目叙述，但 ATS 投递版采用独立简洁布局。折叠内容、侧栏、图标和“打印时避免分页”都要实测可提取性、打印展开状态、长段溢出，不能据 README 的兼容列表就承诺当前浏览器/招聘解析结果。

GitHub Pages 是发布渠道选项；BetterMe 默认本地优先，不自动把个人事实库、私密证据和密钥提交到公开简历仓库。

### 来源

- [README](https://github.com/NewFuture/CV/blob/748b54d843fab4347a82943967ba8eedbeaa4ae6/README.md)
- [数据示例与 zh/en 设置](https://github.com/NewFuture/CV/blob/748b54d843fab4347a82943967ba8eedbeaa4ae6/_data/resume.yml)
- [Jekyll 与打印参数](https://github.com/NewFuture/CV/blob/748b54d843fab4347a82943967ba8eedbeaa4ae6/_config.yml)
- [实际 Liquid 渲染与 window.print](https://github.com/NewFuture/CV/blob/748b54d843fab4347a82943967ba8eedbeaa4ae6/_layouts/resume.html)
- [屏幕样式与字体](https://github.com/NewFuture/CV/blob/748b54d843fab4347a82943967ba8eedbeaa4ae6/_sass/resume.scss)
- [打印样式](https://github.com/NewFuture/CV/blob/748b54d843fab4347a82943967ba8eedbeaa4ae6/_sass/print/_print.scss)
- [第三方 HTML 压缩布局署名](https://github.com/NewFuture/CV/blob/748b54d843fab4347a82943967ba8eedbeaa4ae6/_layouts/default.html)
- [MIT LICENSE](https://github.com/NewFuture/CV/blob/748b54d843fab4347a82943967ba8eedbeaa4ae6/LICENSE)

## 4. 对完整职业成长规划的具体影响

模板层应服务“证明自己”，不能变成独立于成长事实的简历美化孤岛。建议保留以下链路：

`目标岗位/JD → 缺口 → 学习任务 → 项目/测验/面试证据 → 待审核能力与成果 → 人工确认 Fact → 针对岗位的 ResumeView → 多格式导出`。

这里 **完成一节课、连续打卡或 AI 对话的赞扬，不等于已经具备可写入简历的熟练技能**。规划系统可以提出补强方案，测验/作品可记录证据；只有经过明确审核的事实进入正式简历。多份 JD 定制简历共享同一事实底座，允许筛选和重写表达，保留每条表达引用的事实 ID 与版本。

建议后续验收三个模板/导出能力时，至少覆盖：中文与英文、校招与社招、长公司名与链接、跨页、缺少英文的提示、照片开关、不同纸张、复制粘贴阅读顺序、量化未确认过滤、来源版权随包、生成物版本和日期可追溯。当前任务只完成来源调研与方案建议，以上能力没有因此被实现或验收。

## 5. 访问记录和核实限制

- 三个指定仓库：GitHub metadata、README、目录读取成功；RenderCV 和 NewFuture/CV LICENSE 读取成功。
- awesome-resume-for-chinese LICENSE API：404；根目录没有 LICENSE。
- RenderCV 的 `scripts/ats_proof/README.md`：404；已改读实际存在的脚本、报告模板和测试目录，不将不存在的说明文件作为来源。
- 附属字体库、图标库的 README/LICENSE/目录及上述字体许可文件：读取成功。
- 没有审查三个仓库的每个历史提交、全部 issue 或 awesome 索引的每个外链；没有运行渲染、执行 ATS 服务调用或做中文样本验收。建议集成选择基于本轮阅读的实现和许可边界，实施时仍需固定版本并做样本验证。
