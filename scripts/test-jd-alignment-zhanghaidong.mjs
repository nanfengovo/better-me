import { decomposeJdText, alignJdWithResume } from "../packages/core/dist/index.js";
import fs from "node:fs";

// 1. Raw JD from BOSS (Mettler Toledo - 软件工程师 - 上海漕河泾)
const jdText = `岗位1：
主要职责：
• 负责工厂MES制造执行系统相关配套软件开发与维护，涵盖上位机客户端开发与设备嵌入式程序开发，对接生产车间各类自动化设备，实现设备数据采集，通讯交互，工艺控制，生产联动等核心功能。
• 独立完成软件需求分析，方案设计，代码开发，单元测试，BUG修复及版本迭代优化，输出规范的开发文档，接口文档和技术手册，保障软件稳定落地运行。
• 负责车间工控设备，传感器，PLC,工控机等硬件的通讯对接，解决设备与MES系统的数据互通，数据同步，异常报错等技术问题，保障生产流程顺畅。
• 参与MES系统现场调试、部署、试运行工作、配合项目团队完成生产场景落地，收集现场使用问题，持续优化软件性能，交互体验和运行稳定性。
• 跟进智能制造行业新技术，新方案，优化现有代码架构和开发流程，提升团队开发效率与产品稳定性，配合完成部门技术迭代升级工作。

任职资格：
教育背景
• 计算机、软件工程、自动化、电子信息相关专业本科及以上学历
技术要求与经验：
• 3年及以上C#/.NET工业自动化、上位机或MES系统开发经验
• 熟练掌握C#语言、.NET Core/.NET 8及WPF或WinForms客户端开发
• 深入理解工控通讯协议，如西门子S7、Modbus TCP/RTU、OPC UA、串口及TCP/IP网络通讯
• 熟悉SQL Server、MySQL等关系型数据库及Redis缓存，具备良好的SQL编写与性能优化能力
• 有AGV/AMR调度系统(RCS)、智能仓储(WCS/WMS)或现场软硬件调试经验者优先
• 具备良好的团队协作与抗压能力，能配合现场实施与技术攻关`;

// 2. Candidate Resume (张海东 - 软件工程师 - 3年经验)
const candidateResume = {
  locale: "zh-CN",
  templateId: "default",
  skills: [
    "C#", ".NET 8", "ASP.NET Core", "WPF", "WinForms",
    "西门子 S7", "Modbus TCP", "Modbus RTU", "OPC UA", "TCP/IP", "串口通讯",
    "RCS", "WCS", "WMS", "AGV/AMR调度", "MES对接", "工控机上位机",
    "ABP vNext", "EF Core", "Dapper", "SQL Server", "MySQL", "Redis",
    "AI Agent", "RAG", "Docker", "Linux", "Vue3", "TypeScript"
  ],
  educationSummary: "江苏电子信息职业学院 · 电子信息工程技术 · 大专 (2020.09 - 2023.06)",
  profile: {
    displayName: "张海东",
    headline: "3年经验 | C# 软件工程师 | 工业自动化与调度系统",
    education: "江苏电子信息职业学院 · 大专 · 电子信息工程技术",
    location: "上海",
    email: "haidong.zhang@example.com",
    phone: "138xxxxxxxx",
    links: [],
    targetRoles: ["C# 软件工程师", "上位机软件工程师", "MES系统开发工程师"],
    traits: ["工业协议互联", "上位机高并发", "软硬件现场调试", "工业AI Agent探索"]
  },
  experiences: [
    {
      id: "exp-xinsong",
      type: "work",
      org: "中科新松有限公司 (新松机器人华东基地)",
      title: "软件开发工程师 (全栈开发)",
      start: "2025-09",
      end: null,
      techStack: ["C#", ".NET 8", "ABP vNext", "WPF", "Vue3", "Modbus TCP", "西门子 S7", "SQL Server", "Redis"],
      claims: [
        {
          id: "claim-xs-1",
          kind: "achievement",
          text: "负责中科新松工厂RCS机器人控制系统上位机开发，对接车间西门子S7与Modbus TCP协议PLC及工控机，采集100+台设备传感器状态与生产工艺数据，实现毫秒级数据同步与设备生产联动控制。",
          tags: ["上位机", "工控协议", "PLC", "数据采集"]
        },
        {
          id: "claim-xs-2",
          kind: "achievement",
          text: "主导设计多AGV/AMR交通管制与动态避障算法，通过Redis分布式锁与状态机机制解决死锁卡顿，提升车间综合调度流转效率达25%，并在生产现场完成稳定部署运行。",
          tags: ["AGV调度", "高并发", "性能优化"]
        },
        {
          id: "claim-xs-3",
          kind: "responsibility",
          text: "主导编写完整的上位机软件架构设计说明书、PLC接口通讯协议规范与现场调试技术手册，独立完成单元测试与异常容错排查，保障软件系统零致命故障交付。",
          tags: ["文档规范", "单元测试", "系统稳定性"]
        },
        {
          id: "claim-xs-4",
          kind: "achievement",
          text: "前沿技术探索：引入开源大模型结合RAG架构构建工业设备运维Agent，解析设备报警日志并自动化匹配故障排查指引，将现场平均排障响应时间缩短40%。",
          tags: ["AI Agent", "技术创新", "故障排障"]
        }
      ]
    },
    {
      id: "exp-dajie",
      type: "work",
      org: "上海大界机器人科技有限公司",
      title: "后端开发工程师",
      start: "2025-05",
      end: "2025-08",
      techStack: ["C#", ".NET 8", "WPF", "Dapper", "MySQL", "OpenCV", "串口通讯", "TCP/IP"],
      claims: [
        {
          id: "claim-dj-1",
          kind: "achievement",
          text: "基于C# .NET 8与WPF开发钢结构激光切割机器人上位机人机交互系统，完成工控机与激光传感器、工控PLC硬件对接，实现实时工控指令下发与切割轨迹闭环控制。",
          tags: ["上位机", "WPF", "工控硬件", "PLC"]
        },
        {
          id: "claim-dj-2",
          kind: "responsibility",
          text: "深入车间一线参与软硬件系统现场调试部署与试运行，解决多工位传感器电磁干扰导致的偶发通讯丢包问题，建立通信心跳检测与断线自动重连机制。",
          tags: ["现场调试", "软硬件通讯", "容错机制"]
        }
      ]
    },
    {
      id: "exp-guanhong",
      type: "work",
      org: "苏州冠鸿智能装备有限公司",
      title: "软件开发工程师",
      start: "2023-07",
      end: "2025-04",
      techStack: ["C#", "ASP.NET Core", "EF Core", "SQL Server", "Modbus", "PLC", "Redis"],
      claims: [
        {
          id: "claim-gh-1",
          kind: "achievement",
          text: "负责自动化立体仓库WCS系统核心调度模块开发，向上打通工厂MES与ERP制造执行系统，向下对接堆垛机PLC与条码扫码器，日均处理生产物料出入库任务超20,000批次。",
          tags: ["MES对接", "WCS", "数据交互", "高并发"]
        },
        {
          id: "claim-gh-2",
          kind: "responsibility",
          text: "负责各制造车间现场部署与联调，处理生产现场各种工况下的网络抖动与PLC数据不同步异常，输出标准实施接口文档，获得客户项目整体验收。",
          tags: ["现场部署", "数据同步", "接口文档"]
        }
      ]
    }
  ]
};

console.log("-----------------------------------------");
console.log("1. 正在运行 JD 确定性原句深度拆解引擎...");
const decomposed = decomposeJdText(jdText, {
  title: "软件工程师",
  company: "梅特勒托利多科技（中国）有限公司",
  location: "上海徐汇漕河泾"
});

console.log(`[JD拆解完成]`);
console.log(`- 核心职责项: ${decomposed.responsibilities.length}`);
console.log(`- 硬性要求项: ${decomposed.hardRequirements.length}`);
console.log(`- 加分偏好项: ${decomposed.preferredQualifications.length}`);
console.log(`- 约束条件项: ${decomposed.constraints.length}`);
console.log(`- 识别技术栈:`, decomposed.detectedTechStack.join(", "));

console.log("\n-----------------------------------------");
console.log("2. 正在运行 3柱证据链对齐与防编造核验引擎...");
const report = alignJdWithResume(decomposed, candidateResume);

console.log(`[对齐评分]: ${report.metrics.matchScore}分 (覆盖率: ${(report.metrics.coverageRate * 100).toFixed(1)}%)`);
console.log(`- 强有力实证 (Verified Matches): ${report.metrics.verifiedCount} 条`);
console.log(`- 弱表达待强化 (Weak Expressions): ${report.metrics.weakCount} 条`);
console.log(`- 真实能力/门槛缺口 (Gaps - 严禁伪造): ${report.metrics.gapCount} 条`);

fs.writeFileSync("./data/zhanghaidong-alignment-result.json", JSON.stringify(report, null, 2), "utf8");
console.log("\n已输出详细对齐结果到 ./data/zhanghaidong-alignment-result.json");
