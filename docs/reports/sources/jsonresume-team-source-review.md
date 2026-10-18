# JSON Resume 官方 Team 全组源码适配

核对日期：2026-10-18。官网实际目录为65条，其中48条的源码元数据作者明确为JSON Resume Team。
固定来源revision：`dd0155358c8d85a134d434e49834705243b5eede`，仓库 https://github.com/jsonresume/jsonresume.org 。官网目录源为`packages/theme-config/src/metadata.js`，实际运行映射为`apps/registry/lib/formatters/template/themeConfig.js`。

本组48项逐项读取原始JSX/CSS（包括styled-components常量、masthead、姓名、章节、日期、技能及打印规则）；随后用共用事实渲染器进行原生CSS适配。每项均有独立源设计规则，不把一个版式重复注册成48个别名。详细文件SHA-256和上游包依赖在 `templates/jsonresume-team-source-index.json`。

目录不是许可合集。这里单独使用monorepo根MIT（2014-2026 JSON Resume contributors），检查所选Team目录没有覆盖许可证。未把其他作者外部包视为同授权。部分package.json的license为空，索引如实记录，适用根LICENSE。

本轮未安装或运行上游styled-components、marked、Prism、Twind、Radix、React Icons和构建器。保留本地事实、筛选、分节排序、字符格式、安全链接、照片开关、预览锚点、主题色、字形/字号/间距与页边距。原版缺乏对应事实的技能评分、Key Metrics、证书、推荐信和论文等不会补造。

| 主题 | 上游包版本 | 读取后采用的设计依据 | 主要适配边界 |
|---|---|---|---|
| Desert Modern | 0.1.5 | 暖沙色抬头、宽字距章节与轻线条。 | System fonts replace upstream web fonts; user section order is retained. |
| Elegant Pink | 0.1.5 | 玫瑰渐变身份栏、醒目的姓名和浅色技能块。 | System fonts replace upstream web fonts; user section order is retained. |
| Tailwind | 0.0.0 | 轻量身份栏、等宽日期与圆角细框标签。 | System fonts replace upstream web fonts; user section order is retained. |
| Academic CV Lite | 0.2.4 | 居中学术抬头、纯文字层级与细线分节。 | System fonts replace upstream web fonts; user section order is retained. |
| Bold Header Statement | 1.1.4 | 深青身份横幅、粗体大字和线框技能块。 | System fonts replace upstream web fonts; user section order is retained. |
| Architect's Portfolio | 1.1.4 | 轻字重几何抬头、长横线与细框标签。 | System fonts replace upstream web fonts; user section order is retained. |
| Consultant Polished | 1.0.3 | 深海军蓝标题、衬线推荐字体和稳健双线层级。 | System fonts replace upstream web fonts; user section order is retained. |
| Creative Studio | 1.1.3 | 珊瑚色浅底抬头、圆角标签与柔和卡片。 | System fonts replace upstream web fonts; user section order is retained. |
| Data-Driven | 0.2.4 | 几何大写抬头、数字日期与细框技能标签。 | System fonts replace upstream web fonts; user section order is retained. |
| Developer Mono | 0.2.5 | 等宽身份、代码块式技能区与蓝色强调。 | System fonts replace upstream web fonts; user section order is retained. |
| Executive Slate | 1.1.4 | 石板色资料侧栏、清楚的正文与技能强调线。 | The original category assignments become a profile-only rail; every resume section keeps the user-selected sequence. System fonts replace web fonts. |
| Government Standard | 0.2.4 | 居中正式身份、粗细分明的横线与黑白结构。 | System fonts replace upstream web fonts; user section order is retained. |
| Marketing Narrative | 0.2.4 | 居中身份、玫红定位与叙事感的经历块。 | System fonts replace upstream web fonts; user section order is retained. |
| Minimalist Grid | 0.2.4 | 轻字重、大字距、细线和留白。 | System fonts replace upstream web fonts; user section order is retained. |
| Modern Classic | 1.1.4 | 清楚的姓名层级、细灰分节与侧线技能块。 | System fonts replace upstream web fonts; user section order is retained. |
| Operations Precision | 0.3.4 | 紧凑抬头、青色横线与表格式技能区。 | System fonts replace upstream web fonts; user section order is retained. |
| Product Manager Canvas | 0.2.4 | 居中身份、紫色定位与清晰的线框卡片。 | System fonts replace upstream web fonts; user section order is retained. |
| Reference | 0.2.4 | 中性的居中身份、标准文字层级与自然阅读。 | System fonts replace upstream web fonts; user section order is retained. |
| Sales Hunter | 0.2.4 | 强势大写身份、绿色粗线和实色技能标签。 | System fonts replace upstream web fonts; user section order is retained. |
| Sidebar | 0.2.4 | 深蓝资料栏、主栏清楚分节与开放正文。 | The original fixed skills/sidebar category split becomes a profile-only rail, preserving all section order. System fonts replace web fonts. |
| Tokyo Modernist | 1.0.7 | 品红侧线、几何切角与利落大写身份。 | System fonts replace upstream web fonts; user section order is retained. |
| University First | 0.2.4 | 蓝色居中身份横幅与轻巧的分节。 | Education is never automatically moved ahead of another section: the user-selected order remains authoritative. System fonts replace web fonts. |
| Writer's Portfolio | 0.2.4 | 居中衬线推荐字体、文学留白与细侧线。 | System fonts replace upstream web fonts; user section order is retained. |
| Nordic Minimal | 1.1.4 | 轻字重身份、冷灰横线与宽松的视觉节奏。 | The source multi-column category layout is adapted to sequential sections to preserve user ordering and print flow. System fonts replace web fonts. |
| Graph Paper Grid | 1.1.4 | 细网格背景、线框抬头和技术标签。 | System fonts replace upstream web fonts; user section order is retained. |
| Monochrome Noir | 1.1.4 | 黑白强对比、大写粗字和极细分隔。 | System fonts replace upstream web fonts; user section order is retained. |
| Mid-Century Resume | 1.1.4 | 复古几何身份、琥珀粗线与居中线框标签。 | System fonts replace upstream web fonts; user section order is retained. |
| Two-Column Modernist | 1.1.4 | 非对称资料栏、细分隔线与中性标签。 | Only profile data occupies the asymmetrical rail; section categories remain in the main column in user order. System fonts replace web fonts. |
| Sidebar Photo Strip | 1.1.4 | 深色照片资料栏、灰度头像与轻量正文。 | The source profile photo strip is retained; skills and education remain in user-selected order rather than being fixed to the rail. No photo is fabricated. |
| Diagonal Accent Bar | 1.1.4 | 玫红斜向边线、宽字距身份与侧线标签。 | System fonts replace upstream web fonts; user section order is retained. |
| Asymmetric Timeline | 1.1.4 | 居中身份、交错缩进经历卡片与细时间线。 | The original alternate half-width timeline becomes staggered sequential cards, retaining reading order and long-content print flow. |
| Typewriter Modern | 1.1.4 | 打字机推荐字体、虚线分节与纸张感标签。 | System fonts replace upstream web fonts; user section order is retained. |
| New York Editorial | 0.2.5 | 重衬线推荐身份、居中横线与红色细节。 | System fonts replace upstream web fonts; user section order is retained. |
| Berlin Grid | 0.2.5 | 工程化粗横线、矩形技能网格与精确对齐。 | System fonts replace upstream web fonts; user section order is retained. |
| Californian Warm | 0.2.5 | 暖琥珀圆角身份栏、轻阴影与柔和标签。 | System fonts replace upstream web fonts; user section order is retained. |
| London Bureau | 0.2.5 | 传统衬线推荐身份、三重层级横线与紧凑正文。 | System fonts replace upstream web fonts; user section order is retained. |
| Pacific Horizon | 0.2.5 | 居中现代身份、蓝色短线和开放式技能组。 | System fonts replace upstream web fonts; user section order is retained. |
| French Atelier | 0.2.5 | 高对比衬线推荐身份、梅紫色细线与编辑节奏。 | System fonts replace upstream web fonts; user section order is retained. |
| Clinical Precision | 0.2.5 | 病历式抬头、绿色条目轨、等宽日期和薄荷技能格。 | System fonts replace upstream web fonts; user section order is retained. |
| Field Researcher | 0.2.5 | 笔记式分节编号、等宽元信息与青绿色页边线。 | System fonts replace upstream web fonts; user section order is retained. |
| Urban Techno | 0.2.5 | 黑色分割身份栏、硬边框与密实的技术标签。 | The source dense two-column body is adapted into sequential sections. The split identity bar is retained without changing factual reading order. |
| Coastal Creative | 0.2.5 | 平静居中身份、海蓝色标题与柔和技能卡片。 | System fonts replace upstream web fonts; user section order is retained. |
| Investor Brief | 0.2.5 | 居中简报身份、紧凑数据层级与浅灰技能块。 | No Key Metrics section or numerical achievements are inferred; only the user-provided facts are rendered. |
| Art School Modern | 0.2.5 | 画廊式粗字身份、编号章节与朱红细节。 | System fonts replace upstream web fonts; user section order is retained. |
| Community Garden | 0.1.6 | 天空蓝与浅绿身份面板、圆角技能块和亲和留白。 | Volunteer and certificate facts are not inferred or promoted ahead of the user-selected sections. System fonts replace web fonts. |
| Industrial Engineer | 0.2.5 | 图纸铭牌抬头、规格表联系人与尺寸线分节。 | System fonts replace upstream web fonts; user section order is retained. |
| Brutalist | 0.2.5 | 硬黑粗线、编号章节与错位块阴影。 | System fonts replace upstream web fonts; user section order is retained. |
| Art Deco | 0.2.5 | 对称珠宝色身份、金色双线与几何装饰。 | System fonts replace upstream web fonts; user section order is retained. |

多栏类别分配不会抢走用户排序：Executive Slate、Sidebar、Two-Column Modernist、Sidebar Photo Strip仅将个人资料放在侧栏，正文分节依用户顺序；其他原多栏主题按单栏顺序适配。照片侧栏只展示已有照片，不网络补图。Asymmetric Timeline为顺序交错卡片，打印移除横向缩进；University First不擅自将教育移到最前。

活跃性按固定仓库元数据记录：非归档，最近push为2026-09-09；没有逐主题查询最后commit，不将共享repo更新当每套主题均持续维护。源码读取与CSS编译不代替实际逐模板PDF/视口验收，最终验证见主报告。
