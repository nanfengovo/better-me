# 张开源
> 高级工业软件研发工程师 · 工业 AI 与机器人系统全栈

上海 | 统招工科大专 / 本科 · 自动化与电子信息工程 | +86 138-0000-0000 | alex.zhang.demo@example.com
[GitHub](https://github.com/example/open-source-showcase)

## 目标方向
- 高级工业软件研发工程师 (.NET 8 / C#)
- 机器人调度与工业系统全栈工程师

## 工作经历
### 某半导体智能设备制造有限公司 · 全栈 / 后端开发工程师 (2024-01 ~ 至今)
**项目**: 半导体制造机器人调度控制平台（RCS）
**技术栈**: ASP.NET 8, ABP vNext, OpenIddict, Redis

- 基于 ASP.NET 8 + ABP vNext 构建半导体高可靠机器人调度软件核心框架
- 设计 Adapter 设备抽象层，将异构机台/控制器与上层调度解耦，支持标准化即插即用
- 扩展 ABP 细粒度权限与 OpenIddict 认证流，实现工厂级安全控制与 Token 平滑刷新
- 提炼跨项目公共内核，调度状态机与核心逻辑复用率达 40%

### 某智能视觉与机器人控制技术企业 · 后端工程师 (2023-05 ~ 2023-12)
**项目**: 智能工业切割机器人控制调度系统
**技术栈**: 状态机, 多线程并发, Paddle OCR, 机器视觉

- 负责核心控制状态机流转与多线程异步 I/O 调度优化，保障切削轨迹平滑控制
- 优化状态机与设备通信协议解析，系统响应延时和执行效率提升 15%

### 某新能源工厂自动化装备有限公司 · 工业软件研发工程师 (2021-07 ~ 2023-04)
**项目**: 自动化物流控制平台（WCS/RDS）
**技术栈**: ASP.NET Core, EF Core, Vue3, Siemens S7, Modbus TCP, WPF

- 主导 WCS 仓储控制系统业务，基于 ASP.NET Core WebAPI + EF Core + Vue3 搭建前后端系统
- 编写设备总线驱动，支持西门子 S7、Modbus TCP 与 AGV 调度控制系统可靠对接
- 支持同场最多 40 台不同型号异构 AGV 高并发调度与交通管制，零死锁运行

## 开源项目
### Industrial-Agent-Demo ([Link](https://github.com/example/industrial-agent-demo))
**技术栈**: React, FastAPI, LangChain, Ollama, Three.js

- 工业运维 Agent：RAG 排障知识库 + Tool Calling 查库查日志 + Three.js 数字孪生可视化

### LocalFirst-DB-Demo ([Link](https://github.com/example/localfirst-db-demo))
**技术栈**: React, TypeScript, SQLite WASM, OPFS

- 无后端 Local-First：SQLite WASM + OPFS，探索前端离线库与大模型数据闭环
