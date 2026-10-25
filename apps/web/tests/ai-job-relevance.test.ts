import test from "node:test";
import assert from "node:assert/strict";
import type { CanonicalJob } from "@better-me/opportunities";
import { analyzeAiJobRelevance } from "../src/components/atlas/ai-job-relevance";

test("Tesla C# Graduate Developer: AI Agent accurately penetrates generic title to extract C# and ASP.NET Core", () => {
  const teslaJob: CanonicalJob = {
    id: "job_tesla_grad_csharp",
    companyId: "comp_tesla",
    title: {
      value: "0-2年毕业生-开发工程师",
      method: "source-structured",
      verification: "verified",
      revision: 1,
      evidence: [],
    },
    description: `0-2年毕业生-开发工程师 15-25K·14薪 上海·浦东新区·张江 经验不限 本科 特斯拉 5000-10000人
【团队介绍】特斯拉全球供应链与制造系统开发团队，负责核心工业软件及自动化产线系统研发。
【岗位职责】
1. 参与特斯拉全球制造与供应链核心平台的功能开发与日常运维；
2. 配合跨国工程团队完成微服务架构设计与高可用后端服务实现。
【任职要求】
• 计算机科学、软件工程或相关专业本科及以上学历；
• 熟练掌握 C# 编程语言，熟悉 .NET 平台（如 .NET Core / .NET 6+）及常见开发框架（如 ASP.NET Core）；
• 熟悉关系型数据库（如 MySQL、SQL Server）及 SQL 编写与优化；
• 具备良好的英语听说读写能力，能够作为工作语言使用。`,
    locationIds: ["loc_1"],
    compensationIds: [],
    listingIds: ["list_1"],
    status: "open",
    workMode: "on-site",
    employmentType: "campus",
    remoteEligibleRegions: [],
    updatedAt: new Date().toISOString(),
    revision: 1,
  };

  const result = analyzeAiJobRelevance(teslaJob, "C#", "特斯拉");

  assert.equal(result.isGenericTitle, true);
  assert.equal(result.isImplicitMatch, true);
  assert.equal(result.isPenetrated, true);
  assert.equal(result.matchKind, "implicit-tech-penetration");
  assert.ok(result.confidence >= 95, "Confidence should be >= 95%");
  assert.ok(result.highlightSkillText.includes("C#"), "Highlight text should contain C#");
  assert.ok(result.highlightSkillText.includes("ASP.NET Core") || result.highlightSkillText.includes(".NET"), "Highlight text should contain .NET/ASP.NET Core");
  assert.ok(result.highlightSnippet?.includes("熟练掌握 C# 编程语言"), "Snippet should quote the exact requirement");
  assert.ok(result.reason.includes("0-2年毕业生-开发工程师"), "Reason should mention the original title");
});

test("Direct Title Match: C# 软件开发工程师 is recognized as direct title match", () => {
  const directJob: CanonicalJob = {
    id: "job_direct_csharp",
    companyId: "comp_1",
    title: {
      value: "C# 软件开发工程师",
      method: "source-structured",
      verification: "verified",
      revision: 1,
      evidence: [],
    },
    description: "负责工控上位机系统研发，要求精通 C# 与 WPF。",
    locationIds: ["loc_1"],
    compensationIds: [],
    listingIds: ["list_1"],
    status: "open",
    workMode: "on-site",
    employmentType: "social",
    remoteEligibleRegions: [],
    updatedAt: new Date().toISOString(),
    revision: 1,
  };

  const result = analyzeAiJobRelevance(directJob, "C#", "某科技公司");

  assert.equal(result.matchKind, "direct-title");
  assert.equal(result.isPenetrated, false);
  assert.equal(result.isImplicitMatch, false);
});

test("Unrelated Job: 行政专员 with no C# keywords is marked as none", () => {
  const unrelatedJob: CanonicalJob = {
    id: "job_unrelated",
    companyId: "comp_2",
    title: {
      value: "行政专员",
      method: "source-structured",
      verification: "verified",
      revision: 1,
      evidence: [],
    },
    description: "负责日常考勤及办公用品采购。",
    locationIds: ["loc_2"],
    compensationIds: [],
    listingIds: ["list_2"],
    status: "open",
    workMode: "on-site",
    employmentType: "social",
    remoteEligibleRegions: [],
    updatedAt: new Date().toISOString(),
    revision: 1,
  };

  const result = analyzeAiJobRelevance(unrelatedJob, "C#", "某贸易公司");

  assert.equal(result.matchKind, "none");
  assert.equal(result.isImplicitMatch, false);
  assert.equal(result.isPenetrated, false);
});

test("Java Backend Developer: AI Agent penetrates generic title 后端开发工程师 to extract Java and Spring Boot", () => {
  const javaJob: CanonicalJob = {
    id: "job_java_backend",
    companyId: "comp_java",
    title: {
      value: "后端开发工程师",
      method: "source-structured",
      verification: "verified",
      revision: 1,
      evidence: [],
    },
    description: `负责核心交易系统后端架构，任职要求：
• 熟练掌握 Java 核心编程，深入理解 JVM 内存模型与并发编程；
• 熟练使用 Spring Boot、Spring Cloud 微服务框架及 MyBatis；
• 具备 MySQL 高性能调优经验。`,
    locationIds: ["loc_java"],
    compensationIds: [],
    listingIds: ["list_java"],
    status: "open",
    workMode: "on-site",
    employmentType: "social",
    remoteEligibleRegions: [],
    updatedAt: new Date().toISOString(),
    revision: 1,
  };

  const result = analyzeAiJobRelevance(javaJob, "Java", "某金融科技");

  assert.equal(result.isGenericTitle, true);
  assert.equal(result.isImplicitMatch, true);
  assert.equal(result.isPenetrated, true);
  assert.equal(result.matchKind, "implicit-tech-penetration");
  assert.ok(result.highlightSkillText.includes("Java"));
  assert.ok(result.highlightSnippet?.includes("熟练掌握 Java 核心编程"));
});

test("Python AI Agent Developer: AI Agent penetrates generic title 算法工程师 to extract PyTorch, LLM and Agent", () => {
  const aiJob: CanonicalJob = {
    id: "job_ai_agent",
    companyId: "comp_ai",
    title: {
      value: "算法工程师",
      method: "source-structured",
      verification: "verified",
      revision: 1,
      evidence: [],
    },
    description: `智能体研发岗位职责：
• 负责大模型 Agent 架构设计与落地方案；
• 熟练运用 Python 与 PyTorch 开展模型微调与 RAG 检索增强；
• 具备 LangChain 与大模型应用开发经验。`,
    locationIds: ["loc_ai"],
    compensationIds: [],
    listingIds: ["list_ai"],
    status: "open",
    workMode: "on-site",
    employmentType: "social",
    remoteEligibleRegions: [],
    updatedAt: new Date().toISOString(),
    revision: 1,
  };

  const result = analyzeAiJobRelevance(aiJob, "Python", "某AI独角兽");

  assert.equal(result.isGenericTitle, true);
  assert.equal(result.isImplicitMatch, true);
  assert.equal(result.isPenetrated, true);
  assert.equal(result.matchKind, "implicit-tech-penetration");
  assert.ok(result.highlightSkillText.includes("Python") || result.highlightSkillText.includes("PyTorch") || result.highlightSkillText.includes("Agent"));
  assert.ok(result.highlightSnippet?.includes("Agent") || result.highlightSnippet?.includes("Python"));
});

test("Siemens Industrial Automation: AI Agent penetrates 【校招】应用研发工程师（自动化产线） to extract C#, WPF and PLC", () => {
  const siemensJob: CanonicalJob = {
    id: "job_siemens_csharp",
    companyId: "comp_siemens",
    title: {
      value: "【校招】应用研发工程师（自动化产线）",
      method: "source-structured",
      verification: "verified",
      revision: 1,
      evidence: [],
    },
    description: `西门子智能制造研发中心：
1. 负责数字化工厂自动化产线系统与上位机软件开发；
2. 任职资格：计算机或电气自动化专业，精通 C# 与 .NET Core 编程；
3. 熟练使用 WPF 与 MVVM 架构，具有 Modbus / PLC / SCADA 通讯开发经验者优先。`,
    locationIds: ["loc_siemens"],
    compensationIds: [],
    listingIds: ["list_siemens"],
    status: "open",
    workMode: "on-site",
    employmentType: "campus",
    remoteEligibleRegions: [],
    updatedAt: new Date().toISOString(),
    revision: 1,
  };

  const result = analyzeAiJobRelevance(siemensJob, "C#", "西门子");

  assert.equal(result.isGenericTitle, true);
  assert.equal(result.isImplicitMatch, true);
  assert.equal(result.isPenetrated, true);
  assert.equal(result.matchKind, "implicit-tech-penetration");
  assert.ok(result.highlightSkillText.includes("C#"));
  assert.ok(result.highlightSkillText.includes("WPF") || result.highlightSkillText.includes(".NET"));
  assert.ok(result.highlightSnippet?.includes("精通 C# 与 .NET Core"));
});

test("ByteDance Cloud Native: AI Agent penetrates 2026届校园招聘-后端研发工程师（深圳） to extract Golang and K8s", () => {
  const bytedanceJob: CanonicalJob = {
    id: "job_bytedance_go",
    companyId: "comp_bytedance",
    title: {
      value: "2026届校园招聘-后端研发工程师（深圳）",
      method: "source-structured",
      verification: "verified",
      revision: 1,
      evidence: [],
    },
    description: `字节跳动基础架构团队：
• 负责高并发分布式微服务治理与存储平台研发；
• 熟练掌握 Golang 编程与并发性能调优；
• 深入理解 K8s 与 Docker 容器化技术，具备 gRPC 开发经验。`,
    locationIds: ["loc_bytedance"],
    compensationIds: [],
    listingIds: ["list_bytedance"],
    status: "open",
    workMode: "on-site",
    employmentType: "campus",
    remoteEligibleRegions: [],
    updatedAt: new Date().toISOString(),
    revision: 1,
  };

  const result = analyzeAiJobRelevance(bytedanceJob, "Go", "字节跳动");

  assert.equal(result.isGenericTitle, true);
  assert.equal(result.isImplicitMatch, true);
  assert.equal(result.isPenetrated, true);
  assert.equal(result.matchKind, "implicit-tech-penetration");
  assert.ok(result.highlightSkillText.includes("Golang") || result.highlightSkillText.includes("K8s") || result.highlightSkillText.includes("gRPC"));
});
