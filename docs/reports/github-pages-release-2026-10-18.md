# GitHub Pages 首次上线与 CI/CD · 2026-10-18

用户最终选择 GitHub 托管。BetterMe 已发布为 [GitHub Pages 在线工作台](https://nanfengovo.github.io/better-me/)，并在现有仓库接入 GitHub Actions。没有修改已有产品源码、原 localhost 服务或私人浏览器数据；本轮交付是静态部署、持续检查与公开项目说明。

## 发布内容

| 批次 | 提交 | 内容 |
| --- | --- | --- |
| CI/CD | [`6117c30`](https://github.com/nanfengovo/better-me/commit/6117c30) | Windows 质量检查、Linux 完整构建及 Pages 子路径产物、验证后部署；部署/迁移/回滚说明 |
| 项目展示 | [`1cde3f2`](https://github.com/nanfengovo/better-me/commit/1cde3f2) | 完整中文 README、9 张真实合成界面截图及尺寸/哈希清单、分阶段开发路线图 |
| 上线收尾 | 见本报告所在提交 | 真实体验链接、工作流状态徽章、公网验收及记忆停点 |

9 张 WebP 合计 852,728 bytes，约 833 KiB，保留原像素尺寸。截图来自真实生产构建与全新 Edge context，使用虚构履历和岗位，未调用模型或招聘服务。README 展示编辑、明暗工作台、119 套目录、独立主题、机会区、版本差异、导入核对与手机界面；详细来源见 [截图说明](../images/README.md)。已在 GitHub README 页面检查图片实际加载。

## 真实 GitHub Actions 结果

[首次运行 39124587077](https://github.com/nanfengovo/better-me/actions/runs/39124587077) 由推送 `1cde3f29b75f51b9150c817f37a4b205d72e32cd` 触发，三个任务均为 `success`，部署于 2026-10-18 11:49:10 UTC 完成。

| 任务 | 结果与范围 |
| --- | --- |
| Windows / Edge 质量 | 锁文件干净安装、memory 文件检查、Lint、类型检查 5/5、全量测试 1251/1251；fail/cancelled/skipped/todo 均 0 |
| Linux / Pages 构建 | 锁文件干净安装、完整 workspace 构建、Vite `/better-me/` 构建及静态产物上传全部通过 |
| GitHub Pages 部署 | 前两项成功后发布本次产物，Pages Source 已设为 GitHub Actions，使用默认 HTTPS 域名 |

Node 固定 24.15.0，pnpm 由 packageManager 固定 11.9.0；官方 Actions 固定 commit SHA。普通任务仅只读仓库，部署任务单独获得 Pages/OIDC 权限，不使用 PAT 或第三方云服务 Secret。PR 只执行验证和构建；main push 或 main 手动运行才部署。检查失败不执行部署。

CI 包含本地合成 Edge 回归，未访问真实招聘站、执行真人验证或调用真实模型。memory 检查只证明约定文件存在。既有大包提示仍保留，未开展新的性能基准。

## 公网浏览器验收

本机 Windows 使用全新临时 Headless Edge context，目标为真实公网 HTTPS 地址，使用内置合成示例和现场生成的 PDF。检查于 2026-10-18 11:50:22 UTC 完成：

1. 首页 HTTP 200，React 挂载，主 CSS / JS 正常加载。
2. 选择 `editorial` 模板与 `editorial-warm` 简历主题，切换藏蓝工作台及深色；纸面颜色独立，保存刷新后选择保留，Fact 逐字段不变。
3. 实际下载 JSON 备份，复核模板、主题与完整合成事实。
4. 打开导入弹窗，按需模块从项目子路径成功加载；上传合成 PDF，实际提取两段预期正文，PDF worker 从 `/better-me/assets/` HTTP 200 加载。
5. 共 12 个响应全部 HTTP 200，包括原有 Google Fonts CSS / woff2；运行时错误 0、请求失败 0、意外请求 0。

首次验收脚本只放行本站，因拦截既有 Google Fonts 请求而未通过末尾请求失败断言。原回执保留；仅扩充测试允许的官方字体域后重新完整执行通过，产品未作修改。不能把测试拦截解释为站点已修复字体问题，也不保证其他网络环境始终能加载远程字体。

本地另已用独立 origin 验证同一 `/better-me/` 路径、动态模块、实际 PDF 提取/worker 和刷新。公网结果与本地结果分别记录，没有以本地构建替代真实部署。原始脚本、JSON 回执、合成下载及截图在本机 Git 忽略的 `.agent-memory/.tmp/pages-subpath-2026-10-18/`，不发布机器路径或个人资料。主浏览器亦已实际打开在线站点并保存上线画面。

## 能力与后续边界

静态站点提供简历编辑、模板/主题、浏览器保存、导入导出及手动机会管理。岗位提取、公司源、网络接口和持久 Windows Edge 继续使用本地 Node/Vite 服务；这次没有部署后端或自动迁移为云函数。

线上与 localhost 是不同 origin，简历/历史/Key 不自动同步。发布只更新应用；迁移使用 JSON 备份，AI 配置单独填写。云模型仍受服务商费用、CORS 和网络限制，本机模型另受 HTTPS 与本地网络策略约束。

本轮没有重做所有模板/主题的长文 PDF、Word 逐页视觉、全浏览器或物理打印验收，也没有验证真实模型生成、真实岗位长期覆盖、跨设备同步。既有验收与待办继续保留。日常发布、回滚和免费层取舍见 [部署说明](../deployment.md)，下一阶段见 [路线图](../ROADMAP.md)。

## 附录：地图与来源工具的本地 Pages 子路径复核 · 2026-10-18

本附录仅记录本地发布产物检查，前文真实公网历史验收保持独立。本次 `pnpm build` 六个任务成功，随后 `pnpm --filter @better-me/web exec vite build --base=/better-me/ --outDir <隔离输出目录> --emptyOutDir` 成功。根路径与子路径产物均通过 `scripts/check-atlas-distribution.mjs`：13 项公开地理白名单、三份 GeoJSON hash、518,806 字节的原始 ESM MapLibre worker 全部一致。

在随机 loopback 端口使用独立 Vite preview 检查 **31/31 HTTP 请求**，包括首页 `/better-me/assets/` 引用、地理声明及数据、9 个 JS chunk、CSS 和 MapLibre worker。worker Content-Type 为 `text/javascript`；来源工具独立延迟模块存在，所有 JS chunk 均无 `node:` import 和 Vite Node 外部模块占位。服务器检查结束即关闭，没有占用原 5173 / 8080。这里未进行实际浏览器操作或在线瓦片访问。

初始 340 文件检查快照聚合 SHA-256 `5eea46cbf7c28e17722f7c663446dc64748fc3b3c1b9c8f2e4e62565ba370583`；末尾聚合 hash `23ea84813acc39da5dc58a4da252cfb4c847432c8f6049623fecb858147818d1`。期间两处并行 UI 文件变更已在本地逐文件 hash 清单中保留，没有把早期构建结果外推为所有后续改动的验收。命令、产物、请求回执和 hash 证据位于 Git 忽略的 `.agent-memory/.tmp/atlas-sources-distribution-2026-10-18/`。该目录最初因命令中相对路径多一层 `../` 输出到相邻位置，核实精确目录后已原样移入本项目验收目录；未重新编译来隐藏检查路径修正。

同轮 Docker 的 269 次 HTTP、96 项模板许可目录、20 项改编源码、95 个依赖及 97 份许可检查见 [Docker 报告附录](docker-release-2026-10-18.md#附录岗位地图与来源工具分发复核--2026-10-18)。Docker frontend registry 网络失败与临时副本回退已明确记录。这些本地检查不代表本次已经推送、真实 Actions 成功或公网 Pages 已更新，也不替代后续公网浏览器、招聘来源、在线地图与长文打印验收。

本附录现固定为**来源工具阶段的已验历史快照**。用户随后反馈搜索 / 筛选行为不足，已开始新的腾讯真实国内远程搜索、主搜索入口及覆盖范围提示修订；这些新改动尚未包含在上述 Pages / Docker 检查中。后续必须以新的定点源码检查记录为准，当前结果不称为整个岗位搜索目标的最终验收。
