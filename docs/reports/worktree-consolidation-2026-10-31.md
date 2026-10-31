# BetterMe 双工作区整合与验收 · 2026-10-31

## 结果与分工

只保留现有 main 和 agent-os 两个开发工作区，不新建功能分支、不强推、不把开发特性自动并入稳定 main。

| 工作区 | 分支 | 用途 |
| --- | --- | --- |
| 简历Agent/better-me | main（03c8e55，已快进 origin/main） | 稳定代码、保留原有私人数据与浏览器状态 |
| 简历Agent/better-me-agent-os | agent-os | 本轮全部整合与后续开发 |

多副本来自并行任务的隔离 Git 工作树和临时 UI/性能快照，不是 Git 损坏；问题在于任务结束后没有统一合入与清理。今后以这两个固定工作区为准。

## 已整合的功能

- 原 agent-os 的地图命令区、原生设置对话框及无障碍控件先保全于213e621；合并当时远端9ac05f1形成e91ef26，保留Docker runtime、简历伴写、新手引导与岗位推荐。
- 原主目录：职业成长五类流程、严格模型输出、草稿版本/同意/取消恢复；Companion引导与恢复；采集诊断、服务生命周期守护和真实错误说明。
- 分页基线工作区：有界基线会话、分批读取、引用验证与只读预览；未完成的前缀不用于后台写入。
- 预览工作区：DeepSeek生成与推理控制、PDF Worker打包URL、对应测试。
- 推荐工作区：逐批结果、候选缓存、超时/停止、编辑焦点、匹配说明与合成测试样例；暂停后最后8个文档/图片变动已补充归档。
- 早期Atlas快照与历史blob对照，保留新版可调分栏、错误回执、MapLibre/Cesium；未反向套用会删除新功能的旧文件。

## 本轮修复

- 推荐兜底按唯一岗位计数；不能识别的自由地址不外发为地区查询。
- 地图整合重复筛选区、JSX/配置冲突；Windows路径回放与本机Chromium测试选择；CDP非法参数与空值防护；验证页面读取不隐式续租。
- 开发产物按内容指纹去重，避免重复文件系统通知反复重启；补充真实热重载回归。
- Claude嵌套工具事件可见；结构化错误/权限拒绝不会因CLI退出0被标记成功。可恢复的单次工具失败不直接冒充终态失败。
- Career与JD审批从动态interrupt以Command继续，防重复intake/model调用；已完成或缺少待审批状态时拒绝再次resume。
- 工具适配经过现有可信注册表，恢复权限、请求/字节/时间预算、取消与输出校验。
- JD原文及临时声明使用不持久化通道，入口__start__也不落盘；测试检查所有历史checkpoint/pending writes，并确认审批恢复不再请求私人输入。派生建议仍保存，已有旧检查点不自动删除。
- Run写入有序排队并提供flush，重启/测试清理等待已排队的记录、结果和事件写完。
- 根测试入口覆盖Web的.test.ts和.test.tsx；CI检查main和agent-os，Pages部署仍仅main。过期断言改为实际协议和限定区域，不删除测试或扩大安全权限换取通过。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| pnpm test | 3370项：3360通过、0失败、10按开关跳过的性能压力用例；约173秒 |
| Agent审计正式回归 | 10/10通过，已纳入正常测试入口；历史审计fixture转为该入口 |
| 独立真实Chromium | 6/6通过；合成页面/网络，不接管用户浏览器、不访问真实招聘账号 |
| pnpm typecheck | 13/13任务通过 |
| pnpm build | 8/8任务通过；仍有大chunk等构建提示 |
| pnpm lint | 0错误、8个现有Hooks依赖警告 |
| pnpm memory:check / git diff --check | 通过 |
| pnpm test:docker | 新构建的完整运行镜像：健康/Origin/鉴权/API、SQLite及令牌持久化、进程SIGKILL后恢复、容器重建通过 |
| 固定路径后回归 | Agent安全与推荐源18/18通过，两个工作区Git状态干净 |

Docker项目betterme-smoke-8dff3419使用随机端口与独立卷，验收后删除自己创建的容器/卷；原BetterMe与RCS容器均保留。镜像为本地验收产物，不表示已推镜像仓库或部署Pages。模型测试使用合成/模拟数据，不证明真实API密钥鉴权成功；10项跳过项不算大规模性能验收。

## 清理与恢复

- 已移除4个临时Git工作树：atlas-paged-baseline-lMJVL7、betterme-agent-os-preview.ASrQ9d、betterme-docker-release.x0ginC、betterme-match-docker.06BkCb。
- 已移除7个快照/测试目录：atlas-flex-brand-qORHmm、atlas-map-controls-s09Xrx、atlas-query-index-O3tW8v、atlas-status-clarity-Eg9US0、atlas-ui-polish-3W1DxS、atlas-ui-activation-20261028、betterme-docker-fixture.FIOMzn。可重建依赖先回收；没有全局Docker prune或删除现有服务卷。
- 私有恢复目录在项目父目录betterme-consolidation-backup-20261031.2t4uyC，权限700。含工作区归档、暂停后推荐副本增补归档、Git bundle、源文件清单和验证记录，严禁提交/上传。
- 原归档19187个文件内容匹配；主目录11个浏览器缓存差异留在原位，不在删除范围。后续推荐归档1407个真实文件内容匹配，AppleDouble元数据不当作源文件差异。删除前其他源码与暂停后清单一致，无新增遗漏。
- 主目录91个已改源码及未跟踪源码另存本地stash：consolidation-20261031-main-source-before-stable-restore。output/.playwright-cli留在原目录，仅本地Git排除；私人data、真实简历、凭据和现有浏览器未改动。
- 功能提交23a3f0660456a75bfc62e0c30f3a9e607eb339a5已正常推送；原子推送同时删除feat/docker-runtime-media-20261030、feat/resume-writing-copilot-20261029、feature/atlas-3d-modular-20261029，删除前逐一验证祖先关系。对应本地分支用安全-d删除，远端与本地分支均只剩main、agent-os；稳定main没有被开发分支覆盖。
- 最新本地运行镜像better-me:local为sha256:882b2c04f274fb925bcb2d2743d083df0d081a6f53238d06b533ddd4b2460142。仅对本轮构建时间与依赖关系确认的16个闲置、非共享缓存ID进行定向回收，Docker报告释放1.023GB；没有全局清缓存。过滤语义参照[Docker官方说明](https://docs.docker.com/reference/cli/docker/buildx/prune/)。原服务容器与卷、最终镜像保留。
- 清理后的本机可用空间约2.2GiB，仍偏紧。旧副本的表观目录大小不等同于实际释放量（共享块、备份和新验收镜像都会影响统计）；不把du加总冒充净释放量。
- 首次推送已触发[跨平台CI](https://github.com/nanfengovo/better-me/actions/runs/41162874299)，本报告写入时仍在执行，不能把本机全绿描述为远端全部完成。后续文档提交的最新CI状态以GitHub实际运行结果为准。

## 下一步

1. 后续开发只进入agent-os；稳定main通过独立审查/发布再更新，避免再次复制整仓形成长期分叉。
2. 接通Career真实Worker调度、证据产物和原生CLI交互审批；保留当前覆盖缺口，不把queued骨架称作任务完成。
3. 在用户单独授权的合成会话中验证真实模型发现/生成和真实平台流程；不替换真实简历、不擅自使用账号或密钥。
4. 专项运行默认跳过的大规模性能压力测试、处理8项Hooks警告与大chunk；旧检查点隐私清理需单独确认保留/迁移策略。
