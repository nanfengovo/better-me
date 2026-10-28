# 2026-10-29 模块化代码交付清单

分支：`feature/atlas-3d-modular-20261029`。基线：`b4c96e9`（原 agent-os）。本次把之前累积的本地改动和本轮三维接入整理成模块提交；不是声称所有模块均为本轮新写。

不覆盖 main，不更新原工作目录分支，不重启原有 Web/岗位/Agent 服务，不刷新当前页面。代码保存在独立工作树。最终 README、研究/报告与此清单在最后的文档提交中。

## 提交顺序

| 模块 | 提交 | 文件数 |
| --- | --- | ---: |
| Agent Runtime / 契约 / Run / 编排 | [ae31aa4](https://github.com/nanfengovo/better-me/commit/ae31aa471613eaaa7b6bafca6896b62c4373526a) | 27 |
| 岗位服务：后台补全、计算隔离、增量投影与同步 | [fb076a7](https://github.com/nanfengovo/better-me/commit/fb076a7152299cd461c9315bd64ac7c7a0725ba7) | 36 |
| 查询索引与规模回归 | [c6a3503](https://github.com/nanfengovo/better-me/commit/c6a350367ea8545efcdf587ada1102167c74970e) | 10 |
| 流式采集、回执、检查点与恢复 | [2e4f4d3](https://github.com/nanfengovo/better-me/commit/2e4f4d30818993807feaf5f1c562e4e4bfc6cbf3) | 37 |
| 浏览器 Worker / revision 同步 | [12c0775](https://github.com/nanfengovo/better-me/commit/12c07755dff3d315b9f31555ce917e0a5419a304) | 18 |
| 草稿保护与历史恢复 | [9f48012](https://github.com/nanfengovo/better-me/commit/9f480125b127058332e0290475250aea0e1c21c1) | 3 |
| Agent 伴侣、授权上下文与品牌艺术资产 | [9dd9f48](https://github.com/nanfengovo/better-me/commit/9dd9f48f558663a3804e507ae86b3119f6f3ba13) | 28 |
| 单入口本机服务生命周期 | [7acb1b3](https://github.com/nanfengovo/better-me/commit/7acb1b3ed192d5f0e423259cc791d214654d9fcb) | 7 |
| Cesium / Google 或授权 3D Tiles | [e42e176](https://github.com/nanfengovo/better-me/commit/e42e176f2aeeecfe726e99a0898b4610178b5ee5) | 15 |
| 灵活布局、可读状态与地图控件 | [a6a9d6b](https://github.com/nanfengovo/better-me/commit/a6a9d6bbab2f76860a0106cb842bd562e7a954bb) | 58 |
| 工作台集成与隔离合成验收 | [e26470e](https://github.com/nanfengovo/better-me/commit/e26470e701fc0038713e923f1af660b95460812f) | 23 |
| README、分阶段报告、研究与忽略规则 | 本清单所在文档提交 | 以 Git diff 为准 |

模块间依赖仍存在：共享 App/AtlasWorkspace 入口、依赖清单和最终接线分别归入对应提交。拆分用于审阅、追踪和选择后续工作，**不保证任一中间提交单独可构建，也不保证任意挑选一个提交即可独立部署**。需要依赖链时整体检出本分支。

## 验证状态

- 全工作区 typecheck、build 通过。
- 本轮服务/存储/查询/三维专项：496 通过、3 跳过、0 失败。
- 新三维源码定向 ESLint 通过。
- 全仓 lint 未通过：68 errors、6 warnings；尚不是发布门禁全绿版本。
- 5,000/15,000 合成点位模型及浏览器结果见 [三维报告](./job-atlas-cesium-upgrade-2026-10-29.md)；浏览器存在长任务/结果等待，不称全面流畅。
- 未获得 Google Key，上海真实建筑、供应商费用与生产凭据限制未验收。
- 没有运行本轮完整 pnpm test、Windows/Docker 或 Pages 发布验收。

## 未上传内容

本地 .agent-memory 改动、output、.playwright-cli、真实岗位数据库及其 WAL/锁/token、环境文件、登录 profile/cookies、私人简历与个人对话附件不在本次变更集。候选文件常见密钥模式扫描没有命中；这不是对既有 Git 历史的秘密审计。

## 下一阶段分开处理

1. 持续 revision 下的查询结果呈现与旧列表保留。
2. 首次完整基线分页（当前源码未实现）。
3. Agent 工具审批、真实结果判定与职业对话闭环。
4. Google/替代授权源目标城市覆盖验收。
5. 全仓 lint、生产浏览器与发布门禁。

推送只表示云端保存了本分支；不等于 main 合并、Pages 更新或远端 CI 成功。远端 SHA 以 git ls-remote 的最终核对为准。
