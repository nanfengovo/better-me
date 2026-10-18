# JSON Resume 主题源码研究与原生适配

研究日期：2026-10-18。入口：https://www.jsonresume.org/themes 。本记录说明实际读取的源码、选择依据、授权和适配范围；主题目录本身不构成各个主题的统一许可证。

**范围更新**：下文记录首批 Stack Overflow/Kendall 的研究过程，暂缓 Elegant/Flat 的结论已被后续完整许可核对和用户“全量接入”要求替代。最终固定官网 65 套均有原生适配；Team 48 套见 [Team 审查](jsonresume-team-source-review.md)，另外 15 套见 [非 Team 审查](jsonresume-external-source-review.md)，其中 Rick Osborne 按用户明确选择独立标明非商业及保留署名。最终目录见 [模板清单](../../../templates/CATALOG.md)，实际验证见主集成报告。

## 目录与来源核对

官网 HTML 中真实列出 Elegant、Kendall、Stack Overflow、Flat 等主题，并将其预览指向 `registry.jsonresume.org`。Elegant 的作者链接为 Mudassir，Stack Overflow 为 Francesco Esposito，Kendall 为 M. Adam Kendall。目录还包含大量其他作者及团队主题，不能将 JSON Resume 组织、schema 或网站的许可证当作所有主题的授权。

本轮选择两套有完整 MIT 文本、视觉可区分、可适配既有 React 纸面与打印的主题。下载固定 Git revision 的源码归档，仅阅读源码，没有安装或执行主题包及构建脚本。

| 主题 | 固定上游与版本 | 完整授权 | 处理 |
|---|---|---|---|
| Stack Overflow | [phoinixi/jsonresume-theme-stackoverflow](https://github.com/phoinixi/jsonresume-theme-stackoverflow/tree/868d6db3fc322047c05e872f63a56fd026894f0a), 3.3.0 | MIT, 2019-present Francesco Esposito | 原生 React/CSS 适配 |
| Kendall | [LinuxBozo/jsonresume-theme-kendall](https://github.com/LinuxBozo/jsonresume-theme-kendall/tree/90438746fd64fc8184f439d5731a7d118660ab7a), 0.2.0 | MIT, 2014 M. Adam Kendall | 单栏原生适配，明确布局差异 |
| Elegant | [mudassir0909/jsonresume-theme-elegant](https://github.com/mudassir0909/jsonresume-theme-elegant/tree/1b38dae2f9fcdf0e4a5d03d2a737b88303ff6305), 1.16.1 | package.json 声明 MIT，但归档无独立完整 LICENSE | 深读后暂不移植；字体和图标另有边界 |
| Flat | [erming/jsonresume-theme-flat](https://github.com/erming/jsonresume-theme-flat) | GitHub API 未识别许可证 | 仅目录及仓库元数据初筛，未声称完成源码审计或移植 |

## Stack Overflow：真正值得移植的部分

- [`src/components/Resume.svelte:17`](https://github.com/phoinixi/jsonresume-theme-stackoverflow/blob/868d6db3fc322047c05e872f63a56fd026894f0a/src/components/Resume.svelte#L17) 定义分节清单，并从 `meta.theme.sectionOrder` 选择和排序；不依赖截图推断内容结构。
- [`Basics.svelte:76`](https://github.com/phoinixi/jsonresume-theme-stackoverflow/blob/868d6db3fc322047c05e872f63a56fd026894f0a/src/components/Basics.svelte#L76) 使用轻字重姓名；摘要在浅色底板中。照片、地址、联系人和社交链接各有组件。
- [`SectionHeader.svelte:22`](https://github.com/phoinixi/jsonresume-theme-stackoverflow/blob/868d6db3fc322047c05e872f63a56fd026894f0a/src/components/SectionHeader.svelte#L22) 使用横线穿过标题所在行，标题本身遮住线；英文大写与 `0.12em` 字距是识别特征，数量在打印中隐藏。
- [`TimelineItem.svelte`](https://github.com/phoinixi/jsonresume-theme-stackoverflow/blob/868d6db3fc322047c05e872f63a56fd026894f0a/src/components/TimelineItem.svelte) 将职位、机构、日期、地址、关键字和成果组合为条目，日期在宽屏和打印靠右。机构前置英文 `at` 不适于直接套到中文，BetterMe保留现有中英组合。
- [`KeywordList.svelte`](https://github.com/phoinixi/jsonresume-theme-stackoverflow/blob/868d6db3fc322047c05e872f63a56fd026894f0a/src/components/KeywordList.svelte) 以浅蓝标签显示技术词；打印清除底色并用分隔符节约墨水。
- [`styles/global.css`](https://github.com/phoinixi/jsonresume-theme-stackoverflow/blob/868d6db3fc322047c05e872f63a56fd026894f0a/styles/global.css) 提供 14px 基准、有限字体比例、4/8px 间隔、橙色章节、蓝色链接。包含全局 reset、系统深色媒体查询和固定 `@page`；这些不能原样导入宿主应用。
- [`build.js:121`](https://github.com/phoinixi/jsonresume-theme-stackoverflow/blob/868d6db3fc322047c05e872f63a56fd026894f0a/build.js#L121) 的构建入口使用 Svelte 5 SSR、fs 和完整 HTML 文档，外链 Font Awesome 和 `override.css`。直接装包进浏览器不是合适的集成方式。该构建脚本没有执行。

采用轻字重身份、标题横线、蓝色技能标签、右侧日期和方形要点。原主题的技能/语言熟练度、引用、奖励等没有对应已验证事实时不生成；不用进度条暗示能力评分。上游随源码提供的 `docs/light.png` 已作为设计核对参考观察，未复制到产品或重新分发。

## Kendall：保留设计识别点，明确单栏适配

- [`resume.template:24`](https://github.com/LinuxBozo/jsonresume-theme-kendall/blob/90438746fd64fc8184f439d5731a7d118660ab7a/resume.template#L24) 为居中照片和两行身份；`:38` 与 `:164` 分别开启原版正文与辅助列。工作块有机构/地址/日期灰底抬头，教育与联系信息在右栏。
- [`style.css`](https://github.com/LinuxBozo/jsonresume-theme-kendall/blob/90438746fd64fc8184f439d5731a7d118660ab7a/style.css) 使用深蓝灰身份、青色章节、灰底经历卡头、教育竖线以及深色技能标签。`@import` 引用 Google Open Sans，模板还引用 Bootstrap 3 与 Font Awesome 5。
- [`index.js`](https://github.com/LinuxBozo/jsonresume-theme-kendall/blob/90438746fd64fc8184f439d5731a7d118660ab7a/index.js) 直接修改传入 resume 对象、按英文月份处理日期，并用 email 构造 Gravatar 地址；此行为不进入本地优先事实链。
- [`print.css`](https://github.com/LinuxBozo/jsonresume-theme-kendall/blob/90438746fd64fc8184f439d5731a7d118660ab7a/print.css) 隐藏照片、固定 60/40 列、使用多处负边距。这些依赖 Bootstrap 文档的规则不适于直接放进当前 A4 renderer。

本轮保留居中抬头、可选圆形照片、灰底经历抬头、教育竖线、深蓝灰技能标签。原版固定双栏改为顺序单栏：用户已能拖动分节顺序，不能让选主题暗中把教育和技能移回右栏。照片遵从用户设置，打印不自动隐藏。页面边距、字号、章节间距、字体与强调色仍使用 BetterMe 参数。UI与授权说明必须称作“单栏适配”，不能描述成原版双栏完全复刻。

## Elegant：读过但本轮排除

已读 `index.js`、`package.json`、`pug/stylesheets.pug`、`assets/less/base.less`、`assets/less/print.less` 及 IcoMoon 说明。它以 Pug 与 Bootstrap 输出在线个人资料卡、背景卡片和浮动导航；数据会被 moment/markdown-it 规范化，使用外部头像工具，并带 Lato、IcoMoon 字体资产。`package.json` 虽标 MIT，当前固定归档没有独立完整 LICENSE，IcoMoon 说明也不能代替字体授权。本轮没有复制其源码、样式、字体、图标、示例或图片；不安装其运行时。以后若选择此主题，应先补足具体资产授权和版权文本，再做独立的打印适配。

## 字段映射与不补造原则

| JSON Resume 概念 | BetterMe 已有投影 | 适配方式 |
|---|---|---|
| `basics.name/label/image` | `profile.displayName/headline/avatarUrl` | 使用现有 RichResumeText 与照片开关 |
| `basics.location/email/phone/profiles` | `profile.location/email/phone/links` | 保留安全 href 和真实链接，不引入头像远程查询 |
| `basics.summary` | `profile.targetRoles/traits` | 沿用明确命名的目标与优势；不凭空串成个人摘要事实 |
| `work.name/position/startDate/endDate/highlights` | work 经历的 `org/title/start/end/claims` | 保留现有 claim 稳定 ID、原始日期与文本样式 |
| `projects` | opensource/other 经历 | 沿用项目名、机构、链接、成果和技术栈 |
| `education` | education 经历及 educationSummary | 不拆猜院校/学位/专业，无字段时不造 |
| `skills[].keywords` | `skills` 与现有 techStack | 用实际词条显示；不推断分类和熟练度 |
| `meta.theme.sectionOrder` | `sectionOrder` 与 visibility | 始终由现有投影控制 |
| `awards/certificates/languages/references` | 目前无独立对应域 | 不添加虚构段落、不用示例填补 |

这不是一个通用 JSON Resume 文件导入器，也没有宣称支持目录里全部第三方主题。两套原生适配共用当前安全的 React 渲染路径、装饰缩略图隔离、事实筛选、预览锚点与打印；没有 `dangerouslySetInnerHTML`、远程 CSS、模板运行时或新 npm 依赖。确切实测结果由本轮主验收报告记录，源码研究本身不等于所有视口与实际 PDF 已验收。

## 授权落盘

- `templates/licenses/jsonresume-stackoverflow/LICENSE` 与 `NOTICE.md`。
- `templates/licenses/jsonresume-kendall/LICENSE` 与 `NOTICE.md`。
- 两份 LICENSE 与对应固定上游文件 SHA-256 一致：Stack Overflow `A4D1D3E6AE84168E5F65E0B3357157DFECCF2E114C8C3A50A23FBBBDDF3BE3B4`；Kendall `09F4303A3FB836B733CFB0A96ECCDA365F7710D28B2C3C603C742EC8246F3AFF`。
- 上游版权及许可条件随源代码保留；不以来源目录或网站许可证覆盖其他主题。本轮未提交或推送。
