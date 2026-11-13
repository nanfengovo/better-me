# Career OS：既有 Desktop Shell 测试基线差分

日期：2026-11-09。仓库分支：`agent-os`。本轮对照的实际 HEAD：`7674df22df1f512656cfa59729b04bb8745c0306`。

## 结论与适用边界

当前 `desktop-shell.test.tsx` 的 6 项失败，在将所有已跟踪的 Web 源模块替换为上述 HEAD 内容后，使用同一测试文件、同一 Node 与现有依赖，**仍以相同名称、相同 actual/expected 失败**。
它们不是本轮 Career OS、架构白板或 `.os-stage` 层叠隔离改动新增的回归。单独执行其中两个测试仍失败，排除了只能由整套测试顺序污染解释的情形。

当前新增的 `.os-stage { z-index:0; isolation:isolate }` 回归测试通过。集成主流程同时反馈：真实浏览器里菜单点击已经通过；这一真实 UI 观察由主流程持有，不能用 happy-dom 的 CSS 字符串断言代替。

这不等于全部既有行为都已正确，也不等于全套 Web 测试通过。`desktop-shell` 当前仍为 **23 项，17 通过、6 失败**。
其中偏好解析保留任意 wallpaper 字符串属于既有输入策略缺口；其余窗口定位、最大化、背景交互与 resize 的行为和旧断言不一致，仍需要独立产品/缺陷判断，不能一律删除断言或改成绿色。
本次只读诊断没有改动这些组件、偏好实现或原测试，也没有创建临时 worktree、安装依赖、修改 lock 或停止现有服务。

## 实际命令和结果

工作目录均为 `/Users/feng/Documents/Private/简历/简历Agent/better-me-agent-os`，使用现有直接二进制，未执行 `pnpm exec`。

### 1. 当前工作树

```sh
node_modules/.bin/tsx --test apps/web/tests/desktop-shell.test.tsx
```

结果：`tests 23 / pass 17 / fail 6`，退出码 1。新增的 `window focus counters are isolated below the shell navigation` 通过。

### 2. 最小的独立失败子集

```sh
node_modules/.bin/tsx --test --test-name-pattern 'desktop preferences accept|all apps and settings' apps/web/tests/desktop-shell.test.tsx
```

结果：`tests 2 / pass 0 / fail 2`，退出码 1，分别复现 settings 非 maximized 和 wallpaper 字符串仍被保留。

### 3. 同一测试，全部已跟踪 Web 源模块使用 HEAD 的内存差分

下列命令通过 Node `registerHooks`，从 `git show HEAD:<path>` 读取内容并用现有 TypeScript 转译后直接供模块加载。
它没有把 HEAD 文件写回工作树；测试本身仍使用当前文件，所以包含新增 CSS 隔离断言。
测试中的 CSS import 本身被原测试的空模块 hook 忽略；新增 CSS 断言另行读取当前真实 CSS。这个对照用于检查 **JavaScript/React 行为**，不冒充 HEAD 的真实浏览器 CSS 验收。

```sh
node --import tsx --input-type=module -e 'import {registerHooks} from "node:module"; import {execFileSync} from "node:child_process"; import {fileURLToPath} from "node:url"; import path from "node:path"; import ts from "./apps/web/node_modules/typescript/lib/typescript.js"; const root = process.cwd(); const files = new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "apps/web/src"], {encoding:"utf8"}).trim().split("\n")); registerHooks({load(url, context, next){ if(url.startsWith("file:")){const relative = path.relative(root,fileURLToPath(url)); if(files.has(relative) && /\.tsx?$/.test(relative)){const source = execFileSync("git",["show",`HEAD:${relative}`],{encoding:"utf8"}); return {format:"module",source:ts.transpileModule(source,{fileName:relative,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,shortCircuit:true}; }} return next(url,context); }}); await import("./apps/web/tests/desktop-shell.test.tsx");'
```

结果：`tests 23 / pass 17 / fail 6`，退出码 1。相同 6 个失败且 actual/expected 完全一致，新增 CSS 隔离断言仍通过。

### 4. HEAD 旧测试及 HEAD 源模块的补充对照

也运行了下列旧测试对照；它不包含本轮新增的 CSS 断言：

```sh
node --import tsx --input-type=module -e 'import {registerHooks} from "node:module"; import {execFileSync} from "node:child_process"; import {fileURLToPath} from "node:url"; import path from "node:path"; import ts from "./apps/web/node_modules/typescript/lib/typescript.js"; const root = process.cwd(); const files = new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "apps/web/src", "apps/web/tests/desktop-shell.test.tsx"], {encoding:"utf8"}).trim().split("\n")); registerHooks({load(url, context, next){ if(url.startsWith("file:")){const relative = path.relative(root,fileURLToPath(url)); if(files.has(relative) && /\.tsx?$/.test(relative)){const source = execFileSync("git",["show",`HEAD:${relative}`],{encoding:"utf8"}); return {format:"module",source:ts.transpileModule(source,{fileName:relative,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,shortCircuit:true}; }} return next(url,context); }}); await import("./apps/web/tests/desktop-shell.test.tsx");'
```

结果：`tests 22 / pass 16 / fail 6`，退出码 1。失败名称相同。此额外对照第一项因直接转译测试导致 Node assert 源位置内省的 message 异常，不能把该异常当成原始业务症状；第 3 项“同一测试、仅替换源模块”的对照已经以原始 assertion 精确复现该项，因此判断主要依据第 3 项。

## 六项失败与拥有源码

| 原测试名称 | 当前和 HEAD 源模块对照的实际差异 | 源码证据和解释边界 |
| --- | --- | --- |
| `all apps and settings initially open maximized` | settings 缺少 `is-maximized` | `DesktopWindow.tsx:83` 对 settings 使用 `centered`；`DesktopShell.tsx:99` 也明确 `defaultSnap="centered"`。不是新增 Career OS 代码影响窗口默认值。 |
| `desktop preferences accept only supported values and preserve legacy defaults` | 多出 `wallpaper: 'javascript:alert(1)'` | `ui-preferences.tsx` 只检查 wallpaper 是字符串，不做允许值校验。`DesktopShell.tsx:81` 对该具体字符串会构成本地 `/wallpapers/...jpg` 路径，不是直接 `javascript:` 导航；本次未证实脚本执行，也不能宣称解析器已安全校验。 |
| `settings manage real preferences and restore focus without unmounting business content` | 业务窗口 `inert` 为 false，旧断言期望 true | `DesktopShell.tsx:96` 当前不传 `inactive={settingsOpen}`；`DesktopWindow.tsx:350` 仅在 hidden/inactive 时 inert。这是已有背景交互策略与断言冲突，不是白板改变焦点规则。 |
| `dragging stays inside viewport bounds, ends on release and resets after resizing` | `'279px' !== '16px'` | `DesktopWindow.tsx:187–205` 在 snapped 窗口拖动超 8px 时先 detach 为浮动尺寸，并按指针重新定位；不沿用旧测试的固定起点计算。 |
| `restored windows expose eight resize handles and preserve dimensions across maximize` | `8 !== 0` | `DesktopWindow.tsx:602–615` 无条件渲染八方向 handles；旧测试要求 maximized 时数量为 0。现有另一项测试还明确要求 maximized 可直接 resize。需要统一行为要求，不能仅为消除失败删掉真实控件。 |
| `bottom resize handles can grow into Dock clearance and stop flush with the screen edge` | `'60px' !== '0px'` | `DesktopWindow.tsx:278–284` 将 bottom limit 保留为 `window.innerHeight - 30`；与旧测试要求顶/底 offset 归零、贴屏边的规则不同。是否应调整属于已有窗口布局独立问题。 |

## 本次交付判定

- 这 6 项不是当前 Career OS 变更引入的新增失败；无需为继续本轮隔离功能验收而改动无关窗口实现或降低断言。
- 新增 `.os-stage` 层叠隔离回归是独立绿色信号；真实菜单点击的通过是集成浏览器信号。两者都不将旧 suite 的 6 个失败抹掉。
- 全 Web 套件仍应报告既有失败，不得用“本次专项通过”替代“全部通过”。窗口交互/偏好校验应另开明确范围后修复与重新验收。
- Vork 卡片在该 Node/happy-dom 套件中还输出了相对 `/api/v1/agent/vork/status` 无法解析的 warning；HEAD 对照也有同一 warning，不在 6 个 assertion 之外另算一次通过或失败。
