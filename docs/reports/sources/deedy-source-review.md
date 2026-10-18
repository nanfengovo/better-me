# Deedy 中文源码阅读与适配依据

固定来源：
[`dyweb/Deedy-Resume-for-Chinese@3fe0e55a52ad3a96958b1bcd3c8e4674fc72f5ce`](https://github.com/dyweb/Deedy-Resume-for-Chinese/tree/3fe0e55a52ad3a96958b1bcd3c8e4674fc72f5ce)。
逐个读了 README、完整 Apache-2.0 LICENSE、中文版 tex/class 与英文 OpenFonts
class。MacFonts 的 class 用于边界核对，README 明确该版不再维护。没有执行
XeTeX、下载字体或使用源人物资料。

## 原设计的真实特点

中文 `resume.tex` 把正文放在两个不可分页的 minipage：左宽 25%，右宽 73%。
左栏硬编码教育、链接、技能，右栏硬编码实习、研究/项目、贡献与奖项。
源文件注释自己记录了列内容过多会溢出第二页的问题。不能原样把其固定
一页布局套到可自由增减、调整顺序的 BetterMe Fact 数据上。

中文版 `deedy-resume-openfont.cls` 的主正文为思源宋体 Regular，名字 **30/30pt、
思源宋体 Bold**；英文 OpenFonts 才是 SourceSerifPro-Light。中文章节为 16/24pt
scshape 宋体 Bold，机构为 12/12pt Medium，职位/描述与日期为 10/10pt 常规体；
`sectionsep` 8pt，紧列表 itemsep 1pt。联系方式 11pt，姓名下有 .4pt 通宽细线。
主要色 `#2b2b2b`、章节 `#6a6a6a`、子标题 `#333333`、日期 `#666666`，没有
彩色侧栏或花纹。字体是其排版组成部分，不能把普通英文无衬线侧栏换个
名字就称作 Deedy 中文版。

## 浏览器中的明确改动

`deedy-catalog.ts` 提供独立 `deedy` 社区模板，推荐灰色与系统 serif。
`deedy-theme.css` 限定该 ID：保留居中衬线姓名和 .4pt 细线、中文粗/英文轻
姓名差异、宋体小型大写章名、机构/职位/日期三层关系与紧要点。
姓名大小、正文大小和行距仍沿用 BetterMe 可调设置。

全宽身份抬头之后是 25% 个人资料轨，正文以正常文档流和 margin 保持右栏。
左栏只承载当前已显示的个人资料和链接；教育、技能和经历继续按用户选择
的章节顺序出现在正文。元数据、NOTICE 和代码头均说明这一布局改动，
不宣称等同原版固定语义分栏。共享照片开关仍可显示用户照片，但原版没有
照片，因此该差异同样明确记录。无需固定页面高度、绝对日期位置或 minipage，
长内容可沿正文进入下一页。

不添加原版示例姓名、联系方式、分级代码行数、论文、奖项或当前更新时间。
模板切换不修改 Fact；字号、颜色、页边距由原设置继续控制。

## 许可与字体

仓库 LICENSE 为 Apache-2.0，已完整保留在 `templates/licenses/deedy/LICENSE`。
appendix 是通用年份/姓名占位，不能自行补造原版权年份。tex 的真实署名是
Debarghya Das，原仓库 deedydas/Deedy-Resume；中文维护来自 dyweb/gaocegege。
NOTICE 记录这些来源及具体修改。所有派生 CSS 的头部醒目标注为 Modified
browser adaptation。

README 明确「字体部分详见其对应开源协议」。审查 tree 可见思源 Sans/Serif
和 Source Sans/Serif Pro OTF，但该 tree 没有独立字体 LICENSE/OFL；不能据此
用 Apache-2.0 给字体授权。它们没有被下载或打包，macOS 字体亦未复制。
系统字体只是视觉替代，不能承诺与源字体度量相同。

本报告是源码与适配依据。中文/英文名字字重、窄轨长链接、照片开关、章节
排序和两页以上真实打印由统一集成验收覆盖；本报告不声称这些运行验收已通过。
