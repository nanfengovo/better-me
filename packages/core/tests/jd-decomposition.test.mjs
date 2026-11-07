import assert from "node:assert/strict";
import test from "node:test";
import {
  decomposeJdText,
  alignJdWithResume,
  DecomposedJdSchema,
  JdEvidenceAlignmentReportSchema,
} from "../dist/index.js";

const sampleJdText = `
【岗位职责】
1. 负责核心业务分布式后端服务的架构设计与核心研发。
2. 负责高并发消息队列（Kafka/RabbitMQ）与 Redis 缓存架构优化，保障 99.99% 高可用。
3. 配合团队解决生产环境性能瓶颈与疑难崩溃故障。

【任职要求】
1. 本科及以上学历，计算机相关专业，5年及以上 C# / .NET 开发经验。
2. 熟练掌握 ASP.NET Core、微服务架构以及 RESTful / gRPC 接口开发。
3. 熟悉 MySQL / PostgreSQL 数据库设计与 SQL 性能调优。
4. 深入理解 Kubernetes 与云原生容器化部署运维。

【加分项】
1. 有开源项目贡献经历者优先。
2. 熟悉 Go 语言或 Rust 语言者优先。

【工作地点】
上海市浦东新区张江高科技园区
`;

const sampleResume = {
  locale: "zh",
  templateId: "zh-classic",
  profile: { displayName: "张测试", links: [], targetRoles: ["高级后端工程师"], traits: [] },
  experiences: [
    {
      id: "exp-1",
      type: "work",
      org: "某知名互联网科技",
      title: "资深后端开发工程师",
      start: "2021-03",
      end: null,
      techStack: ["C#", ".NET", "Redis", "Kafka", "MySQL"],
      claims: [
        {
          id: "claim-1",
          kind: "action",
          text: "主导分布式消息推送中台研发，基于 Kafka 与 Redis 缓存重构消息流转机制，支撑日常 QPS 8000+，峰值延迟下降 45%。",
          tags: ["architecture", "performance"],
        },
        {
          id: "claim-2",
          kind: "action",
          text: "负责核心服务基于 ASP.NET Core 的微服务微重构，编写 gRPC 内部调用链路与 MySQL 读写分离方案。",
          tags: ["backend"],
        },
      ],
    },
  ],
};

test("decomposeJdText correctly separates sections and preserves exact quotes", () => {
  const decomposed = decomposeJdText(sampleJdText, {
    title: "资深 .NET 后端开发",
    company: "未来科技",
    location: "上海",
  });

  // Check Schema validity
  assert.doesNotThrow(() => DecomposedJdSchema.parse(decomposed));

  assert.equal(decomposed.title, "资深 .NET 后端开发");
  assert.equal(decomposed.company, "未来科技");

  // Check Responsibilities
  assert.equal(decomposed.responsibilities.length, 3);
  assert.equal(
    decomposed.responsibilities[1].originalQuote,
    "2. 负责高并发消息队列（Kafka/RabbitMQ）与 Redis 缓存架构优化，保障 99.99% 高可用。"
  );
  assert.ok(decomposed.responsibilities[1].keywords.includes("Kafka"));
  assert.ok(decomposed.responsibilities[1].keywords.includes("Redis"));
  assert.equal(decomposed.responsibilities[1].section, "responsibility");

  // Check Hard Requirements
  assert.equal(decomposed.hardRequirements.length, 4);
  assert.ok(
    decomposed.hardRequirements.some((r) => r.originalQuote.includes("C# / .NET 开发经验"))
  );
  assert.ok(
    decomposed.hardRequirements.some((r) => r.keywords.includes("Kubernetes"))
  );

  // Check Preferences
  assert.equal(decomposed.preferredQualifications.length, 2);
  assert.ok(
    decomposed.preferredQualifications.some((p) => p.keywords.includes("Go") || p.keywords.includes("Rust"))
  );

  // Check Constraints
  assert.equal(decomposed.constraints.length, 1);
  assert.ok(decomposed.constraints[0].originalQuote.includes("上海市浦东新区"));

  // Check global detected tech stack
  assert.ok(decomposed.detectedTechStack.includes("C#"));
  assert.ok(decomposed.detectedTechStack.includes(".NET"));
  assert.ok(decomposed.detectedTechStack.includes("Kafka"));
  assert.ok(decomposed.detectedTechStack.includes("Redis"));
  assert.ok(decomposed.detectedTechStack.includes("Kubernetes"));
});

test("alignJdWithResume accurately matches evidence and detects gaps without fabricating", () => {
  const decomposed = decomposeJdText(sampleJdText, { title: "资深工程师" });
  const alignment = alignJdWithResume(decomposed, sampleResume);

  // Check Schema validity
  assert.doesNotThrow(() => JdEvidenceAlignmentReportSchema.parse(alignment));

  // Should have verified match for Kafka + Redis
  const verifiedItems = alignment.alignments.filter((a) => a.status === "verified_match");
  assert.ok(verifiedItems.length >= 1, "Should have at least 1 verified match");
  const kafkaMatch = verifiedItems.find((v) => v.jdItem.keywords.includes("Kafka"));
  assert.ok(kafkaMatch, "Kafka/Redis responsibility should be verified");
  assert.equal(kafkaMatch.matchedClaimId, "claim-1");
  assert.ok(kafkaMatch.currentResumeText.includes("QPS 8000+"));

  // Should have weak expression for C# / .NET / MySQL where claim has no metrics or needs focus
  const weakItems = alignment.alignments.filter((a) => a.status === "weak_expression");
  assert.ok(weakItems.length >= 1, "Should have at least 1 weak expression");

  // Should have gap for Kubernetes (not in resume)
  const gapItems = alignment.alignments.filter((a) => a.status === "gap");
  const k8sGap = gapItems.find((g) => g.jdItem.keywords.includes("Kubernetes"));
  assert.ok(k8sGap, "Kubernetes requirement should be flagged as gap");
  assert.match(k8sGap.rationale, /防编造原则/);

  // Metrics check
  assert.ok(alignment.metrics.matchScore > 0 && alignment.metrics.matchScore <= 100);
  assert.equal(
    alignment.metrics.verifiedCount + alignment.metrics.weakCount + alignment.metrics.gapCount,
    alignment.alignments.length
  );

  // Defense questions generated
  assert.ok(alignment.defenseQuestions.length > 0);
});
