# NewFuture / 中文模板索引源码阅读记录 · 2026-10-18

用户要求深入阅读并集成指定开源项目，随后明确希望全量接入。本记录覆盖 NewFuture/CV、awesome-resume-for-chinese 的全部 31 个顶层入口与可适配主题；RenderCV 与 JSON Resume 的阅读记录独立维护。研究没有执行上游构建脚本，没有复制任何示例人物履历。逐个入口的固定 revision、源码、许可与状态见 [完整清单](awesome-template-inventory.json)。

## 固定来源

| 来源 | 本轮固定 revision | 实际源码 / 许可证据 |
| --- | --- | --- |
| [NewFuture/CV](https://github.com/NewFuture/CV) | `748b54d843fab4347a82943967ba8eedbeaa4ae6` | `_layouts/resume.html`、`_sass/resume.scss`、`_sass/mobile.scss`、`_sass/print/{_print,basic,flex,block}.scss`、`assets/css/main.scss`、`_config.yml`、`LICENSE` |
| [dyweb/awesome-resume-for-chinese](https://github.com/dyweb/awesome-resume-for-chinese) | `fefc06e7dd667ff78bf7c5cccad715efddaef15f` | 根目录只有 `README.md`、`contributing.md` 与 `image/README.md`；未见 LICENSE，不是模板源码库 |
| [billryan/resume](https://github.com/billryan/resume) | `eadc3955cf006254dc8f2419e971fbe3f5bab413` | `README.md`、`LICENSE`、`resume.cls`、`zh_CN-Adobefonts_{internal,external}.sty`；仅 clone 默认分支，没有下载包含 Adobe 中文字体的 zh_CN 分支 |
| [dyweb/Deedy-Resume-for-Chinese](https://github.com/dyweb/Deedy-Resume-for-Chinese) | `3fe0e55a52ad3a96958b1bcd3c8e4674fc72f5ce` | 固定 SHA 读取 `README.md`、`LICENSE`、`OpenFonts.Chinese/deedy-resume-openfont.cls`、`OpenFonts.Chinese/resume.tex`；GitHub tree 核实目录与字体大小，没有下载字体 |

本地上游源码都保存在 Git 忽略的 `.agent-memory/.tmp/template-sources/`。NewFuture、awesome 和 billryan 使用浅克隆；Deedy 的额外全库克隆因包含数百 MB 字体而中止，随后以固定 revision 获取上述四个文本文件至 `deedy-text/`。固定 SHA 的文本已完整读取，不以 README 截图替代源码阅读。

## NewFuture：本轮实际移植

源项目是 Jekyll/Liquid 模板，用 `site.data` 的 YAML/JSON 为输入。`resume.html` 将抬头、联系方式和可选头像分块，再按 `main` 和 `others` 章节渲染；条目具有 title/sub、tags/duration、summary/detail/items 分支，部分详情可折叠。

`resume.scss` 的识别特征是姓名/联系方式并排、浅蓝粗底线、右对齐侧标章节、黑色加粗条目与灰色次级信息、标签/日期细框。默认主体为 Palatino/Georgia/NSimSun 系统字体。`_config.yml` 设置侧标宽度 20%；中文 CSS 对章节标题进一步缩窄。移动版在 768 px 以下将章节标题堆叠；该逻辑面向网页，不直接适用于编辑器缩放的 A4 纸。

三种打印模式 basic/flex/block 都依赖 `_print.scss`，原有 keep-together 同时用于 article/ul/li/p，较长经历可能整块推到下一页。BetterMe 适配沿用自己的动态页边距与长内容分页规则，屏幕用边栏 grid，打印改成同尺寸的 float/正常流。

本轮新增 `apps/web/src/components/templates/newfuture-theme.css`，实际接入 `newfuture`（basic 侧标）、`newfuture-flex`（密集侧标）与 `newfuture-block`（无侧标居中章节）三个模板 ID。flex 保留紧凑条目、无框日期和逗号标签；block 将章节改为整行居中并取消侧标缩进。保留原来的结构化事实投影、显示控制、顺序、RichResumeText、头像与预览锚点；不引入 Jekyll。源 MIT 的完整文本与版权及改动说明保存在根 `templates/licenses/newfuture/`。没有复制原示例履历、照片、SVG 或字体；颜色和字号接受原有编辑参数。这是明确署名的适配版，不是原渲染器的逐像素复刻。

## awesome-resume-for-chinese：来源目录，不能整体授权

索引分别列出 LaTeX、HTML/JS、Typst，包含 NewFuture、JSON Resume 和多个独立模板库。README 内的截图和链接不等同于可直接导入的主题源码；索引自身在本次 SHA 未见 LICENSE，也不能拿某一外链的 MIT/Apache 许可授权其他全部链接。

本轮已逐个核对全部 31 个入口：19 个来源具有可适配的真实模板和明确许可，12 个入口因无模板授权、404、受限再分发条款、并非可用纸面源码或重复生态入口而明确排除，不虚报已集成。没有爬取商业简历站，也没有将第三方人物信息作为 BetterMe 预设。

### billryan/resume

`resume.cls` 是 11pt article 的单栏 XeLaTeX 类：居中大姓名、居中无衬线联系方式、全宽细线章节、左右两端对齐的 datedsection/datedsubsection，以及紧凑 itemize。几何为 A4、左右 .8in、顶部 .70in、底部 .55in。正文默认 TeX Gyre Termes，标题使用 small caps；中文通过两个 xeCJK 辅助 sty 配置 Adobe 宋/黑/楷/仿宋。

MIT 许可证允许代码适配，但 README 明确写着 `Copyrighted fonts are not subjected to this License.`，不能将 Adobe 字体或默认目录下的其他字体按主库 MIT 分发。默认分支已读的 class 足够提取布局，不需要下载中文字体分支。本轮实际实现独立 `billryan` 单栏适配：居中抬头、small caps 衬线整行横线章节、右对齐时间和紧凑要点，保留 MIT 原文并用系统宋体/已有字体替代。CSS 位于 `apps/web/src/components/templates/billryan-theme.css`，来源和修改记录位于 `templates/licenses/billryan/`；与现有 Classic 的分节差异是完整底线、单列摘要、内联技能和更紧凑的条目节奏。

### Deedy-Resume-for-Chinese

当前中文 `resume.tex` 真实采用 `minipage` 宽度 `.25\textwidth` 和 `.73\textwidth`：左边教育/链接/技能，右边实习/项目与论文/开源/荣誉。不是单纯的标题侧标。中文 class 将正文设为思源宋体、无衬线为思源黑体，姓名 30pt、章节 16pt/24pt、条目 12pt；tightemize 保留 1pt 项间距。README 本身也承认这种高密度双栏可能略显凌乱，建议加粗重点。

根 LICENSE 为 Apache-2.0，README 将字体许可明确分开。本次 tree 显示思源 Sans 每字重约 15–17 MB、Serif 每字重约 21–25 MB，本轮没有整库引入。适配保留 Apache 原文、修改说明及应保留的归属；若日后真正打包字体，仍需单独核验字体 OFL 与 Reserved Font Name 等要求。

本轮主任务接入独立 `deedy` 适配：全宽姓名、约四分之一的个人联系轨与按当前顺序的正文，明确没有将原教育/技能固定分区冒充完整复刻。保留单次锚点、显示控制与用户排序，固定 minipage 的一页目标不带入长内容 PDF。详细边界见 [Deedy 源码记录](deedy-source-review.md)。

## 本轮取舍

本轮 NewFuture 接入全部三个源内打印样式；awesome 自身作为发现路径，不声称拥有统一主题许可。除现有 billryan 外，新增 17 套 community 适配：hijiangtao、luooofan 三种 titlelinestyle、Kody 求职/复试纸面、Mix、Crisp、Lxxyx、Xiao555、Nzbin、Itsay、Geekplux、Resume NG、Weitian Li、Pandoc 与 CONGMIN。Best Resume Ever 的 17 个实际主题与 Deedy 由主任务接入，`template.vue` 仅是作者空骨架，不计入主题。

## 全量阅读后发现的实际许可差异

- Geekplux 根 LICENSE 是 MIT，但 `template_cn_blue.tex` 头部保留 Xavier Danaux 的 LPPL-1.3c，适配按源文件许可处理，并额外保留根 MIT。
- `fky2015/resume-ng` 的类与根 LICENSE 是 LPPL-1.3c；`liweitianux/resume` 的 class 头部和 README 也明确 LPPL-1.3c，其工具 MIT、个人正文 CC BY 4.0 不替代 class 许可。三个改名的 CSS 翻译保留完整 LPPL、维护/改动说明和获得完整固定原作的 URL；不宣称由原作者支持。
- `mszep/pandoc_resume` 根 LICENSE 为 MIT，真实 `styles/chmduquesne.css` 与 ConTeXt 文件却标 CC BY-SA 3.0，署名 Christophe-Marie Duquesne，后者另署 Mark Szepieniec。该样式适配单独保留 CC BY-SA 3.0，未混称 MIT。
- `mcc108/resume` 的根许可是 CC BY-SA 4.0，作者要求署名 CONGMIN。两份 CC 样式在独立 CSS 中保持对应共享方式许可，模板元数据带可打印的作者/来源/许可署名，且不把用户简历事实或应用其他模块改许可。
- Gitee `itsay/resume` 实际浅克隆成功，固定 `3713efb55163048cf9aa726b55ee698c356097a2`；MIT 版权为 2017 Zelda Zhang。已读 SCSS 资料卡/正文卡布局并实际适配，没有把 GitHub 同名404当成 Gitee 不可用。
- Orbit 的 README 要求页脚署名并禁止模板单独再分发；仓库仅有 FontAwesome 的 LICENSE，不把该字体许可冒充主题许可。该来源不复制进模板库。
- CyC 的 README 只链接 FontAwesome 许可；OrangeX4、nuterian、yujiangshui、ckjbug 当前固定源码也没有明确模板再分发授权，均保留为未接入项。

## 适配范围与内容模型边界

全部已实现 CSS 复用 Fact 投影与现有编辑参数，均保留真实正文、可见性、顺序、文字格式与预览锚点。字体、人物履历、二维码、技能百分比和头像均不从上游带入。Kody 复试原稿含成绩表/政治面貌，但这些数据不在现有模型，当前只适配纸面视觉，不伪造表格或声称已实现复试表功能。原固定双栏/多栏在明确标注的模板中改为保序纸面；这些差异都写在各源 NOTICE 和模板说明里。

Ovilia 的网页源码是 pagePiling 个人站，PDF 源只有 InDesign 文件；zhaoky 是整屏互动网站。两者未被简单换色后冒称纸面移植。guanpengchn 主要是 Markdown 工具，未见代码许可；Horldsence 和 DreamBroke 指定 URL 返回404。这些均在完整清单中写明状态，而不是把登记链接当作完成集成。

所有新的生产接线仍由主任务统一检查真实缩略图、锚点、内容完整性和实际 PDF；本来源研究记录本身不冒充最终运行验收。
