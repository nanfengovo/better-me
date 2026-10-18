# 开源简历来源全量接入 · 2026-10-18

用户先要求深入阅读 NewFuture/CV、RenderCV、JSON Resume themes 与 awesome-resume-for-chinese，随后明确要求“全量接入”。本轮从固定源码/目录快照核对实际纸面主题，完成可选择、可实时预览、可由浏览器打印的原生适配。已有未提交的纸张工作室 UI 改动保留；没有提交或推送。

## 最终范围与计数

实际注册表共有 **119 套**：保留 6 套自研，新增 113 套来源适配。JSON Resume 官网清单是有限的固定快照，不表示 npm 或 GitHub 上全部以 JSON Resume 命名的项目。

| 来源 | 实际版式数 | 全量口径与源码依据 |
| --- | ---: | --- |
| BetterMe | 6 | 原有六套自研布局保留 |
| RenderCV | 9 | 固定 2.8 源码全部内置主题；revision `1d4b87bc427e4cf61c0ef49623c971b0e2224708` |
| JSON Resume | 65 | 官网固定目录全部 65 套：Team 48、其他作者 17；目录 revision `dd0155358c8d85a134d434e49834705243b5eede`，第三方包另固定版本与归档校验 |
| NewFuture/CV | 3 | 基础、flex、block 三种真实源码打印配置；revision `748b54d843fab4347a82943967ba8eedbeaa4ae6` |
| 社区 | 36 | billryan 1、best-resume-ever 17、Deedy 中文 1、另外 17 套；由 awesome 索引逐项发现并核对 |

awesome 的固定 revision 为 `fefc06e7dd667ff78bf7c5cccad715efddaef15f`。31 个顶层入口中，19 个已实现的实际来源合计贡献 39 套，其中包含上述 NewFuture 的 3 套；不能再加一次重复计数。其余 12 个入口保留准确状态，包括重复生态入口、工具/交互个人站、404、缺少模板授权或禁止模板单独再分发。best-resume-ever 的 18 个 Vue 文件中，`template.vue` 是空开发骨架，因此实际为 17 套。

实际 ID、名称、推荐参数、来源和许可见 [可读全目录](../../templates/CATALOG.md) / [机器清单](../../templates/catalog.json)。独立来源依据见 [官网快照](../../templates/jsonresume-catalog-source.json)、[Team 文件与哈希清单](../../templates/jsonresume-team-source-index.json)、[非 Team 库存](sources/jsonresume-external-inventory.json) 和 [awesome 全 31 项库存](sources/awesome-template-inventory.json)。

## 实际源码工作与实现

读取各主题真正控制版式的 CSS/LESS/Sass、React/Svelte/Vue/Handlebars/Liquid 或 TeX/Typst 源文件，同时核对字段绑定、依赖、打印规则与许可。固定 Git revision 或 npm version/tarball 校验保存在各源 NOTICE。没有执行上游安装、构建脚本、渲染引擎或包运行时。

沿用 `FactBase → ProjectedResume → ResumeTemplate → 实时预览 / 浏览器 PDF`。来源适配在独立的、按 template ID 限定的 CSS 中实现；同一安全 React 组件保留文字格式、稳定 ID、预览定位、可见性、分节顺序和真实内容。每套有实际样式，图库由固定双语匿名内容生成真实 A4 缩略图。

这不是上游引擎的逐像素复制。原版固定分栏与栏目分配按当前事实模型适配为资料轨或可排序正文；精确差异在逐源 NOTICE。使用系统字体，不捆绑上游字体、照片、图标、二维码或示例人物履历。源主题的评分表、语言等级、引用、论文或专门报考字段，没有对应事实时不生成，不推断学位、技能分数或工龄。

模板库提供五组来源、名称/来源/风格搜索、每页最多 12 张缩略图、分页状态和当前选择详情。切换只改 template ID 与更新时间；事实、输出语言、可见性、格式、排序及用户排版设置保留。“采用推荐配色与字形”是显式动作，只更新这两个参数。

RenderCV YAML 将全部 9 套 RenderCV 模板 ID 映射到对应上游主题，其他模板回落 classic 并显示诊断。当前网页颜色/字号/间距/局部格式和照片未完整映射。未安装 RenderCV/Typst，也未宣称验证其引擎输出。DOCX 继续输出可编辑单栏，Markdown 继续输出内容，二者不复制这些来源 CSS。

## 许可与用户明确选择

每个来源保留完整 LICENSE 与 NOTICE；适用许可包括 MIT、ISC、Apache-2.0、LPPL-1.3c、CC BY-SA 和 CC BY-NC-SA。源文件独立许可与根许可分别核对。部分 npm 包只提供明确 SPDX 声明而没有独立 LICENSE：保留原 package 元数据及作者，补标准全文，并明确文件来源，没有声称是原包独立许可原文，也未编造版权年份。

用户明确选择将 **Rick Osborne** 接入，并单独标明非商业许可、保留导出署名。因此该主题以独立 CC BY-NC-SA 4.0 许可单元提供，卡片和选中详情明确显示“仅限非商业使用 / Noncommercial use only”，预览与 PDF 页尾保留作者、来源、修改声明和许可链接。另两套 CC BY-SA 样式亦保留纸面署名。它们没有被当作 MIT 或无限制商用主题。许可证适用单元见 [模板授权说明](../../templates/README.md) 和 [逐源条款](../../templates/licenses/)。

用户允许使用受限主题不等于替其他作者授权；awesome 中禁止模板单独再分发、没有明确模板许可或无法获取源码的条目继续如实列出，没有复制商业站或把无授权条目伪称已实现。根项目整体许可证仍由维护者决定，本轮不替其选择。

## 验证记录

模板集成基线的全量回归为 **1212 / 1212**，fail / cancelled / skipped / todo 全 0；lint 通过，typecheck **5 / 5**，build **3 / 3**。目录/受限许可保护已包含在该全量中。最终局部打印修正及 Deedy 许可标记更新后，模板与 RenderCV 出口的定向回归 **30 / 30** 通过。测试覆盖全部注册主题的事实保真、长文本尾部、隐藏/顺序、格式、安全转义、锚点/装饰隔离、切模板/显式推荐、来源分页和全部 RenderCV YAML 主题映射。

收尾时另一个会话正在同一工作区实施独立的简历主题与工作台主题系统，本轮保留其改动。针对当前共享工作区重新执行全量测试 **1251 / 1251**，fail / cancelled / skipped / todo 全 0；lint、typecheck **5 / 5** 与 build **3 / 3** 通过。主题迁移期间的一次构建曾因差异文案映射缺项失败，相关映射补齐后重跑通过；先前失败日志保留。此处当前回归数字包含并行主题系统新增测试，不将其实现归为本轮模板交付，也不将模板基线的 PDF 验收扩大为所有新主题组合已验。

独立官网快照的 65 个 slug 与实际 JSON Resume ID 一一相等，awesome 的 31 项库存及所有声称实现的 ID 均检查。全部 113 个来源适配均具有可用 LICENSE/NOTICE 路径；Deedy 明确显示 Apache-2.0，Rick 明确显示非商业许可。

真实浏览器验收使用独立 origin 和合成双语履历。1440 / 1280 / 768 / 390 px 中文浅色，以及 1440 / 390 px 英文深色共 **6 组**；每组实际选择全部 65 套 JSON Resume 主题，累计 **390 次切换**。来源计数与筛选、6 页 JSON Resume 目录、精确搜索/空结果、显式推荐样式、保存刷新及事实/排版保留合计 **30 组功能检查**通过；稳定复验中页面横向溢出、简历文字横向越界和运行时错误均为 0。早期因共享构建与热更新中断的案例保留记录并完整重跑，没有把中断项计作通过。各来源的其余主题另由全部注册表测试和实际 PDF 覆盖。

最终实际生成 **126 份 PDF，共 416 页**：全部 119 套模板各一份中文 16 mm 页边距长简历，另有 ModernCV、NewFuture 基础/flex/block、Kendall、Opal 和自研 Sidebar 共 7 份英文 28 mm 压力案例。合成内容含 5 段工作、2 个项目、1 段教育、26 条长要点、52 个起止标记与末尾教育标记。所有案例的预期正文、标记和必要署名完整，工作台 UI 泄漏、运行时错误及实际栅格墨迹越出所选边距均为 0。每页经 Poppler 渲染，并逐页打开联系图目视检查。

实际打印发现并修复三类局部问题：Material Dark 两套变体的项目标题/长链接/技术栈跨页拆散；liweitianux 与 Pandoc 日期轨过窄而把月份挤到独立一行；NewFuture 英文侧标词内拆行。修正只作用于对应模板命名空间，受影响 PDF 已重新生成并复核。Material Dark 的保组规则使本压力样本最后一页只保留完整教育块，是密度取舍；没有孤立标题或空白页。超出整页的条目仍允许浏览器分割，不强制删字或缩成一页。

PDF 正文检查使用 Unicode NFKC、空白规范化及大小写折叠；已核实 SimSun 的个别汉字抽取为兼容部首，额外将 `⻓` 对应到 `长`，不声称字节完全一致。侧栏空间提取可能交织，另以 PDF 文字流检查完整内容。个别字体描述符的几何字框仍有告警，但对应实际渲染墨迹在边距内，目视未见裁切；这些检查不构成 ATS 认证。

验收未修改原 localhost:5173 页面内容、浏览器存储、服务或网络配置。浏览器记录位于本地忽略目录 `.agent-memory/.tmp/template-sources/ui-qa-final-report.json`；逐组 PDF 视觉记录同样保留，最终聚合为 `summary-final.json` 的 126 份 / 416 页、失败数组为空。截图、PDF、提取文本和验证脚本为本地验收产物，不含私人履历或 API Key，也未加入 Git。

构建仍有大块体积提示。模板基线 CSS 344.66 kB、主 JS 892.21 kB；包含并行主题系统的当前构建 CSS 390.72 kB、主 JS 922.95 kB、按需导入块 852.98 kB，均为构建输出的 gzip 前大小。来源 CSS 目前统一加载，图库只渲染当页最多 12 张；本轮未做性能基准。画面与 PDF 结果限当前 Windows / Edge、系统字体和所列合成案例，不外推任意内容、其他字体/浏览器、物理打印机、DOCX 同版、上游 RenderCV 引擎或任意新主题与模板组合。

## 源码研究记录

- [RenderCV 全部内置主题](sources/rendercv-source-review.md)
- [NewFuture 三种布局及 awesome 完整审查](sources/newfuture-awesome-source-review.md)
- [JSON Resume 初始两套源码研究](sources/jsonresume-source-review.md)
- [JSON Resume Team 48 套](sources/jsonresume-team-source-review.md)
- [JSON Resume 其他作者 15 套扩展](sources/jsonresume-external-source-review.md)
- [best-resume-ever 17 套](sources/best-resume-ever-source-review.md)
- [Deedy 中文](sources/deedy-source-review.md)
