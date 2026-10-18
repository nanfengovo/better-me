# RenderCV 源码阅读与主题适配依据

本轮为用户指定的开源模板集成进行实际源码阅读。研究仓库固定为
[`rendercv/rendercv@1d4b87bc427e4cf61c0ef49623c971b0e2224708`](https://github.com/rendercv/rendercv/tree/1d4b87bc427e4cf61c0ef49623c971b0e2224708)，
`pyproject.toml` 的版本为 2.8、Python 要求为 3.12+。该 SHA 与 BetterMe
先前 RenderCV YAML 导出适配器的 schema pin 一致。没有安装或运行上游脚本，
没有递归初始化子模块，没有将源码仓库或示例人物履历加入产品数据。

## 实际主题和扩展架构

`src/rendercv/schema/models/design/built_in_design.py:13` 发现
`other_themes/*.yaml`，将各文件作为 ClassicTheme 的参数覆盖生成 Pydantic
变体。这个 commit 中是 **9 套**：`classic`、`engineeringresumes`、
`engineeringclassic`、`sb2nov`、`moderncv`、`harvard`、`ink`、`opal`、`ember`。
不能根据旧介绍只报五套，内嵌 Typst README 的六套说明也不是完整数量。

基础设计并非一个颜色值。`classic_theme.py` 定义 page、colors、typography、
links、header、section_titles、sections、entries 和 templates；字体可按正文、
姓名、简介、联系方式、章节分别设定，字号、行距、段距、左右日期栏宽度、
照片位置、条目分页和 section 排序均独立。`add_theme.md` 明确新主题先用
YAML 覆盖，再更新 JSON Schema，而不是复制整个渲染器。

## 全部九套的实际适配

| BetterMe ID | 上游证据 | 保留的排版特点 | 有意适配的差异 |
| --- | --- | --- | --- |
| `rendercv-classic` | `classic_theme.py:67`、125、158、369、441 | 居中彩色抬头；章节标题旁续线；正文和日期分明 | 字体由系统及用户设置提供；不生成学位专栏、计算时长、更新日期或页脚 |
| `rendercv-engineeringresumes` | `other_themes/engineeringresumes.yaml:3`、7、20、33、46、61 | 常规粗细居中姓名；黑白衬线默认；全宽章节线；圆点；职位优先；明文链接 | 字体保留可调且不捆绑 XCharter；不推断学历、地点或时间跨度 |
| `rendercv-moderncv` | `other_themes/moderncv.yaml:3`、6、19、27、53；`rendercv_typst/lib.typ:289`、628 | 左对齐姓名；左侧日期轨；章节标题左侧粗色条；正文沿同一竖线对齐 | 不捆绑 Fontin；日期先于标题，使用普通 CSS 流和左侧浮动日期，避免浏览器长页嵌套 Grid 的分页风险 |
| `rendercv-engineeringclassic` | `other_themes/engineeringclassic.yaml:3`、5、14、18、25、39 | 左对齐姓名、常规字重姓名与章节、全宽节线、职位优先与 0.12cm 要点间距 | 推荐系统无衬线代替 Raleway；不复制独立地点栏 |
| `rendercv-sb2nov` | `other_themes/sb2nov.yaml:3`、5、21、29、33、37、43 | 居中姓名、全宽节线、粗体职位与斜体机构两行、教育机构与斜体学历两行、斜体日期、完整链接、空心圆 | 推荐系统衬线代替 New Computer Modern；不猜测 degree/area，也不生成机构地点 |
| `rendercv-harvard` | `other_themes/harvard.yaml:3`、16、28、36、52 | 居中章节标题两侧等长线、机构优先、较紧凑条目间距和小号联系方式 | 不强制覆盖为 0.5in 页边距；不添加独立学位列 |
| `rendercv-ink` | `other_themes/ink.yaml:3`、10、25、44、58、83 | 左对齐姓名、无节线粗体小型大写章节、机构上职位斜体下、完整链接与紧凑正文 | 推荐系统衬线代替 EB Garamond；浏览器 justify 不承诺 Typst 相同的断行 |
| `rendercv-opal` | `other_themes/opal.yaml:3`、12、45、59、72、92 | 居中无节线常规字重章节、小型大写、空心圆、正文第二行缩至日期列之前 | 推荐系统 sans 代替 Lato；不复制 Font Awesome 联系图标 |
| `rendercv-ember` | `other_themes/ember.yaml:3`、10、13、45、60、76、94 | 系统衬线姓名/简介与正文混排、居中无节线章节、机构上职位斜体下、菱形要点、正文两端对齐且不连字断词 | 推荐系统 sans 代替 Ubuntu，系统 serif 代替 Gentium Book Plus；不输出页脚和更新时间 |

已经阅读全部九套 YAML/基础模型、对应 Typst 参数和原版 `docs/assets/images/examples/*.png`
作为布局核对，不把这些图片作为 BetterMe 缩略图或资产。BetterMe 图库继续用
自己的渲染器与合成内容，确保卡片和实际简历采用同一结构。

最初按三套规划，用户随后要求全量接入，现已扩为该固定版本全部九套。
主题是独立 CSS 规则与逐套元数据：不是用多个名字指向同一空壳。
它们也共享上游本来共用的 Classic 基础参数，不夸大相近主题间的差别。
建议色和 sans/serif 通过显式操作应用；切换主题不暗中覆盖原字号、字体、颜色或边距。
字号仍来自 BetterMe 可调变量，没有假装实现上游每个元素的独立字体/字号表。

## 内容和生成接口

`RenderCVModel` 分为 `cv`、`design`、`locale`、`settings`；`Cv.sections`
保存任意命名章节，条目支持教育、工作、通用、论文、单行、文本、圆点及编号等
更广的结构。BetterMe 以 Fact → ProjectedResume 为输入，继续只展示已选择、
已允许的事实，不把上游模型当成第二事实库，也不为凑主题生成论文或学位。

实际渲染链为 `renderer/typst.py:9` 调用 Jinja
`templater/templater.py:51` → `Preamble.j2.typ` 映射设计参数 →
`rendercv_typst/lib.typ` → `pdf_png.py:17` 通过 `typst.Compiler` 输出 PDF。
HTML 是另一条 Markdown 转换路径，不能当作与 Typst 同版的网页模板。
CLI 的入口是 `rendercv new "Name" --theme <theme>` 与
`rendercv render file.yaml`。本轮将九个可审计主题参数适配到浏览器，
没有向 Web 应用加入 Python/Typst 运行时。

上游对所有发现的主题分别执行 minimal/full Typst 文本与 PDF 参考文件比较，
并生成 minimal PNG（`tests/renderer/test_typst.py:8`、
`test_pdf_png.py:19`）。这些是上游的测试设计，本轮没有执行它们，不能替代
BetterMe 自己的浏览器、长文本、中英、隐藏字段和真实打印验收。

## 许可与资产边界

顶层 `LICENSE` 是 MIT，版权行是 `2023 to present Sina Atalay and individual
contributors`。适配保留完整文本并带确切源版本的 NOTICE，位置为
`templates/licenses/rendercv/`。内嵌 `rendercv_typst/LICENSE` 另标
2025 Sina Atalay，但本轮不复制该 Typst 引擎实现。

`pyproject.toml` 的 full 依赖含独立 `rendercv-fonts`；`.gitmodules`
另含 `typst_fontawesome`，其 gitlink 为
`21afe7e7e4e2019d1dc96976771dfedd5e0f632d`。没有用仓库顶层 MIT
替这些独立资产作许可结论，没有下载/打包任何字体或图标。
上游网页品牌、订阅服务或网站素材不在本次移植范围。

实现与最终验收结果由本轮集成报告记录；本文是固定 SHA 的源码依据，
不把源码阅读、结构单测和真实 PDF 目视验收混作一个完成状态。
