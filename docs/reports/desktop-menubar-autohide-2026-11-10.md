# 桌面公共菜单栏自动隐藏 · 2026-11-10

## 交付

用户截图指向顶部 BetterMe 公共菜单栏；末句按「鼠标经过时显示」理解。通过右击菜单栏的「自动隐藏菜单栏」开关启用，也能从「系统设置 → 桌面与 Dock」切换。默认保持常显，不修改已有用户的运行窗口或偏好。

- 共用 `DesktopMenuBar`，没有给各 App 分别实现，也不卸载、最小化或暂停业务内容。
- 开启后公共菜单占位从 34px 变为 0；顶边 4px 热区唤出浮层，工作区不因唤出而重新排版。离开后 220ms 收起，再进入取消待收起；菜单展开或键盘焦点仍在内部时不收起。
- F10 唤出并聚焦；Shift+F10 / ContextMenu 打开显示开关，Escape 取消并恢复焦点。右击业务编辑区域仍保留原行为。右边缘弹出项限制在视口内。
- 偏好只进入原有 `betterme.ui.preferences.v1`，校验布尔值并支持跨窗口同步及存储失败提示，不触及简历、事实库、模型、授权或预算。
- 仅细指针且宽度至少 601px 时自动隐藏；触屏和窄屏保持常显。减少动态时无额外位移动画。沿用原桌面材质，不增加常驻提示条或新导航层。
- Electron 菜单主体为 no-drag，确保空白处右击到达页面；保留顶部 3px 原生拖拽带。自动隐藏后的铺满窗口工具条左侧预留 84px，避开原生窗口按钮。没有改主进程、IPC 或窗口生命周期。
- 保留 App 内部工具条、保存按钮与原有「专注」功能；本次不是浏览器/操作系统原生菜单栏的隐藏设置。

## 定向自动化

最终 75 项通过，无失败或跳过：61 项桌面 Shell、UI 偏好、主题、壁纸及草稿恢复回归，加 14 项桌面生命周期/隔离 QA/Host runtime 检查。31 项 Shell 测试包含其中，不重复计数。

新增检查先失败后实现，覆盖显式偏好、右击启用、编辑器草稿保留、切换 App 不换编辑器节点、悬停穿越取消收起、焦点保留、窄屏常显、键盘取消及跨窗口同步。另更新原偏好测试的完整默认值快照。

Web 类型检查、生产文件定向 ESLint（零 warning）、`git diff --check`、`pnpm desktop:build` 通过。已有 Atlas Node 模块外置和大 chunk 构建警告未在本次处理；Shell 测试打开设置时，既有 Vork 卡片的相对 URL 在 Node 夹具记录错误，不影响断言通过，不宣称零日志或全仓验收。

```sh
pnpm exec tsx --tsconfig apps/web/tsconfig.json --test --test-concurrency=4 apps/web/tests/desktop-shell.test.tsx apps/web/tests/ui-preferences.test.tsx apps/web/tests/desktop-wallpaper.test.ts apps/web/tests/workspace-themes.test.tsx apps/web/tests/workspace-recovery.test.tsx apps/web/tests/resume-theme-ui.test.tsx
node --test apps/desktop/tests/lifecycle.test.cjs apps/desktop/tests/isolated-qa.test.cjs apps/desktop/tests/agent-host-runtime.test.cjs
pnpm --filter @better-me/web typecheck
pnpm exec eslint apps/web/src/components/desktop/DesktopMenuBar.tsx apps/web/src/components/desktop/DesktopShell.tsx apps/web/src/components/desktop/DesktopSettings.tsx apps/web/src/lib/ui-preferences.tsx --max-warnings 0
pnpm desktop:build
```

## 实际浏览器与 Electron

真实桌面 Shell 和设置配合合成 App 内容；独立浏览器 profile、新的 Vite 端口 56373，无账号、真实简历、Host 或真实模型。外部资源主动阻止；不是完整业务页面验收。

- 1440×1000：工作区从 966px 增至 1000px，回收 34px；隐藏容器高度 0，唤出仍为同一工作区高度。
- 从应用菜单依次切 AI 顾问、岗位与投递、岗位地图、资料库、自动化工坊和简历，均保持自动隐藏和同一合成编辑器节点、未发送草稿。
- F10 恢复焦点；右边缘右击菜单矩形 x=1208、宽=224，未越出 1440px 视口；Escape 关闭。
- 页面重载后偏好仍为 true。390×844 窄屏常显 34px，无水平溢出；独立 1024×800 触屏 context（maxTouchPoints=1）也常显。
- 截图：`output/playwright/desktop-menubar-hidden-20261110.png`、`output/playwright/desktop-menubar-revealed-20261110.png`。截图为合成内容，不是用户简历。
- 新增 opt-in `apps/desktop/tests/menubar-smoke.cjs`：同端口启动 UI lab 后运行。Electron 34.2 原生式窗口实际两次右键输入均到达开关；966→1000px、顶边唤出不重排、84px 原生控件留白、同一编辑器断言通过。私有 profile 回执 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-menubar-GZAkzI/summary.json`，真实服务或模型调用 0。

## 本机 App

最终同步到相邻源链接版 `/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app`，533 个资源；清单摘要 `62e914088a6328c19ae62e4d07b513dd3da28e96b62f1295123ac6373f0814ae`。同步脚本校验构建源/目标并发变化、拒绝符号链接，替换前完整资源在 `../.unified-agent-app-jf4O2k/previous-dist`；本轮开始前的原资源在 `../.unified-agent-app-qm8k8s/previous-dist`，均保留可恢复。

安装资源的实际 Electron main/preload/React 离线启动、关窗重开通过，两个窗口，无真实服务或模型调用；回执 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-xpjAlc/summary.json`。软件渲染的 GPU 上下文日志仍存在，不宣称零错误日志。

没有强制刷新用户原窗口、修改真实文档、切模型、重启原 Host、提交 Git 或发布。用户保存当前可见草稿后手动重新载入即可使用；顶部公共菜单栏右击开关为显式启用，不默认替用户开启。

验收结束仅关闭本轮命名浏览器/新建触屏 context，并停止已核对 PID 和端口的 56373 临时 Vite；记录与资源备份保留，没有关闭用户原窗口或服务。
