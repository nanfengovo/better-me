# 原创学习验收资料

四份三页 PDF 的正文由 BetterMe 编写，只用于合成验收，不包含用户简历、求职数据或第三方教材。

| 文件 | 验收用途 |
| --- | --- |
| `checkpoint-notes-v1.pdf` | 可选择正文、页码、原文高亮与成功回执练习 |
| `checkpoint-notes-v2.pdf` | 同名修订版不能覆盖已冻结的版本与引用 |
| `checkpoint-notes-mixed.pdf` | 第一页有文字层，第二、三页是扫描图；逐页拒绝伪成功 |
| `checkpoint-notes-columns.pdf` | 第二页为双栏；标为需人工核对，不承诺阅读顺序正确 |

PDF 内嵌 Noto Sans SC 的子集，避免依赖系统 CJK 字体映射。来源为 Google Fonts 官方仓库：

- 提交：`a85815a42757630ce188fdad368c2dfc444d4773`
- [字体文件](https://github.com/google/fonts/blob/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf)
- 原始文件 SHA-256：`a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- Copyright 2014–2021 Adobe；Reserved Font Name: Source。字体使用 SIL Open Font License 1.1；完整许可见 [OFL.txt](./OFL.txt)。正文不属于字体许可约束。

不提交整个字体，也不在生成器或测试中自动下载字体。需重新生成时，先自行取得上述固定版本的字体，然后从仓库根目录运行：

```sh
BETTERME_FIXTURE_CJK_FONT=/absolute/path/NotoSansSC.ttf uv run --with reportlab --with fonttools scripts/create-learning-fixtures.py
```

生成器核验字体哈希，冻结变量字体字重、关闭时间戳变化，并生成可重复的内嵌子集。测试直接使用已提交的 PDF，不依赖字体、Python、网络或 GPU。原文渲染需同时检查 PDF.js 和独立的 Poppler 渲染，不能只因提取到文字就判定原文可见。
