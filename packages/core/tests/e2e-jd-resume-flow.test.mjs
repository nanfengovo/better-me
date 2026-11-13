import assert from "node:assert/strict";
import test from "node:test";
import { decomposeJdText, alignJdWithResume } from "../dist/index.js";

test("E2E闭环验证: 张海东真实履历 × 梅特勒托利多真实工控JD", () => {
  // 1. 目标职位 JD 原文（梅特勒托利多 软件工程师 - 上海徐汇漕河泾）
  const jdRaw = `岗位1：
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

  // 2. 候选人张海东真实履历投影 (大专 3年经验 C#/.NET 工业自动化)
  const candidateResume = {
    locale: "zh-CN",
    templateId: "default",
    skills: [
      "C#", ".NET 8", "ASP.NET Core", "WPF", "WinForms",
      "西门子 S7", "Modbus TCP", "Modbus RTU", "OPC UA", "TCP/IP", "串口通讯",
      "RCS", "WCS", "WMS", "AGV/AMR调度", "MES对接", "工控机上位机",
      "ABP vNext", "EF Core", "Dapper", "SQL Server", "MySQL", "Redis"
    ],
    educationSummary: "江苏电子信息职业学院 · 电子信息工程技术 · 大专 (2020.09 - 2023.06)",
    profile: {
      displayName: "张海东",
      headline: "3年经验 | C# 软件工程师 | 工业自动化与调度系统",
      education: "江苏电子信息职业学院 · 大专 · 电子信息工程技术",
      location: "上海",
      links: [],
      targetRoles: ["C# 软件工程师", "上位机软件工程师", "MES系统开发工程师"],
      traits: ["工业协议互联", "上位机高并发", "软硬件现场调试"]
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
      }
    ]
  };

  // --- 步骤 1: 运行 JD 原句确定性拆解 ---
  const decomposed = decomposeJdText(jdRaw, {
    title: "软件工程师",
    company: "梅特勒托利多科技（中国）有限公司",
    location: "上海徐汇漕河泾"
  });

  assert.ok(decomposed.responsibilities.length >= 5, "应成功拆解出至少5项核心职责");
  assert.ok(decomposed.hardRequirements.length >= 5, "应成功拆解出至少5项硬性要求");
  assert.ok(decomposed.preferredQualifications.length >= 1, "应识别出加分优先项 (AGV/RCS)");
  assert.ok(decomposed.detectedTechStack.includes("C#"), "技术栈必须识别出 C#");
  assert.ok(decomposed.detectedTechStack.includes("PLC"), "技术栈必须识别出 PLC");
  assert.ok(decomposed.detectedTechStack.includes("Modbus"), "技术栈必须识别出 Modbus");

  // --- 步骤 2: 运行 3 柱证据链对齐与防编造核验 ---
  const report = alignJdWithResume(decomposed, candidateResume);

  // 断言强有力匹配项
  assert.ok(report.metrics.verifiedCount >= 6, `强有力匹配项应至少6项，实际为 ${report.metrics.verifiedCount}`);
  
  // 断言弱表达项 (存在可采纳建议)
  assert.ok(report.metrics.weakCount >= 1, `应识别出弱表达待强化项，实际为 ${report.metrics.weakCount}`);
  const weakItem = report.alignments.find(a => a.status === "weak_expression");
  assert.ok(weakItem?.suggestedText, "弱表达项必须提供具体的优化润色建议");

  // 断言客观缺口与防编造铁律：学历为大专，JD要求本科，绝不能造假篡改为本科，必须标记为 gap
  const educationGap = report.alignments.find(
    a => a.jdItem.category === "education" && a.status === "gap"
  );
  assert.ok(educationGap, "防编造铁律：必须将本科学历门槛与大专现状识别为客观 gap，严禁虚构造假");
  assert.match(educationGap.rationale, /不篡改学历/, "门槛缺口中必须明确防编造提示");
  assert.match(educationGap.rationale, /不补写未提供的年限、领域或交付成果/, "缺口提示不能鼓励补写不存在的经验");

  // 断言面试防守策略
  assert.ok(report.defenseQuestions.length > 0, "必须生成针对弱项或缺口的面试防守追问");

  // --- 步骤 3: 模拟用户在抽屉中采纳建议并生成定制简历视图 ---
  const acceptedProposals = report.alignments
    .filter(a => a.status === "weak_expression")
    .map(a => ({
      id: a.id,
      suggestion: a.suggestedText || "",
      originalClaimText: a.currentResumeText || ""
    }));

  assert.ok(acceptedProposals.length > 0, "用户采纳了至少1项优化建议");

  // 模拟将采纳的建议注入定制经历中
  const customResumeClaims = [
    ...candidateResume.experiences[0].claims,
    ...acceptedProposals.map((p, idx) => ({
      id: `custom-claim-${idx}`,
      kind: "action",
      text: p.suggestion,
      tags: ["AI定制", "梅特勒托利多"]
    }))
  ];

  // 校验生成后的定制版履历
  assert.ok(customResumeClaims.length > candidateResume.experiences[0].claims.length, "定制简历成功合成了采纳的增强内容");
  assert.equal(candidateResume.profile.education, "江苏电子信息职业学院 · 大专 · 电子信息工程技术", "防编造保护：候选人原始大专事实未被篡改");
});
