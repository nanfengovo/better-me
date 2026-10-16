import type { FactBase } from "../schema/fact.js";

/** Lightweight, self-explanatory seed data designed as a clean product demonstration. */
export function createDemoFactBase(now = new Date().toISOString()): FactBase {
  return {
    schemaVersion: 1,
    updatedAt: now,
    profile: {
      displayName: { zh: "你的名字", en: "Your Name" },
      headline: {
        zh: "全栈研发工程师 · 专注于高可用系统架构与工程化落地",
        en: "Full-Stack Software Engineer · High-Availability Architecture",
      },
      yearsOfExperience: 3,
      education: {
        zh: "某重点大学 · 计算机科学与技术",
        en: "University Name · Computer Science",
      },
      location: { zh: "上海", en: "Shanghai" },
      email: "your.email@example.com",
      phone: "+86 138-0000-0000",
      links: [
        {
          label: "GitHub",
          url: "https://github.com/your-username",
        },
      ],
      traits: ["系统架构", "快速落地", "技术驱动业务"],
      targetRoles: [
        {
          zh: "高级全栈开发工程师",
          en: "Senior Full-Stack Engineer",
        },
        {
          zh: "后端系统架构师",
          en: "Backend Systems Architect",
        },
      ],
      constraints: [
        "0 出差 (研发岗)",
        "0 Oncall (健康研发节律)",
        "优质团队 / 拒绝纯现场打杂",
      ],
      salaryRange: { minK: 20, maxK: 28, currency: "CNY" },
    },
    experiences: [
      {
        id: "exp-sample-1",
        type: "work",
        org: {
          zh: "示例科技企业 · 核心系统研发部",
          en: "Sample Tech Inc. · Core Systems Division",
        },
        title: { zh: "高级开发工程师", en: "Senior Software Engineer" },
        start: "2023-01",
        end: null,
        projectName: {
          zh: "分布式高并发调度中台重构",
          en: "Distributed High-Concurrency Scheduling Platform",
        },
        techStack: ["TypeScript", "Node.js / .NET", "Redis", "PostgreSQL"],
        claims: [
          {
            id: "claim-sample-1",
            kind: "action",
            text: {
              zh: "主导中台核心通信与状态机模块重构，解耦异构数据源，提升业务扩展性",
              en: "Led the refactoring of core messaging and state-machine modules, decoupling heterogeneous datasources",
            },
            tags: ["architecture", "refactoring"],
          },
          {
            id: "claim-sample-2",
            kind: "metric",
            text: {
              zh: "优化缓存命中率与数据库慢查询，系统高峰期 P99 响应延迟降低 60%",
              en: "Optimized cache hit ratio and slow queries; reduced P99 latency by 60% during peak traffic",
            },
            metric: {
              value: 60,
              unit: "%",
              baseline: "重构前多表全量关联导致慢查询与锁等待",
              causal: "引入二级缓存与异步队列写入",
              confirmed: true,
            },
            tags: ["performance", "optimization"],
          },
          {
            id: "claim-sample-3",
            kind: "metric",
            text: {
              zh: "【示例】业务吞吐量提升 30%（此条未勾选核实，因此右侧简历预览中被自动安全过滤）",
              en: "[Demo] Throughput improved by 30% (Unconfirmed, automatically filtered in preview)",
            },
            metric: {
              value: 30,
              unit: "%",
              baseline: "优化前吞吐量",
              causal: "并发优化",
              confirmed: false,
            },
            tags: ["guardrail-demo"],
          },
        ],
      },
      {
        id: "exp-sample-2",
        type: "opensource",
        org: { zh: "开源社区", en: "Open Source" },
        title: { zh: "核心贡献者", en: "Core Contributor" },
        start: "2022-06",
        end: "2022-12",
        projectName: { zh: "LocalFirst-Storage-Toolkit", en: "LocalFirst-Storage-Toolkit" },
        url: "https://github.com/example/open-source-toolkit",
        techStack: ["TypeScript", "IndexedDB / SQLite", "WebWorker"],
        claims: [
          {
            id: "claim-sample-4",
            kind: "action",
            text: {
              zh: "探索本地优先（Local-First）存储与响应式数据流，编写完整的单元测试与中英文文档",
              en: "Explored local-first reactive storage mechanisms with comprehensive test coverage and bilingual docs",
            },
            tags: ["local-first", "open-source"],
          },
        ],
      },
    ],
  };
}
