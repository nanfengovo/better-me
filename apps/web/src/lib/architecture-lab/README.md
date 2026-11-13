# 架构白板接缝

入口是 `components/CareerArchitectureLab.tsx`（同名 CSS 已由组件引入），不依赖 React Flow 或新增 npm 包。
SVG 负责节点拖拽、端点拖连/点击连接和键盘移动，DOM 列表及详情表单提供等效操作。
没有内置项目、模型、存储、源码读取、Hook 或真实故障工具。

## 宿主注入

`CareerArchitectureLabProps`：

- `binding`：`ownerId / sessionGeneration / projectId / revision / contentHash`，由宿主授权快照派生。
- `getCurrentBinding()`：必须核对当前 lease；撤权应抛错或返回不匹配代次。绑定变化时组件重建会话，旧图不展示。
- `evidence`：仅本次授权的不可变资料快照，含 `id / label / excerpt / path? / startLine? / endLine?`。
- `initialDocument?`：已授权的完整图与会话。跨 owner、session、项目来源版本的记录不读取。
- `storage?`：`load(binding, signal)` 与 `save({ binding, document, expectedVersion, fingerprint }, signal)`。
  保存返回 CAS 冲突或绑定完整文档 ID、修订、载荷键和存储版本的回执。Adapter 必须在实际提交前复核授权/CAS、保留版本历史；组件不直接写现有业务库。
- `interviewer?`：固定 `label / location` 和 `ask(context, signal) / review(context + question + answer, signal)`。
  Context 含本次 `requestId / binding / graphFingerprint / document / fault?`；历史问答不会批量派送。
  返回 envelope 必须原样绑定 `requestId / binding / graphFingerprint`，并返回授权证据编号或明确 unknown。
- `importEvidence?`：只在点击“读取已授权源码”时派送；返回当前库存、回执和限制。预览与单独勾选确认前不改变本地草稿。
  `onEvidenceInventoryChanged?` 在明确采用引用或已加载图后同步宿主当前库存；新增代码不会自动绑定为节点的支持论据。
- `onSaved?` 只在精确版本回执通过后通知，`onExport?` 接收用户明确预览并确认的 JSON 下载产物。
- `operationTimeoutMs?` 有硬上限；取消、切号、版本变化、改图和答复变化都会使迟到结果不可采用。

加载只产生“待采用存储版本”，不自动覆盖本地草稿。保存超时/失败/取消时结果可能未知，
按钮锁定到用户加载对账，不自动重试。缺少 Adapter 时显式不可用，不伪造持久化或 Agent 输出。

## 模拟与历史

`simulateArchitectureFault` 纯计算磁盘满、会话切换、网络超时、重复事件。
依赖失败反向传播给调用方；会话/重复事件沿流向传播。隔离、会话代次和幂等策略默认 unknown，
图上的“声明有防护”只是假设，不认证真实实现。循环与传播步数有界，预算耗尽保留 unknown。
没有磁盘、网络、进程、账号或生产服务操作。

图修订与文档修订分开：改图产生新图版本；故障、问答、未提交答复草稿保存在完整会话里。
复盘追加新回合，不覆盖原问题/已提交答复。撤销只恢复图，不覆盖问答历史。
模型和存储响应分别核对来源绑定、当前图/答复、引用存在性；引用存在不是语义真实的证明。

## 已接入的受限持久化与代码入口

`CareerStudioWorkspace` 使用稳定 `resumeId` 作为 projectId（不是一次性的 context UUID），
注入 `createCareerArchitectureAdapters`。没有本地模型时仍可编辑、保存和加载；模型只影响追问/复盘。
客户端修正了 `validateArchitectureDocument` 返回空数组被当成 truthy 而恒拒绝存储的问题，
并逐一核对 Host 的 owner/workspace/resume/sourceFingerprint/currentContext/CAS 与原始文档载荷。
独立模型请求核对实际 SHA-256 与固定 runtime/digest，过期 scope/model 结果不可采用。

Host `architecture-artifacts.ts` 使用 owner+workspace+resume+sourceFingerprint 的稳定内部键，
metadata 由当前授权 Context 生成，不信任浏览器自报。最新版本写入前先保留不可变上一版本，
再执行 SQLite CAS；保留失败就不覆盖。不同原稿/工作区/owner 无法通过相同 id 读取。
重新授权或 Host 重启后，旧授权失效；用户可显式“加载对账→确认替换”，恢复为新的未保存图草稿。
`rebindArchitectureGraphDraft` 保留图/标注，但清除旧 faults/turns；代码引用仅逐字段 exact
匹配本次重新授权库存才保留。加载不改写历史，也不将旧问答当新证据。

`POST /architecture/evidence {contextId,operationId,consent:true}` 只接受当前 Context 已完成的
committee 操作。Host 从其持久 readset 使用相同 Broker grant/相同路径/相同行段重新读取，
核对原始哈希、原文与范围；不创建新 grant、列目录、自动扫描或扩大授权。返回相对路径，
不返回授权根路径。保存时再次重读已导入来源，代码变化或撤权则失败，不偷偷丢弃后再保存。
UI 必须预览并确认更新库存；清除不匹配引用及旧问答/故障，保留用户当前图。

## 导出与剩余验收

`exportArchitectureArtifact` 排除 owner/session、授权资料原文、本机引用路径以及包含原文的载荷键。
图名、用户注释和模型问答仍可能有敏感文本，UI 必须先显示完整预览并由用户确认。
导出快照不是恢复授权、本人贡献或工程能力认证，也不能宣称已下载副本可以撤回。

专属单测覆盖纯传播、版本/CAS、取消/超时、未知、导出字段，以及 happy-dom 中真实控件事件。
happy-dom 没有视觉布局引擎。专项测试已通过真实 SQLite、真实本机 HTTP、真实 Broker
读取合成仓库、重启/重新授权恢复、CAS/history、越权/源码变化拒绝，以及代码预览/确认控件。
测试中的模型只是协议 fixture，不是真实模型质量验收。Web/Electron 截图、窄屏/缩放/
辅助技术和真实已授权模型的人工验收仍由集成流程完成，不可用组件单测替代。
