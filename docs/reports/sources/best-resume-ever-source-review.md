# best-resume-ever 源码审查与 17 套模板适配

实际阅读来源为
[`salomonelli/best-resume-ever@29e753cd842585b4a2e9dbbb5e1ef3a0f5e66767`](https://github.com/salomonelli/best-resume-ever/tree/29e753cd842585b4a2e9dbbb5e1ef3a0f5e66767)，
从 awesome-resume-for-chinese 的开源模板链接进入。没有安装旧版 Vue 工具链，
没有运行仓库导出脚本，没有复制示例履历、照片或字体。适配输入继续是
BetterMe 的 ProjectedResume。

## 文件数量和实际主题

逐个阅读 `src/resumes/*.vue` 的 template、script 和 scoped Less。共有 18 个
Vue 文件，但 **17 个实际主题**：`template.vue` 只有 `This is a template`、
`TEMPLATE-NAME` 和 TODO，style 为空，是作者创建新模板用的骨架。不能用它凑数。

| 实际源码 | 源码中的主要差异 | BetterMe 对应适配 |
| --- | --- | --- |
| `cool.vue` | `#42b883` banner、`#34495e` 左侧轨、Roboto、圆头像、方技能块 | 绿色页首、深资料轨、方技能标签；选择的绿色适当调暗以保证白字对比 |
| `cool-rtl.vue` | 侧轨镜像到右；banner 仍左对齐 | 右侧轨；不额外设置 Unicode RTL |
| `cool-rtl2.vue` | 右侧轨加姓名、标题、条目、技能的右对齐 | 右轨和右对齐；不冒充原本不存在的 RTL 字符转换 |
| `creative.vue` | `#a800fa` 身份侧栏、白联系字、方技能、可选兴趣和封面素材 | 紫色身份侧栏和方技能；不添加兴趣、背景照片或图标 |
| `green.vue` | 绿色大页首、职位在姓名上方、白色大写姓名、缩进工作经历 | 同源结构、推荐绿色；去掉绝对定位底部 about 防止覆盖正文 |
| `purple.vue` | Green 同结构，purple / `#680568` 配色 | 同布局紫色变体；不夸大为另一种分栏机制 |
| `left-right.vue` | 细框大写姓名、居中圆照片；工作/联系和教育/技能人工分两栏 | 细框姓名和按当前顺序自然流动的双栏；不生成技能分数 |
| `left-right-projects.vue` | 较紧凑字号、双栏下方跨栏项目 | 更紧凑条目；项目分节跨栏 |
| `left-right-rtl.vue` | `direction: rtl`，技术字段有 LTR 例外 | 保留 RTL 栏序和技术字符串的 LTR 隔离 |
| `material-dark.vue` | 灰 `#ccc` 背景、白卡、`#16151c` 左轨，不是全页黑底 | 深资料轨、灰画布、白分节卡、浅棕日期 |
| `material-dark-projects.vue` | 35% 身份轨和两个 30% 固定内容栏 | 紧凑白卡及项目双列；保持用户分节顺序，避免固定三栏裁切长内容 |
| `oblique.vue` | `#006064` 的 1500px 大三角、右对齐白色大写姓名、绝对坐标 | 正常文档流中的青色斜切渐变，可随长姓名和联系方式增长 |
| `oblique-projects.vue` | 较浅三角和密集项目布局 | 较短斜切页首、紧凑项目、项目侧线 |
| `oblique-rtl.vue` | 镜像三角和 `direction: rtl` | 镜像斜切和 RTL 正文，日期、链接、技术字段隔离 |
| `side-bar.vue` | Raleway、宽字距居中姓名、照片/联系侧轨、轻字重章节、圆技能 | 宽松居中身份、窄资料轨和圆形技能标签 |
| `side-bar-projects.vue` | 降低页首空白和姓名字号、加入项目区 | 紧凑身份区、单独项目节和圆技能 |
| `side-bar-rtl.vue` | 右侧轨、RTL、LTR 联系例外 | 右轨、RTL 正文与技术字符串隔离 |

Cool 的两个带 rtl 的文件并没有都设置 `direction:rtl`，因此不能只看文件名
就把五个变体一起施加 RTL。Green / Purple 在上游就是同一结构的配色变化，
如实保留。Projects 变体在项目区、密度和跨栏上有明确 CSS，不是只有不同名字。

## 与现有架构的连接

独立 `best-resume-catalog.ts` 导出 `BEST_RESUME_TEMPLATES`，包含 17 个
`best-resume-*` ID、社区来源、双语名称与描述、逐套推荐色、字体族和许可证路径。
`best-resume-themes.css` 限定在该命名空间内。图库、主预览和打印继续使用
同一个 BetterMe renderer；上游 Vue 和 Less 不进入应用运行时。

原版把教育/技能硬编码在侧栏，当前适配按用户设定的正文节序排列，不把
某个分节偷偷移动到另一条阅读序列。Left Right 用顺序 CSS columns；Material
Projects 用项目区域的 columns。头像仍由 BetterMe 的已有开关决定；共享 DOM
中的 Cool / Side Bar 照片位于联系方式之后，不声称逐像素复制原版位置。

不添加原版 skill.level 分数条、兴趣爱好、模板说明、固定页尾或未选择的事实。
不把模板选择变成内容改写。推荐配色和字体族由显式应用操作使用；已有手动
字号、颜色、页边距仍受 BetterMe 的设置系统控制。

## 许可和验收边界

`LICENCE.md` 为 MIT，版权 `Copyright (c) 2017 Sara Steiert`。完整正文保存于
`templates/licenses/best-resume-ever/LICENSE`，NOTICE 逐个列出 17 个源文件。
不捆绑照片、封面、字体、图标和源示例人物。没有用顶层 MIT 对原字体或
Material 图标作一揽子授权推断。

本报告记录源码阅读和适配依据。浏览器需覆盖 17 套切换、中文/英文、隐藏
字段、长网址、照片开关和推荐色；真实 PDF 需检查多页侧轨续流、双栏分页、
Material 卡片碎片和 Oblique 白字是否全部留在斜切色块内。不能把静态检查
或上游 Puppeteer 的行为当作当前 BetterMe 打印已经完成；最终结果由统一
集成验收记录。
