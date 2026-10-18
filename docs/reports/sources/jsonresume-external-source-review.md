# JSON Resume 非 Team 主题审查与适配

本轮按用户“全量接入”指令扩展到当前官网所有非 Team 主题。Kendall / Stack Overflow 见独立既有报告；这里记录剩余15项。仅下载和读取源文件，不安装或执行上游包。npm归档先验证注册表提供的SHA-512，再按固定版本与tarball SHA-1记录；源码范围不含二进制字体/图标。

| Theme | Ref | License | Result |
|---|---|---|---|
| elegant | npm 1.16.1; tarball SHA-1 7882cea1378684f76dc3aef770e15cd27ebdf4f9 | MIT | integrated-native |
| even | npm 0.26.1; tarball SHA-1 5213abd46f48ba65854c4a4eca7dccbf1d0a3bfa | MIT | integrated-native |
| flat | Git dd0155358c8d85a134d434e49834705243b5eede; packages/themes/jsonresume-theme-flat | MIT | integrated-native |
| jacrys | npm 1.0.4; tarball SHA-1 993c523d992da503d9a45a5bbd7bc1a6616cb205 | MIT | integrated-native |
| lucide | npm 1.1.0; tarball SHA-1 7f73c295c1d5ef85bdaf352906a2938d579d6cfe | MIT | integrated-native |
| macchiato | npm 1.1.0; tarball SHA-1 66d61b804b191f9402dfbe95d39d9586be5199b4 | MIT | integrated-native |
| minyma | npm 0.0.5; tarball SHA-1 609debd20376b8b319bff025543626d66b74bac7 | ISC | integrated-native |
| paper-plus-plus | npm 0.6.0; tarball SHA-1 7b052a13fb8f9183548aea26eb2f973277956592 | MIT | integrated-native |
| professional | Git dd0155358c8d85a134d434e49834705243b5eede; packages/themes/jsonresume-theme-professional | MIT | integrated-native |
| pumpkin | npm 1.1.4; tarball SHA-1 ec5dbc0f80556fdc6c12d93cbb062b5cd4543ebc | MIT | integrated-native |
| tan-responsive | npm 0.0.7; tarball SHA-1 7049b9dc06e6567e85fc97466dcabe91a24976aa | MIT | integrated-native |
| claude | Git dd0155358c8d85a134d434e49834705243b5eede; packages/themes/jsonresume-theme-claude | MIT | integrated-native |
| colophon | npm 0.2.0; tarball SHA-1 5f4ad827d81a8b907ba54737035ce0263ba8167a | MIT | integrated-native |
| creative-confidence | Git dd0155358c8d85a134d434e49834705243b5eede; packages/themes/jsonresume-theme-creative-confidence | MIT | integrated-native |
| rickosborne | npm 2022.09.16-T1450; tarball SHA-1 33537a210ad6ab334025f1fdf6270d2bd7364e26 | CC-BY-NC-SA-4.0（仅限非商业、相同方式共享） | integrated-native |

## 实际适配

15套接入同一 ProjectedResume → React 纸面，沿用现有双语投影、数据筛选、稳定预览锚点、RichResumeText、照片控制和自然分页。每套直接读取相应 CSS/LESS、模板结构、字段绑定与依赖/许可后提取特征：Even的轻字时间线、Flat的浅灰抬头与侧标、Lucide的蓝色圆角侧轨、Macchiato的轻字与细分栏、Minyma的粗章节和胶囊词条、Paper++的衬线侧标、Professional的居中专业抬头、Pumpkin的炭黑金黄横幅、Tan的灰底琥珀边注、Claude的细条/等宽日期、Colophon的大衬线名和等宽边注、Creative Confidence的深蓝身份横幅与浅蓝区，以及Rick Osborne的轻衬线姓名、右联系轨、灰圆角技能与方要点。其中Rick单独保留非商业/相同方式共享限制，不当作无使用限制的模板。

固定的原作双栏分区映射为资料侧轨或顺序正文，保留用户能移动所有分节的现有能力；不声称像素等同上游页面。不上原版示例履历、能力百分比、自动计算工龄、Gravatar、外链字体、图标或全局 reset。深色工作台不改变白纸。源站网页交互不是简历事实，因此不映射。

## 授权细节

有独立LICENSE的包逐字保留。Elegant、Lucide、Minyma、Paper++和Pumpkin等部分包只有明确SPDX许可声明；保留完整UPSTREAM_PACKAGE.json作为授权和作者证据，并在LICENSE提供规范许可全文，NOTICE明确这一文件是标准条款补全、不是“原LICENSE逐字复制”。没有编造原作者版权年份，也没有借同站目录的许可覆盖第三方。四套monorepo代码使用固定根MIT原文，保留各包原作者元数据。

Rick Osborne明确采用CC-BY-NC-SA-4.0。用户明确选择将这套受限主题一并接入，因此提供独立 `rickosborne-theme.css`、`rickosborne-catalog.ts` 和 `templates/licenses/jsonresume-rickosborne/`。原包无独立LICENSE，已从Creative Commons官方 `legalcode.txt` 取得完整规范条款，NOTICE明确其是标准许可文本而非上游原文件；原 `package.json` 逐字保留为 `UPSTREAM_PACKAGE.json`。派生主题材料维持CC BY-NC-SA 4.0，不由项目总许可覆盖。

模板目录的中英description/tag和独立 `usageRestriction` 明示仅限非商业，`licenseLabel` 保留纯许可名。署名元数据包含Rick Osborne、源主题、modified BetterMe adaptation及Noncommercial use only；现有共享renderer把它输出到预览和打印页尾，不能隐藏为no-print。库存记录准确版本、限制和许可来源，不把目录全量覆盖等同统一许可证。

## Rick Osborne 的源码细节与改动

实际读了原 `resume.css`、`index.js`、basics/contact/work/projects/skills渲染器和`fn/firstWord.js`。原主左栏60%、右栏30%，默认把姓名/教育/工作放左，把头像/联系/技能/项目等放右；可通过`meta.rickosborne`自定义layout/titles/customCSS/fonts。名字为两倍正文的轻字重，默认联网加载Roboto Slab，章节灰色大写，工作头职位优先、逗号分隔，square工作要点，技能灰底圆角。源全局reset和vw字号不能直接进入BetterMe工作台。

适配用scoped CSS，以64%主栏/30%右联系轨保留视觉关系；教育、项目、技能依当前用户节序留在正文。日期在共享标题/机构之后，未完全复制原本插在职位与机构之间的位置。不执行源customCSS，不请求Google Fonts、不载入其图标、不导入示例事实，使用现有系统字体和字号/边距/行距设置。长姓名和日期允许换行，照片遵原有开关；未在RichResumeText外另包首词斜体来改动现有富文本流。页尾署名与相同方式共享要求见单独NOTICE。

源码和CSS检查不替代实际浏览器与PDF验收；最终范围见主集成报告。
