# 岗位地图工作台：第二轮 UI / UX 精修与验收

日期：2026-10-28

## 交付结论

第二轮 UI 已独立接入主项目，包含 GPT 专属插画、可操作空状态、轻量空间交互、任务状态转换反馈、触屏与键盘适配，以及减少 UI 重复渲染的呈现层缓存。没有修改或激活查询索引实现，没有修改岗位服务、采集协议或简历存储。

5000 岗持续增量场景的完整浏览器交互流程通过；15000 岗高基数数据在每 2 秒持续增量时，查询结果长时间不能稳定返回，**端到端验收未通过**。主线程能够响应不等于岗位和地图结果及时更新，不能将这个结果描述为大库体验全面达标。

体验入口：<http://127.0.0.1:5173/?workspace=atlas>。应新开标签页体验；接入时已保护原有页面的热更新连接，没有刷新原页面或操作其中的简历内容。

## 设计与实现变化

| 之前 | 本轮之后 | 原因 |
| --- | --- | --- |
| 空状态以说明文字和密集平台选项为主 | 两组统一材质的专属插画、明确标题和下一步操作；平台选项按需展开 | 先说明当前状态和可执行动作，不让装饰挤掉操作 |
| 任务状态主要依赖数值和颜色 | 保留四条独立状态通道，增加图标、待命/处理中/可用/需关注文字及有限状态转换动效 | 不把采集、入库、补全、地图落点混成虚假的统一进度 |
| 2D / 3D 按钮缺少切换反馈 | 有移动选中底板和三层空间图标的分段控制器；仍驱动原有地图 | 提供空间状态反馈，不额外创建 WebGL 场景或地图画布 |
| UI 控件变化会重复构造岗位卡内容和国家选项 | 提取 memo 卡片内容，缓存与查询无关的国家选项 | 降低 UI 交互的 React 工作量，不改变搜索算法 |
| 筛选触发的 details 展开可能被原生 toggle 锁为手动展开 | 将手动 summary 操作与筛选展开区分；关闭后不再残留占位 | 防止筛选收起后地图和列表仍被挤压 |
| 深浅色和窄屏空状态层级不一致 | 统一局部边框、阴影、对比度、动作层级；窄屏覆盖层避让地图按钮 | 使布局可读、可操作，而不是只增加视觉特效 |

### 素材与空状态

- 使用内置 GPT 生图生成 discovery / search 两套透明背景插画，采用陶瓷、磨砂青绿色玻璃和石墨色的统一语言。
- 作为装饰素材使用，不代表真实地图边界、办公地址或采集证据，也不插入每条岗位卡。
- 提供 384 / 768 像素 WebP、响应式 srcSet、固定宽高比、懒加载和异步解码。常规 384 像素文件分别为 13,180 与 9,466 字节。
- 图片失败时回退为原生图标，保留标题、解释和全部操作。无匹配、空库、无可验证地址不会混为同一种失败。
- 去除平台快捷搜索区域未经证明的“免滑块”等保证性文案；仍保留真实来源与不完整采集的既有语义。
- 素材来源、完整生成提示和尺寸见 [素材说明](../../apps/web/public/atlas-art/README.md)。

### 动效与性能边界

- 空状态插画只在支持精细鼠标且未开启减少动态效果时响应轻微倾斜；最大约 X 5° / Y 7°，每帧合并更新，不通过 React state 推动整个工作台重渲染。
- 插画反馈约 180ms；2D / 3D 选择反馈 200ms；状态切换为有限的 transform / opacity 反馈。
- 数值、岗位列表和高频搜索结果不做逐条入场、数字滚动或持续闪烁动画。
- 键盘激活、减少动态效果、隐藏页面和不可见状态轨道具有对应的禁用/清理路径；触屏视角按钮为 44px 高。
- 页面仍使用一个地图 canvas。3D 部分是既有 MapLibre 空间视角加呈现层反馈，**不是新建的 Three.js 场景或真正可旋转的插画模型**。
- 呈现层缓存的回归用例确认：无查询变化的控件操作，不再重复执行国家格式化；岗位数据、选择和关键词相关展示仍能更新。

## 自动化验证

最终隔离源码执行以下 10 个文件的组合回归：**121 passed / 0 failed / 0 skipped，123.33 秒**。

```sh
pnpm exec tsx --test \
  apps/web/tests/atlas-experience.test.tsx \
  apps/web/tests/atlas-activity.test.tsx \
  apps/web/tests/atlas-view-controls.test.tsx \
  apps/web/tests/atlas-map-renderer.test.tsx \
  apps/web/tests/atlas-workspace.test.tsx \
  apps/web/tests/atlas-harvest-progress.test.tsx \
  apps/web/tests/background-enrichment-status.test.tsx \
  apps/web/tests/atlas-empty-experience.test.tsx \
  apps/web/tests/atlas-job-card-content.test.tsx \
  apps/web/tests/ui-lab/data.test.ts
```

最终 CSS 版本的 `pnpm --filter @better-me/web build` 通过，包含 TypeScript 检查。隔离生产验收包构建与 `verify-production.mjs` 通过；确认加载的是生产 React，而非 jsxDEV / Vite Refresh。

单独检查的六个呈现组件 lint 通过。包含 AtlasWorkspace 的全部指定范围 lint 仍有 6 errors / 1 warning，经与接入前 MAIN 逐语句对照均为既有项：5 处空 catch、1 处多余 Boolean、1 处 effect 依赖警告；本轮没有顺手修改这些无关逻辑。

构建仍提示既有的 `node:fs/path/url` 浏览器 externalization，以及部分 JS chunk 大于 500kB。这不是完整仓库所有检查无警告的声明。

## 浏览器专项验收

### 方法与可复现条件

使用单独创建的 Chrome 156.0.8078.48 窗口与隔离浏览器上下文，不连接用户已有标签页。桌面性能采样 viewport 1600×1000、DPR 1、前台可见；使用已预热的真实 MapLibre / OpenFreeMap 地图。

验收夹具直接挂载真实 AtlasWorkspace、计算 Worker、查询路径和地图，但 API 只返回内存合成数据，不连接真实岗位服务、简历或 AI。每个岗位配一个公司和位置，四分之一初始位置有合成坐标；这是高基数压力条件，不是实际岗位库分布。每 2 秒添加 10 岗并更新一个坐标，最长 60 批。

采样前要求界面已经观察到首次 revision 增长。通过真实键鼠输入依次搜索 C# / Python / TypeScript、展开收起筛选、切换 2D / 3D、打开详情并 Escape、清空搜索、拖动地图，最后停止合成更新并核对最终 revision。

这些数据只覆盖已预热的交互和增量更新，不用于宣称首次基线分页、冷启动或低端设备已达标。复现步骤见 [隔离验收说明](../../apps/web/tests/ui-lab/README.md)。

### 5000 岗：有界完整流程通过

最终完整测量标签：`final-production-5000-streaming-after-details-fix`。

| 项目 | 观测值 |
| --- | --- |
| 测量窗口 | 17,927.1ms，前台可见 |
| 数据变化 | 5000 → 5100 岗，revision 1 → 11 |
| 搜索中观察到的版本 | C# revision 4、Python revision 7、TypeScript revision 9 |
| Event Timing 观测交互数 | 43 |
| 最长 / p98 观测交互耗时 | 104ms / 104ms |
| rAF 平均调度频率 | 118.38 次/秒（本机约 120Hz） |
| rAF 间隔 p95 / 最大 | 9.9ms / 66.4ms |
| >50ms 长任务 | 2 次，合计 124ms，最长 63ms |
| 最终界面 | 30 张可见岗位卡、1 个地图 canvas、无横向溢出；追上 revision 11 |

上述流程之后仅增加了一条空状态次按钮的对比度规则，重新构建了生产包并复核对应状态；该规则不参与本次非空岗位列表的性能流程。

### 15000 岗：持续增量查询未通过

生产包与开发模式均复现：在每 2 秒继续追加数据时，输入仍可响应，但岗位列表一直处于更新中，超过 30 秒的查询稳定等待上限。生产测量窗口内只完成了 5 个观测交互，列表为 0 张卡；停止合成增量后约 **11.84 秒**才恢复结果。

该窗口的 rAF 平均调度频率约 119.96 次/秒、最长观测交互 48ms，**这些数字不能作为端到端通过证据**，因为完整操作流程没有完成。早期短批次 15000 岗试验在完整交互前已结束增量，也明确标为无效并发窗口，不充当通过结果。

本轮不修改查询实现，不将“查询等待”归因于某个未经单独验证的具体函数。后续应在独立任务中定位持续 revision 变化下查询稳定输出、任务取消/重调度及结果发布行为，再以相同夹具复测。

### 功能、视觉与可访问性

- 主项目独立只读窗口已验证：5608 岗、revision 4135；C# 命中 2262 岗；显示 30 张岗位卡、1 个地图 canvas；新插画成功加载，补全显示 0 待处理；无 pageerror。未启动真实平台采集。
- 鼠标切换 3D 的中间状态确实存在（选中底板位移 46.51px，稳定值 55.52px），而键盘激活对应 transition 为 0s。
- 筛选展开/收起与 summary 的 Enter 展开/收起均通过；不会将程序触发的展开锁为手动展开。
- 深色空状态的主按钮与次按钮使用可读的局部配色，插画成功解码；标题和操作在面板中可见。
- 390×844 触屏与 1280×800 减少动态效果/资源失败场景无横向溢出。触屏视角按钮 44px；减少动态效果时选择器 transition 为 0s，状态轨道 motion 为 off。
- 强制图片请求失败后，两个图标回退成功，标题和两项操作保留且未禁用。
- 键盘输入会立即清除插画倾斜；有限鼠标倾斜已在真实浏览器观察到。
- 模拟补全异常后，状态明确变为“需关注 / 状态异常 · 任务保留”，30 张岗位卡仍保留；恢复正常后自动返回“可用”。触屏空地址覆盖层与 2D / 3D、地图导航按钮均无重叠。

Event Timing 数值是实验室交互耗时代理，**不是线上用户 INP**；rAF 调度也不等于 GPU 实际呈现 FPS。不能以这次本机短流程推断所有设备和真实平台采集体验。指标定义参见 [INP](https://web.dev/articles/inp) 与 [优化 INP](https://web.dev/articles/optimize-inp)。

## 安全接入与数据保留

所有实现和构建先在独立目录进行，之后仅将本轮 UI、素材、测试夹具接入主项目。接入前 745 份已记录源码哈希与初始记录完全一致；接入后的已有文件变化仅限预定的 UI / 测试文件。没有改写查询源文件、workspace package dist、岗位服务、开发服务配置或简历逻辑。

主项目查询运行时哈希保持：`d1ca1a2f48535b411ba89b3a95dd7bdfcc177827aeb6b0b8be5748c1d41e3c2f`。本轮没有激活另一个查询索引阶段的源码改动。

两套原有 Vite 监听进程在接入时使用会话级热更新保护；原页面连接未接收本轮 update/full-reload，服务 PID 保持不变。原有连接继续保留当前版本，新打开页面获取新 UI。未刷新、导航、关闭或读取用户当前页面的简历存储。

数据检查不能简单写成“快照哈希不变”：长时间验证期间原有后台仍在推进，数据从 5570 岗 / revision 3971 增长为 5608 岗 / revision 4135，补全完成数由 1457 增为 1633。因此快照内容和哈希发生了变化，而服务 token 未变。

使用接入前只读 SQLite 在线备份逐 ID 核对：

| 数据表 | 接入前 | 核对时 | 原有 ID 保留 | 缺失 |
| --- | ---: | ---: | ---: | ---: |
| jobs | 5570 | 5608 | 5570 | 0 |
| base_jobs | 5570 | 5608 | 5570 | 0 |

数据库 quick_check 为 ok；没有回滚或覆盖后台新增结果。备份保留在隔离目录的 `private-backup/jobs-before-ui.sqlite`，本轮未执行恢复操作。

## 验证证据

- 隔离目录：`/Users/feng/Documents/Private/简历/atlas-ui-polish-3W1DxS/`
- [浏览器原始测量与明确的通过/失败标记](/Users/feng/Documents/Private/简历/atlas-ui-polish-3W1DxS/verification/browser-measurements.json)
- [浏览器功能检查](/Users/feng/Documents/Private/简历/atlas-ui-polish-3W1DxS/verification/browser-functional-qa.json)
- [主项目只读复核](/Users/feng/Documents/Private/简历/atlas-ui-polish-3W1DxS/verification/main-integration-smoke.json)
- [原有岗位 ID 保留检查](/Users/feng/Documents/Private/简历/atlas-ui-polish-3W1DxS/verification/data-preservation.json)
- [最终只读安全记录](/Users/feng/Documents/Private/简历/atlas-ui-polish-3W1DxS/final-state.json)
- [浅色工作台](/Users/feng/Documents/Private/简历/atlas-ui-polish-3W1DxS/verification/atlas-final-light.png)
- [深色空状态](/Users/feng/Documents/Private/简历/atlas-ui-polish-3W1DxS/verification/atlas-final-dark-empty.png)
- [触屏地图](/Users/feng/Documents/Private/简历/atlas-ui-polish-3W1DxS/verification/atlas-final-mobile.png)

验收与视觉样本均来自隔离合成夹具；没有把合成岗位写入用户数据库。真实平台长时间采集、线上 INP、GPU 呈现 FPS 与 15000 岗持续增量查询，均不在本轮“已通过”结论之内。

收尾时已关闭本轮创建的验收浏览器与 5186 / 5190 隔离服务，保留源码、截图、测量记录和备份。主项目 5173、岗位服务 5178、Agent 服务 5179 保持原进程运行。
