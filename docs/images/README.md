# 项目截图

## 简历导入后岗位推荐 · 2026-10-31

[resume-job-recommendations-20261031.jpg](resume-job-recommendations-20261031.jpg) 为 1214 × 1066 的实际简历编辑器截图，来自本机开发环境，不是独立 HTML 示例页。新上传的合成简历包含 C#、.NET、Docker 和上海，确认导入后自动显示三个推荐；卡片展示技术/经历命中、薪资原文、原始来源和在招状态待核实，支持地区筛选、收起、停止/重试及现有 Agent 工作台入口。

简历姓名、公司与经历是合成测试数据；推荐岗位来自现有真实来源索引，不是合成岗位，也没有重新核验当前招聘状态。139 个候选与 127 个相关岗位是截图该轮本机查询的时点数字，不代表全网穷举。使用独立测试 Origin，只读查询岗位，没有操作用户真实简历、Key 或招聘登录态，也没有发送模型请求、采集新岗位或自动投递。

原始 JPEG 直接保存，无裁切、拼接、修图或注入展示 CSS；截图本身不证明动画，实际卡片使用 240ms 淡入上移、45ms 错峰入场，并支持系统减少动态效果。文件体积、SHA-256 与验收范围见 [截图清单](resume-job-recommendations-20261031.json)。2026-10-30 的历史图片与视频继续保留，不作为本次推荐流程或动画录像。

## 简历伴写与配套运行入口 · 2026-10-30

新增三张 1600 × 1000 的真实生产构建截图，替换 README 首图并补充配套服务视图：

- [resume-copilot-20261030.webp](resume-copilot-20261030.webp)：既有简历编辑模块中的原文锚点、数字依据追问、本人补充与可编辑候选；没有调用模型。
- [agent-runtime-20261030.webp](agent-runtime-20261030.webp)：配套 Agent Host 已连接，模型待配置、CLI 为 0 可用，不冒充容器具备宿主机工具。
- [job-index-20261030.webp](job-index-20261030.webp)：自动连接隔离的新岗位数据库，真实显示 0 条和索引版本 0；不是采集覆盖证明。

使用全新浏览器会话与独立临时 Origin，运行正式 Web 构建和实际嵌入服务，仅包含应用默认合成示例。没有注入展示 CSS、拼接界面或读取私人简历/Key。由于本机 Docker 引擎当时不可用，本组素材通过宿主机运行同一生产入口捕获，不作为容器启动成功的证据。视频、尺寸及 SHA-256 见 [媒体说明](../media/README.md) 和 [清单](../media/manifest-20261030.json)。

## 历史截图 · 2026-10-18

这些截图于 2026-10-18 从项目正式 Web 构建的真实界面捕获，由 Microsoft Edge 无头浏览器渲染。桌面图保留完整工作台视口，移动图使用 390 px 视口；没有拼接界面、注入展示用 CSS 或替换功能控件。

截图中的林予 / Alex Lin、公司、学校、经历与岗位均为虚构合成内容，邮箱和外链使用 `example.test`。截图使用独立的临时 origin 和全新浏览器上下文，未读取既有浏览器的简历、历史、岗位或 API Key。导入图使用合成 TXT 经真实离线规则解析；历史图使用真实保存检查点和主题变更。截图过程未调用 AI 或访问招聘服务。

| 文件 | 像素尺寸 | 内容 |
| --- | --- | --- |
| [workspace-light.webp](workspace-light.webp) | 1600 × 1050 | 森林工作室浅色、事实编辑和实时简历预览 |
| [workspace-dark.webp](workspace-dark.webp) | 1600 × 1050 | 深色工作台，独立白纸简历保持原配色 |
| [template-gallery.webp](template-gallery.webp) | 1600 × 1250 | 119 套版式的来源筛选、搜索与真实缩略图入口 |
| [resume-themes.webp](resume-themes.webp) | 1600 × 1050 | 独立简历主题面板及暖调编辑部纸面预览 |
| [workspace-palettes.webp](workspace-palettes.webp) | 1600 × 1050 | 梅紫画室配色及顶部配色选择器，简历主题独立 |
| [opportunities.webp](opportunities.webp) | 1600 × 1300 | 四条明确标注虚构的机会、跟进安排和地点分布 |
| [import-review.webp](import-review.webp) | 1600 × 1200 | 原文提取、离线解析摘要及待补录警示；尚未确认替换 |
| [history.webp](history.webp) | 1600 × 1050 | 命名检查点、主题差异和单项恢复入口 |
| [mobile.webp](mobile.webp) | 390 × 1050 | 手机宽度下的中文内容编辑工作台 |

WebP 使用质量 90 编码，保留原始像素尺寸，逐张检查文字、主要控件和裁切。截图反映上述日期及这些合成内容下的界面，不代表全部导入格式、所有模板组合或真实招聘站点的验收结果。

## 桌面地图与办公地址截图 · 2026-10-19

[atlas-desktop-office.webp](atlas-desktop-office.webp) 为 1280×720 的真实桌面三栏与街道定位截图，使用独立 origin、合成 HTTP 和内存 SQLite。岗位、企业、来源、街址与地图候选均明确标记合成；画面中的位置不代表真实招聘或已核实办公室。经真实页面预览、独立确认、双击、撤销流程捕获；没有注入展示 CSS 或拼接界面。WebP 质量90、原尺寸，来源和哈希见 [atlas-office-manifest.json](atlas-office-manifest.json)。原真实索引和私人页面未读取。

[atlas-desktop-precision.webp](atlas-desktop-precision.webp) 是后续固定三栏与地址约束验收截图，1223×804默认视口。真实React／合成HTTP／内存SQLite完成即时单击、双击地址核对、明确保存及再次双击50m高亮；只含明确合成岗位、企业和地址。未注入布局或拼接，原尺寸WebP质量90。出处与SHA见[清单](atlas-precision-manifest.json)，不得作为真实办公地址覆盖证据。
