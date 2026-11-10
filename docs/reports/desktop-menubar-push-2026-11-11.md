# 公共菜单栏自动隐藏：推送范围与复核

日期：2026-11-11。用户授权代码推送；仅提取菜单栏功能，在远端 `agent-os` 的 `ea3338f` 之上整合，不携带源工作区其余未提交功能、账号资料、密钥、验收 profile、截图或构建产物。

## 功能

- 顶部 BetterMe 菜单栏右击「自动隐藏菜单栏」，或从「桌面与 Dock」设置切换，默认常显。
- 细指针、宽度至少 601px 时回收 34px 菜单占位；移到顶边或 F10 唤出浮层，唤出不重排内容。
- 离开延迟 220ms 收起，内部焦点或展开菜单保留；支持键盘打开、Escape 取消及焦点恢复。
- 触屏和窄屏保持常显。偏好校验并沿用原 UI 存储，不改变业务资料、模型授权、预算或 App 挂载。
- 隔离窗口层级，使菜单不被业务窗口盖住；Electron 菜单主体响应右击，保留顶部拖拽带，最大化工具条为原生按钮预留空间。
- 保留最新远端的 ProductMark、运行时身份和桌面发布实现，不改依赖或 CI 策略。

## 发布快照复核

63 项相关 UI 回归通过：桌面 Shell、偏好、壁纸、主题、远端新增的工坊身份联动及伴侣输出。生产改动定向 ESLint 零 warning；`git diff --check` 通过。

```sh
pnpm exec turbo run build --filter=@better-me/web^...
pnpm exec tsx --tsconfig apps/web/tsconfig.json --test --test-concurrency=4 apps/web/tests/desktop-shell.test.tsx apps/web/tests/ui-preferences.test.tsx apps/web/tests/desktop-wallpaper.test.ts apps/web/tests/workspace-themes.test.tsx apps/web/tests/resume-theme-ui.test.tsx apps/web/tests/studio-agent-identity.test.tsx apps/web/tests/agent-companion-output.test.tsx
pnpm exec eslint apps/web/src/components/desktop/DesktopMenuBar.tsx apps/web/src/components/desktop/DesktopShell.tsx apps/web/src/components/desktop/DesktopSettings.tsx apps/web/src/lib/ui-preferences.tsx --max-warnings 0
pnpm desktop:build
```

合成 UI lab 为 `apps/web/tests/ui-lab/desktop-menubar.html`；opt-in Electron 检查为 `apps/desktop/tests/menubar-smoke.cjs`，仅接独立的 56373 合成页面。此前源工作区的浏览器/Electron 34 界面验证不冒充最新远端 Electron 45 打包产物实测。本次不生成、签名或发布安装包，不更新用户当前运行中的 App/Host，不调用真实模型。完整仓库与多平台结果以远端 CI 为准。
