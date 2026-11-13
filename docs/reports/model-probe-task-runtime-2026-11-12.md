# 模型配置生成测试使用原任务与根账

2026-11-12，`agent-os`。这是配置弹窗迁移阶段的实现与验收回执，不冒称本轮又做了一次实际模型推理。当前安装资源已被后续Studio批次替换，唯一权威看[Studio回执](studio-analysis-task-runtime-2026-11-12.md)。完整目标active。

## 实际变化

- AiConfigModal不再通过浏览器 `testLlmGeneration` 独立生成。获取目录仍明确标注“不测试生成”；生成按钮打开既有OneOffTaskPanel，只有本人明确授权才经tasks发送固定测试问句。
- 完整固定测试问句可展开查看，不混入简历、岗位、个人证据或原聊天历史。临时配置仅存内存；任务只留公开runtime binding，不把API Key写入task/recovery。
- 使用当前简历/工作区rootScope，沿同一根累计额度、runtime adapter与稳定任务ID。根配置冲突拒绝，不另开预算。刷新/关闭弹窗只停止观察，不恢复许可或自动重发；未知创建先GET对账，暂停/中断必须明确恢复原任务。
- 完整回复、部分输出、artifact、复制及下载沿用原任务能力。没有裁短输入输出或静默换付费通道；“目录读取成功”与“文本生成有效”分开表达，不将此测试认证为视觉能力。

## UI：Before / After / Why

- Before：模型目录和生成测试容易被理解为同一种连通性检查，生成发生在独立浏览器通道；任务与费用归属不清楚。
- After：两入口明确分开；生成区显示原任务、累计用量、完整问句、明确授权，以及“继续原任务/读取现有任务/新任务沿用总额度”。配置footer保持稳定，内容独立滚动，输出按完整文本自然换行。
- Why：用户能核对到底发送什么、是否花费和恢复哪个任务，不把关窗当取消或把重开当新的授权。样式只作用于 `.ai-config-modal`，不改其他Agent面板。

权威合成截图：`output/playwright/model-probe-browser-verified-wide.png`（1512×900）和 `model-probe-browser-verified-narrow.png`（390×740），均已实际目视复核。窄屏动作44px、footer在视口内、无横向溢出；完整输出保留。旧名为final-wide/narrow的中间截图不是最终视觉权威。

## 测试及浏览器证据

最终 **34 Web +39 Host +14 Desktop=87项通过**，不是与其他批次相加的新总数。类型/定向lint/完整桌面构建通过；日志归档 `output/agent-runs/model-probe-runtime-2026-11-12/`。

真实合成浏览器：先聊天再配置测试，根 `ct_c99c54261dabda44795b9d44f232efcf`，probe `ct_8282443794fb2194b0f180cd296f9743`；2次脚本模型/1adapter/4个task POST。刷新和重开后原全文/记录SHA `fd24d16b0a4c7fa97752c567d0b9a81cca8f2ebed4e5bb16d63b7a6ac684b0c0`不变，许可false，不新增POST或推理。耐久回执为 `output/agent-runs/model-probe-browser-run-2026-11-12.json`、`model-probe-browser-restore-2026-11-12.json`，0外部模型调用。

该阶段最终资源533文件/DFS `9212849fe1ebe892aa93af3cfd0ad170c9cf6c8f561f8e7a53cbc1325159ca72`，已被Studio阶段替换并作为其紧邻回退保留。早期 `model-probe-installed-verification-2026-11-12.json` 只对应中间f246版本，不借给最终版；当前Studio独立核验另存。阶段成品离线两窗口通过，不是正式账号生成效果证明。

只读收尾通过Playwright tab-list确认自有5296测试标签已关闭，仅余localhost:5173原页，未关闭或刷新该页。原临时服务已退出；用户真实5173/5179服务、窗口、资料与凭据不动，没有Git发布。
