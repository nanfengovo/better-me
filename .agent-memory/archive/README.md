# .agent-memory/archive — 历史记忆归档

本目录存放为了防止 Memory Bank 膨胀而从根目录迁出的历史轨迹文件。

## 归档文件索引

1. `activeContext-history-20261107.md`：2026-10-16 至 2026-11-07 期间累积的历史停点与上下文记录（原 ~100KB）。
2. `progress-history-20261107.md`：2026-10-16 至 2026-11-07 期间各批次历史已完成项与待办详细清单（原 ~147KB）。
3. `decisionLog-history-20261107.md`：2026-10-16 创设以来的完整决策底稿（原 ~191KB）。
4. `activeContext-history-20261112-pre-studio-review.md`：2026-11-07后至v7进行中工作阶段累积的138行停点；其“当前资源/下一步”为历史快照，当前权威只读根activeContext指针。

## 查阅说明

- 日常 Agent 会话仅需读取根目录的 `activeContext.md` 与 `progress.md`（保持轻量 ≤1 屏）。
- 仅在需要追溯特定历史技术方案或弃选原因时，按需回溯本目录文件。
