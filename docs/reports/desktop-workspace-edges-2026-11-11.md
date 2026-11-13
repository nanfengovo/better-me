# 工作区与 Agent 侧栏边界 · 2026-11-11

## 停点与范围

已完成用户截图中两处露底的最小样式修正：宽屏铺满业务窗口贴齐可用工作区，右侧 Agent 使用单线分隔。生产改动仅在 `desktop.css` 与 `agent-sidebar.css`，没有修改任务、输入输出、恢复、模型、授权或简历数据逻辑。未提交或推送。

| Before | After | Why |
| --- | --- | --- |
| 铺满样式被文件后段的 10px inset 覆盖，右侧、底部露出壁纸 | 宽 ≥941px 且高 ≥501px 的铺满业务窗口使用 0 inset、100% 宽高 | 铺满状态应占用菜单栏下的实际工作区 |
| 铺满窗口仍有 12px 外圆角及阴影，内部圆角也露底 | 仅铺满业务窗口取消外框、内角及阴影 | 贴合边缘；浮动、分屏及设置窗口保留原样式 |
| 侧栏外阴影与分隔叠加成暗缝 | 停靠侧栏无外阴影，分隔为 1px 主题线；悬停/键盘聚焦使用强调色 | 视觉边界轻量，同时保留 12px 调宽命中范围与键盘焦点 |

根因不是 Agent 面板内容溢出，而是后置 `.os-window.is-maximized` 强制设置了 10px 四边留白。修正选择器收窄为 `.os-business-window.is-maximized`，不修改全局窗口模式或 Dock/菜单栏布局。

## 验证

### 浏览器实际几何与交互

新建独立 Chrome 验收页 `tests/ui-lab/desktop-boundaries.html`，使用真实 DesktopShell、AgentSidebar 与主题组件，编辑器和任务均为合成数据。未挂载真实账号、简历、模型 Provider 或 Host；夹具禁用真实 fetch，UI lab 不代理真实 API。

在 1512×828 viewport 下，工作区为 `(0,34,1132,794)`：

- 修正前业务窗口为 `(10,44,1112,774)`，右边与底边各差 10px，圆角 12px。
- 修正后业务窗口与工作区完全重合：`(0,34,1132,794)`，右边/底边差均为 0，圆角 0。
- 侧栏仍为 380px，调宽目标仍为 12px，可见分隔 1px；页面 scrollWidth 仍为 1512，无新增横向溢出。
- 切到浮动模式保留 14px 圆角，切回铺满恢复 0 间隙；合成草稿逐字不变。
- 键盘调宽 380→388 成功；设置窗口保留独立浮动边界与 14px 圆角。
- 深色主题下右侧/底部间隙仍为 0、侧栏无外阴影，已目视检查浅色/深色截图。

未做新的移动端真机验收；本次规则只在上述宽高断点生效，窄屏及矮屏规则未改。当前真实 BetterMe 窗口只读目视核对了铺满底边；用户已切到其他业务页且侧栏关闭，因此侧栏成对比较以隔离页为准，未擅自切换用户页面。

合成截图保存在仓库外 `output/ui/2026-11-11-workspace-edges/{before,after,dark}.png`，无真实职业材料。

### 回归与构建

- Web 定向 66 项：`desktop-boundaries`、`desktop-shell`、`agent-sidebar`、`ui-preferences`、`workspace-recovery` 全部通过；新增两项 CSS 边界契约先红后绿。源码契约测试不冒充实际浏览器几何验收。
- Desktop lifecycle、isolated-qa、agent-host-runtime 共 14 项通过。本批合计 **80 项**，不与历史批次累加，不宣称整仓全部测试通过。
- 新增 TypeScript 测试/夹具定向 ESLint `--max-warnings 0` 通过。
- `pnpm desktop:build` 通过，完成 Web 类型检查、Vite 与 Electron main/preload 构建。原有 Atlas Node 外置化与大 chunk 提示仍存在。
- 安装后最终资源的离线 Electron 34.2.0 smoke 通过：真实成品 main/preload/React、两次窗口创建、独立 profile，实际服务/模型调用为 0。该 smoke 验证安装资源可启动/重开，不作为已登录业务页几何验证。
- 离线 smoke 原始回执：`/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-Q2VFpv/summary.json`。

## 双端同步与回退

通过 `scripts/sync-local-desktop-dist.mjs` 同步 533 个文件到相邻 `BetterMe.app/Contents/Resources/app/dist`；脚本比较源/目标 manifest 后才替换，保留旧资源目录。未退出/刷新真实应用，未重启原服务，未调用真实模型。

- 安装资源 SHA-256：`9036f8783448ffb7bec9249231e1044322f975133acce8ea891794f3c931a6ac`
- 前一资源 SHA-256：`e0669e3305b74ed0f1758c4a0e5327454e11e929a5dd93e86c937ff5f14b312f`
- Web 资源 SHA-256：`97f4aa9a8328df128a1f85a1253ddf74a75fdc0fa823705f7bd8891b6f2edd3b`
- 旧资源备份：相邻 `.unified-agent-app-ZHrQZf/previous-dist`

同步回执 `processesOrUserDataChanged:false`。运行中开发页可由 CSS HMR 生效；未强刷用户窗口。仓库原有大量未提交改动与远端差异保留，本批不改 Git 状态。后续继续处理窗口边界时先读本报告；如果仅反馈内容区其他视觉问题，不扩大为 Agent 流程重构。

## 当前资源复核

截图请求复核时，上述两处 CSS 修正已在当前源码与安装资源中，未重复扩改业务布局。重新目视核对既有合成浅色前后图与深色图；这些图片不是本轮重新拍摄的真实账号页面。重新执行上述五组 Web 测试为 66/66，三组 Desktop 测试为 14/14，共 80 项通过。Web 测试仍有既有 Vork 相对 URL 状态读取告警，但无失败；不以此声称真实 Vork 可用。

后续任务构建已刷新同一安装包，当前只读逐文件核对结果为：533 个文件，缺失 0、内容差异 0，安装清单 SHA-256 `816973be1cc1c710d4e0e24ff61192bad7aeef3a32902fcc8489bd6b4c504f2d`。回退副本为 `../.unified-agent-app-uiOjuw/previous-dist`，其清单 SHA-256 为上文 UI 成品的 `9036f8783448ffb7bec9249231e1044322f975133acce8ea891794f3c931a6ac`。

当前安装资源离线启动/重开回执为 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-9WlBLb/summary.json`：Electron 34.2.0、成品 main/preload/React、2 个窗口、独立 profile、0 真实服务或模型调用。此轮未再替换安装资源、未重启或刷新真实窗口、未改变草稿/模型/授权/任务逻辑。
