import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openJobRepository, type JobRepository } from "../apps/job-service/src/repository.js";
import { createJobApplication } from "../apps/job-service/src/application.js";
import { createAmapOfficeProvider } from "../apps/job-service/src/office-address-provider.js";
import { projectSourcePage } from "../apps/job-service/src/projection.js";
import { queryJobs, type SourceDefinition } from "../packages/opportunities/src/index.js";
import type { SourceTransport, SourceTransportRequest, SourceTransportResponse, SourceJobRecord } from "../packages/source-adapters/src/index.js";

export interface SeedJobDef {
  id: string;
  title: string;
  companyName: string;
  city: string;
  province?: string;
  streetAddress: string;
  district: string;
  salaryRaw: string;
  monthlyMin: number;
  monthlyMax: number;
  monthsPerYear: number;
  amapGcj02: [number, number]; // [lon, lat] in GCJ-02
  formattedAddress: string;
  fullJd: {
    businessOverview: string;
    responsibilities: string[];
    requirements: string[];
    benefits: string[];
  };
}

export const REAL_OFFICE_SAMPLES: SeedJobDef[] = [
  // ==================== 上海 (Shanghai) ====================
  {
    id: "job-sh-01",
    title: ".NET 高级系统架构师",
    companyName: "张江信息技术股份有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "博云路2号",
    district: "浦东新区",
    salaryRaw: "35k-50k · 16薪",
    monthlyMin: 35000,
    monthlyMax: 50000,
    monthsPerYear: 16,
    amapGcj02: [121.603306, 31.200155],
    formattedAddress: "上海市浦东新区张江高科技园区博云路2号",
    fullJd: {
      businessOverview: "张江核心技术自研团队，承接国家级高并发数据底座与跨域协同中间件研发。",
      responsibilities: [
        "主导企业级高并发分布式系统的核心架构设计，解决超高并发、低延迟与高可用工程瓶颈",
        "深入演进 .NET 9 / C# 异步高性能管道，推动微服务治理、服务网格与无状态化水平扩展",
        "指导核心技术攻关，把控技术选型、代码质量、演进路线与生产稳定性防护",
      ],
      requirements: [
        "本科及以上学历，计算机或相关专业，8年以上 C# / .NET 核心后端开发经验",
        "深刻理解 CLR 运行机制、GC 分代收集、内存分配优化（Span/Memory）与无锁并发控制",
        "熟练掌握 Redis、Kafka、PostgreSQL、ElasticSearch 在海量数据下的性能调优",
      ],
      benefits: ["16薪全额社保公积金", "企业专属年假15天", "硅谷式弹性上下班", "张江人才公租房补贴"],
    },
  },
  {
    id: "job-sh-02",
    title: "C# 云原生分布式中间件研发",
    companyName: "未来微电子技术（上海）有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "碧波路690号",
    district: "浦东新区",
    salaryRaw: "28k-40k · 15薪",
    monthlyMin: 28000,
    monthlyMax: 40000,
    monthsPerYear: 15,
    amapGcj02: [121.587843, 31.201482],
    formattedAddress: "上海市浦东新区碧波路690号张江微电子港",
    fullJd: {
      businessOverview: "面向半导体芯片产线与精密微电子制造的低时延设备数据采集与流转中枢。",
      responsibilities: [
        "研发基于 C# / K8s 的超低时延微服务框架与自研 RPC 通信协议",
        "负责秒级千万点位传感器数据的缓存分发、协议解析与异常断线补偿机制",
        "与边缘端网关协同设计可靠重传与断点断网本地续传方案",
      ],
      requirements: [
        "5年以上 .NET Core / C# 后端架构研发经验，有分布式系统上线经历",
        "熟悉 gRPC、K8s 容器化编排、OpenTelemetry 观测链路与 Prometheus 监控",
        "具有良好的代码洁癖与单元测试习惯，注重代码健壮性与防御性设计",
      ],
      benefits: ["15薪", "补充商业医疗保险", "年度高端体检", "团队定期技术极客派对"],
    },
  },
  {
    id: "job-sh-03",
    title: "工业自动化软件主管（C#/.NET）",
    companyName: "展想智能系统工程有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "祖冲之路2288号",
    district: "浦东新区",
    salaryRaw: "30k-45k · 14薪",
    monthlyMin: 30000,
    monthlyMax: 45000,
    monthsPerYear: 14,
    amapGcj02: [121.632145, 31.210982],
    formattedAddress: "上海市浦东新区祖冲之路2288号展想广场",
    fullJd: {
      businessOverview: "国内领先的自动化产线与智能工业控制综合解决方案供应商。",
      responsibilities: [
        "负责工控上位机系统架构，集成 PLC、运动控制器、工业相机等多源硬件",
        "基于 WPF 和最新 .NET 平台构建高流畅度、毫秒级响应的现代化工业交互界面",
        "制定团队开发规范与硬件驱动仿真测试标准，带领团队高效交付大型制造项目",
      ],
      requirements: [
        "精通 C# / WPF / MVVM 架构，有 6 年以上工控或大型仪器控制软件架构经验",
        "精通 Modbus、OPC UA、EtherCAT、TCP/IP 等工业通信协议与底层驱动调试",
        "具备扎实的数学与几何算法基础，能够独立排查硬件通信与多线程时序死锁问题",
      ],
      benefits: ["14薪", "项目成功里程碑奖金", "免费员工食堂", "自驾停车补贴"],
    },
  },
  {
    id: "job-sh-04",
    title: "资深后端开发工程师（.NET Core）",
    companyName: "华鑫数字创新科技有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "田林路200号",
    district: "徐汇区",
    salaryRaw: "25k-38k · 14薪",
    monthlyMin: 25000,
    monthlyMax: 38000,
    monthsPerYear: 14,
    amapGcj02: [121.401123, 31.170231],
    formattedAddress: "上海市徐汇区田林路200号华鑫天地",
    fullJd: {
      businessOverview: "专注于企业级 SaaS 协同与供应链数字化运营平台的科技创新企业。",
      responsibilities: [
        "参与核心商业结算、订单履约与权限中心服务的高并发微服务开发",
        "负责数据库分库分表设计、SQL 执行计划深度优化与慢查询治理",
        "持续重构遗留单体系统为领域驱动（DDD）解耦的现代化云原生微服务体系",
      ],
      requirements: [
        "本科及以上计算机专业学历，4年以上 .NET Core / ASP.NET Core 研发经验",
        "深入理解领域驱动设计（DDD）、CQRS 架构模式与事件驱动流式处理",
        "精通 EF Core、Dapper 及关系型数据库并发隔离级别与事务传播机制",
      ],
      benefits: ["14薪", "全额五险一金", "每月团建活动金", "带薪病假7天"],
    },
  },
  {
    id: "job-sh-05",
    title: "高性能物联网平台架构师（C#）",
    companyName: "普天智能网联技术股份有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "宜山路700号",
    district: "徐汇区",
    salaryRaw: "32k-48k · 15薪",
    monthlyMin: 32000,
    monthlyMax: 48000,
    monthsPerYear: 15,
    amapGcj02: [121.411234, 31.178921],
    formattedAddress: "上海市徐汇区宜山路700号普天信息产业园",
    fullJd: {
      businessOverview: "服务于智慧城市、车联网与大型园区的海量高并发物联网资产连接管理平台。",
      responsibilities: [
        "负责百万级并发 MQTT/CoAP 物联网设备接入网关与数据分发架构设计",
        "设计基于 C# Pipeline 与 Channels 的无分配低开销网络报文吞吐引擎",
        "保障全天候 99.99% 的服务可用性与水平故障隔离能力",
      ],
      requirements: [
        "6年以上网络服务端研发经验，精通基于 Socket/DotNetty 的高性能异步通信模型",
        "熟悉海量时序数据存储与计算（如 ClickHouse、IoTDB、InfluxDB）",
        "具备高并发线上疑难故障（内存泄漏、CPU毛刺、线程饥饿）排查定位实战经验",
      ],
      benefits: ["15薪", "企业年金", "徐汇漕河泾园区班车", "健身房与室内球场"],
    },
  },
  {
    id: "job-sh-06",
    title: "零售金融核心引擎工程师（.NET 9）",
    companyName: "长泰数科软件有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "金科路2889号",
    district: "浦东新区",
    salaryRaw: "30k-42k · 14薪",
    monthlyMin: 30000,
    monthlyMax: 42000,
    monthsPerYear: 14,
    amapGcj02: [121.604123, 31.205432],
    formattedAddress: "上海市浦东新区金科路2889号长泰广场",
    fullJd: {
      businessOverview: "服务于股份制银行与持牌消费金融机构的核心账务与风控计价引擎平台。",
      responsibilities: [
        "负责金融核心计息、日终跑批与跨机构清结算交易系统的 C# 核心开发",
        "构建基于两阶段提交与分布式事务 Saga 编排的严密资损防线",
        "持续压测并提升核心记账交易接口的 QPS 与 P99 响应延时指标",
      ],
      requirements: [
        "本科及以上学历，4-7年金融、支付、征信或电商大促后台研发经验",
        "对数据一致性、防重放、幂等性设计与审计追踪日志机制有深厚理解与落地实战",
        "熟练掌握 C# 多线程同步机制与内存零拷贝技术",
      ],
      benefits: ["14薪", "补充医疗险与家属连带险", "长泰商圈员工折扣优惠"],
    },
  },
  {
    id: "job-sh-07",
    title: "数字孪生渲染管线专家（C# / WebGPU）",
    companyName: "创智天地数字媒体技术中心",
    city: "上海市",
    province: "上海市",
    streetAddress: "政立路485号",
    district: "杨浦区",
    salaryRaw: "35k-55k · 16薪",
    monthlyMin: 35000,
    monthlyMax: 55000,
    monthsPerYear: 16,
    amapGcj02: [121.512345, 31.309876],
    formattedAddress: "上海市杨浦区政立路485号创智天地",
    fullJd: {
      businessOverview: "自研三维智慧城市空间孪生平台与基于微服务协同的实时图形计算管线。",
      responsibilities: [
        "开发三维地理信息轻量化剖分与流式加载服务端，基于 C# 实现空间点云降采样",
        "与前端协同优化大规模网格合并、视锥剔除与 WebGPU/DirectX 着色器渲染",
        "参与空间拓扑计算、空间索引 RTree/BVH 的底层 C# 极致算法优化",
      ],
      requirements: [
        "5年以上计算机图形学或空间地理信息系统开发经验，数学与几何功底扎实",
        "精通 C# / C++ 原生混合编程，熟悉 P/Invoke 与高性能内存跨语言交互",
        "有 Unity、Unreal 或自研渲染引擎深度架构开发经验者优先",
      ],
      benefits: ["16薪", "每年海外技术峰会公费差旅", "五角场创智天地优质办公环境"],
    },
  },
  {
    id: "job-sh-08",
    title: "嵌入式与工控上位机资深工程师",
    companyName: "纳贤精密机械电子有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "纳贤路800号",
    district: "浦东新区",
    salaryRaw: "24k-35k · 13薪",
    monthlyMin: 24000,
    monthlyMax: 35000,
    monthsPerYear: 13,
    amapGcj02: [121.608923, 31.181234],
    formattedAddress: "上海市浦东新区纳贤路800号科海大楼",
    fullJd: {
      businessOverview: "智能芯片封装测试设备与精密微米级运动控制软件研制基地。",
      responsibilities: [
        "负责芯片测试分选机上位机控制软件的全套 C# 代码编写与联调",
        "对接各类视觉定位相机与高速运动控制卡（固高、雷赛、倍福等）",
        "负责生产线异常自恢复状态机设计与故障可追溯历史曲线日志归档",
      ],
      requirements: [
        "3年以上工控运动控制系统或自动化设备上位机开发经验",
        "熟悉多轴插补、PID 闭环反馈调节与机械振动抑制算法流程",
        "熟练运用 C# 编写高质量多线程异步驱动，严谨细致，有极佳责任心",
      ],
      benefits: ["13薪全额社保", "提供免费早午餐", "定期技术轮训与导师带教"],
    },
  },
  {
    id: "job-sh-09",
    title: "航空货运物流调度算法与 .NET 服务端",
    companyName: "虹桥万科现代物流软件有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "申长路988号",
    district: "闵行区",
    salaryRaw: "28k-40k · 14薪",
    monthlyMin: 28000,
    monthlyMax: 40000,
    monthsPerYear: 14,
    amapGcj02: [121.314567, 31.198765],
    formattedAddress: "上海市闵行区申长路988号虹桥万科中心",
    fullJd: {
      businessOverview: "辐射亚太枢纽的国际空运智能装载算法、货运动态调度与实时报关中枢。",
      responsibilities: [
        "负责航空货机三维配载装箱算法工程化落地的 .NET 微服务研发",
        "构建毫秒级全链路货运轨迹预测、航班延误应急动态重调计算流",
        "打造高容错、跨时区、支持高并发报文对接的微服务集群",
      ],
      requirements: [
        "4年以上 C# / .NET Core 后端开发经验，具备运筹优化算法工程化经验者优先",
        "熟练掌握 RabbitMQ、Redis、Docker 容器化与 Linux 生产环境部署排错",
        "具备扎实的系统建模思维与面对复杂突发业务规则的敏捷抽象能力",
      ],
      benefits: ["14薪", "虹桥枢纽甲级写字楼", "全天候现磨咖啡水果零食无限供应"],
    },
  },
  {
    id: "job-sh-10",
    title: "医疗影像实时处理系统开发（C#/.NET）",
    companyName: "大宁微智健康科技股份有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "万荣路700号",
    district: "静安区",
    salaryRaw: "30k-46k · 15薪",
    monthlyMin: 30000,
    monthlyMax: 46000,
    monthsPerYear: 15,
    amapGcj02: [121.445678, 31.289012],
    formattedAddress: "上海市静安区万荣路700号大宁微智谷",
    fullJd: {
      businessOverview: "三甲医院数字化手术室、超声与内窥镜 4K 医疗影像实时工作站研发创新中心。",
      responsibilities: [
        "开发超低延迟医用 DICOM 影像流传输、无损解码与三维体绘制服务端",
        "基于 C# 构建医疗合规（FDA/NMPA）标准的影像标注、配准与病灶自动分析套件",
        "优化影像工作站内存占用，实现超大超高清扫描切片序列秒级平滑浏览",
      ],
      requirements: [
        "精通 C# 与 .NET Core，了解 DICOM 协议与常用医疗图像库（VTK/ITK/Fo-DICOM）",
        "掌握 GPU 硬件加速与内存复用优化技术，具备高性能多线程编程功底",
        "有医疗器械软件开发经验者优先，对生命科学与健康事业具备认同感",
      ],
      benefits: ["15薪", "补充三甲医院尊享就医通道", "年度父母深度体检卡"],
    },
  },
  {
    id: "job-sh-11",
    title: "智能汽车车载通信协议栈（C#）",
    companyName: "人工智能岛创新网络有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "海趣路367号",
    district: "浦东新区",
    salaryRaw: "32k-50k · 15薪",
    monthlyMin: 32000,
    monthlyMax: 50000,
    monthsPerYear: 15,
    amapGcj02: [121.619876, 31.175432],
    formattedAddress: "上海市浦东新区海趣路367号张江人工智能岛",
    fullJd: {
      businessOverview: "专注高等级自动驾驶车云协同（V2X）与数字座舱车载通信核心中间件。",
      responsibilities: [
        "研发基于 C# NativeAOT 的跨平台边缘车载通信协议中间件（SOME/IP、DDS）",
        "设计车载黑匣子海量数据高速流式序列化与断点落盘机制",
        "参与车规级功能安全 ISO 26262 流程规范与鲁棒性自动化验收体系建设",
      ],
      requirements: [
        "5年以上车载软件、物联网边缘网关或网络协议栈核心开发经验",
        "深入掌握最新 C# 语言特性、Native AOT 编译剪裁与跨平台运行时环境",
        "熟悉 Linux 内核网络参数调优与 Wireshark 深度报文分析诊断",
      ],
      benefits: ["15薪", "内购专属新能源购车折扣与免费充电桩", "人工智能岛花园园区"],
    },
  },
  {
    id: "job-sh-12",
    title: "半导体制造执行系统 MES 架构师",
    companyName: "集电港集成电路工业互联网中心",
    city: "上海市",
    province: "上海市",
    streetAddress: "丹桂路899号",
    district: "浦东新区",
    salaryRaw: "35k-52k · 16薪",
    monthlyMin: 35000,
    monthlyMax: 52000,
    monthsPerYear: 16,
    amapGcj02: [121.628765, 31.218901],
    formattedAddress: "上海市浦东新区丹桂路899号张江集电港",
    fullJd: {
      businessOverview: "自主可控 12 英寸晶圆制造产线大型工业软件 MES/CIM 系统的国家级研制平台。",
      responsibilities: [
        "主导超大规模晶圆厂生产调度与良率追溯 MES 核心引擎的重构与架构升级",
        "运用 C# 微服务技术处理晶圆在制（WIP）派工实时计算与设备自动化指令交互",
        "建立 7×24 小时不间断生产的高可用容灾体系与秒级双活倒换机制",
      ],
      requirements: [
        "7年以上大型制造行业 MES / ERP 架构经验，有半导体或高端制造业经验者大加分",
        "精通 C# / .NET 核心技术栈，具备超大型关系型数据库与列式存储架构设计能力",
        "出色的跨团队沟通与工程攻坚能力，能应对严苛的工业级容错要求",
      ],
      benefits: ["16薪", "核心骨干股票期权激励", "张江临港落户加分推荐通道"],
    },
  },
  {
    id: "job-sh-13",
    title: "量化交易柜台微秒级接入服务（C#）",
    companyName: "凌空量化金融软件技术有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "金钟路968号",
    district: "长宁区",
    salaryRaw: "40k-65k · 16薪",
    monthlyMin: 40000,
    monthlyMax: 65000,
    monthsPerYear: 16,
    amapGcj02: [121.352345, 31.220123],
    formattedAddress: "上海市长宁区金钟路968号凌空SOHO",
    fullJd: {
      businessOverview: "头部量化对冲基金技术支持中心，负责全品种微秒级程序化交易与行情分发底座。",
      responsibilities: [
        "基于 C# / .NET 9 打造极低抖动（Jitter-free）的交易柜台行情网关与订单路由系统",
        "深度调优 CPU 亲和性、内存页锁定、免 GC 环形缓冲区与内核旁路网络机制",
        "研发自动化撮合仿真、订单回放检验与毫秒级实时风控阻断拦截模块",
      ],
      requirements: [
        "精通 C# 底层运行机制与硬件体系结构（CPU缓存行对齐、分支预测、内存栅栏）",
        "具有头部证券、期货、公募量化或高频交易平台系统核心开发背景",
        "能熟练使用 BenchmarkDotNet、dotTrace、PerfView 展开纳秒/微秒级火焰图深度分析",
      ],
      benefits: ["16薪 + 顶尖策略超额提成", "凌空SOHO地标办公", "全员配备顶配开发工作站与多屏显示器"],
    },
  },
  {
    id: "job-sh-14",
    title: "外资企业级金融报表与结算系统负责人",
    companyName: "永银企业管理咨询（上海）有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "西藏南路218号",
    district: "黄浦区",
    salaryRaw: "35k-50k · 14薪",
    monthlyMin: 35000,
    monthlyMax: 50000,
    monthsPerYear: 14,
    amapGcj02: [121.482345, 31.228901],
    formattedAddress: "上海市黄浦区西藏南路218号永银大厦",
    fullJd: {
      businessOverview: "跨国金融机构亚太区数字化财资结算中心，管理全球多币种跨国实时资金归集。",
      responsibilities: [
        "负责外资银行跨境多币种结算报表与财税审计系统的 .NET 架构研发",
        "保证系统在多时区、多监管合规司法管辖区规则下的严密性与不可伪造性",
        "带领中英双语工程团队对接全球总部总账与资产清算接口",
      ],
      requirements: [
        "计算机相关本科以上学历，6年以上企业级系统架构经验，英语可作为工作语言",
        "精通 C# / ASP.NET Core 与大型企业级微服务分布式事务架构设计",
        "熟悉 ISO 20022、SWIFT 报文规范与国际金融会计核算基本准则",
      ],
      benefits: ["14薪", "年假18天", "全额商业高端健康险覆盖配偶与子女", "黄浦江畔景观工位"],
    },
  },
  {
    id: "job-sh-15",
    title: "生物医药高通量筛选控制软件（C#）",
    companyName: "张江创新园生命科学软件有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "科苑路399号",
    district: "浦东新区",
    salaryRaw: "28k-42k · 14薪",
    monthlyMin: 28000,
    monthlyMax: 42000,
    monthsPerYear: 14,
    amapGcj02: [121.594567, 31.206789],
    formattedAddress: "上海市浦东新区科苑路399号张江创新园",
    fullJd: {
      businessOverview: "AI 药物发现与高通量生物机器人实验室自动化移液及显微成像控制软件中心。",
      responsibilities: [
        "主导生物医药全自动液体处理工作站控制软件的 WPF / C# 架构开发",
        "研发高精度微孔板识别定位视觉算法联动与多轴机械臂防碰撞路径规划逻辑",
        "保障实验流程全生命周期审计追踪满足 FDA 21 CFR Part 11 合规标准",
      ],
      requirements: [
        "本科以上学历，计算机、自动化或生物信息工程交叉背景，4年以上 C# 实战经验",
        "精通 WPF、异步多线程状态机、串口/网口仪器驱动封装与异常容错",
        "具备较强的科研协作精神与动手调试复杂软硬件系统的耐受力",
      ],
      benefits: ["14薪", "生物医药专项研发奖金", "工作环境洁净清新", "弹性打卡"],
    },
  },
  {
    id: "job-sh-16",
    title: "智能仓储搬运 AGV 调度控制平台",
    companyName: "临港松江工业软件创新基地",
    city: "上海市",
    province: "上海市",
    streetAddress: "莘砖公路518号",
    district: "松江区",
    salaryRaw: "26k-38k · 14薪",
    monthlyMin: 26000,
    monthlyMax: 38000,
    monthsPerYear: 14,
    amapGcj02: [121.319012, 31.098765],
    formattedAddress: "上海市松江区莘砖公路518号临港松江科技城",
    fullJd: {
      businessOverview: "智能物流与智慧无人仓万台级多车型集群协同调度系统研制基地。",
      responsibilities: [
        "负责大型智慧物流园区内数百台 AGV / AMR 实时多智能体交通流冲突避免算法调度服务",
        "基于 C# 构建超低延迟无线广播通信心跳网关，实时同步车辆位姿与负载状态",
        "构建支持数字孪生三维仿真的仓库运力动态热力图与拥堵预警平台",
      ],
      requirements: [
        "精通 C# / .NET Core 多线程开发，有运筹优化、路径搜索（A*、CBS）工程实现经验",
        "具备处理高并发网络长连接（WebSocket、TCP）、消息队列解耦架构能力",
        "为人诚信踏实，具备良好的现场部署与联调解决复杂未知问题能力",
      ],
      benefits: ["14薪", "松江科技城人才租房补贴", "园区班车直达地铁站", "免费健身中心"],
    },
  },
  {
    id: "job-sh-17",
    title: "多端智能硬件桌面交互套件（WPF / .NET 9）",
    companyName: "天会智能生活交互系统有限公司",
    city: "上海市",
    province: "上海市",
    streetAddress: "同普路602号",
    district: "普陀区",
    salaryRaw: "26k-36k · 13薪",
    monthlyMin: 26000,
    monthlyMax: 36000,
    monthsPerYear: 13,
    amapGcj02: [121.378901, 31.231234],
    formattedAddress: "上海市普陀区同普路602号天会商务广场",
    fullJd: {
      businessOverview: "面向千万级家庭与办公终端的智能物联硬件桌面配置、固件烧录与流媒体交互平台。",
      responsibilities: [
        "负责公司旗舰级桌面端智能硬件管理控制台的架构重构，全面拥抱 .NET 9 现代特性",
        "基于 WPF / WinUI 3 实现具有流畅微动效与沉浸式毛玻璃质感的顶级体验界面",
        "对接 USB HID、蓝牙 BLE、Wi-Fi Direct 多种设备配网与双向数据同步链路",
      ],
      requirements: [
        "4年以上 C# 桌面端研发经历，精通 XAML 样式模板定制与硬件底层交互",
        "深入理解响应式编程（ReactiveUI）、依赖注入与桌面端内存泄漏治理技巧",
        "具备审美追求与极客精神，对交互细节有极致打磨执念",
      ],
      benefits: ["13薪", "免费提供全套自研智能家居新品抢先体验", "扁平化工程师文化"],
    },
  },
  {
    id: "job-sh-18",
    title: "新能源三电系统在环仿真测试 HIL（C#）",
    companyName: "亮秀汽车电子研发中心",
    city: "上海市",
    province: "上海市",
    streetAddress: "亮秀路112号",
    district: "浦东新区",
    salaryRaw: "30k-45k · 15薪",
    monthlyMin: 30000,
    monthlyMax: 45000,
    monthsPerYear: 15,
    amapGcj02: [121.610123, 31.202345],
    formattedAddress: "上海市浦东新区亮秀路112号浦东软件园祖冲之园",
    fullJd: {
      businessOverview: "全球领先的新能源汽车动力电池、电机控制器与整车控制器硬实时在环仿真平台。",
      responsibilities: [
        "开发基于 C# 的实时自动化测试用例执行框架与波形信号发生与录制回放系统",
        "对接 CANoe、Vector、dSPACE、NI 等工业总线硬件接口与通信驱动",
        "搭建自动化持续集成流水线，实现日均数万条测试用例的无人值守自动化跑批",
      ],
      requirements: [
        "本科以上学历，汽车电子、自动化或测控仪器背景，熟练掌握 C# 面向对象开发",
        "熟悉 CAN、CAN-FD、LIN、以太网（DoIP）通信协议与 UDS 诊断协议栈",
        "工作作风严谨负责，具备优秀的问题追踪与跨学科软硬件协同攻坚能力",
      ],
      benefits: ["15薪", "新能源汽车研发专项成果奖励", "张江浦东软件园核心成熟商圈"],
    },
  },

  // ==================== 北京 (Beijing) ====================
  {
    id: "job-bj-01",
    title: ".NET 9 高性能量化柜台引擎架构师",
    companyName: "北京量化智算金融软件有限公司",
    city: "北京市",
    province: "北京市",
    streetAddress: "东北旺西路8号",
    district: "海淀区",
    salaryRaw: "45k-70k · 16薪",
    monthlyMin: 45000,
    monthlyMax: 70000,
    monthsPerYear: 16,
    amapGcj02: [116.294123, 40.046789],
    formattedAddress: "北京市海淀区中关村软件园二期东北旺西路8号",
    fullJd: {
      businessOverview: "依托中关村软件园顶尖智力高地，专注极低延迟国内股票与期权自动交易柜台研发。",
      responsibilities: [
        "运用 C# 与最新 .NET 9 特性重塑极速微秒级量化交易接口与委托订单管理系统",
        "优化核心热点路径内存模型，消除 GC 停顿对交易周期的干扰，实现超稳 P99.9 延迟",
        "设计容灾多活状态机复制协议，确保资金核算与持仓数据绝对精确",
      ],
      requirements: [
        "6年以上证券/期货极速柜台或量化系统底层核心研发经历，对 C# 性能调优有极深造诣",
        "精通 Linux 内核旁路、共享内存 IPC、CPU 核心独占与高分辨率时钟源编程",
        "具备强大的抗压能力与严密的系统风险防御底线意识",
      ],
      benefits: ["16薪 + 超额年终奖金", "中关村软件园独立餐厅与班车", "商业高端就诊全额报销"],
    },
  },
  {
    id: "job-bj-02",
    title: "分布式存储与云原生架构师（C# / K8s）",
    companyName: "望京数科智联科技有限公司",
    city: "北京市",
    province: "北京市",
    streetAddress: "望京街10号",
    district: "朝阳区",
    salaryRaw: "35k-50k · 15薪",
    monthlyMin: 35000,
    monthlyMax: 50000,
    monthsPerYear: 15,
    amapGcj02: [116.480856, 39.996321],
    formattedAddress: "北京市朝阳区望京街10号望京SOHO",
    fullJd: {
      businessOverview: "望京科技互联网核心区，提供跨公有云、混合云的海量对象存储与数据协同中枢。",
      responsibilities: [
        "负责自主研发的千万级 TPS 分布式元数据索引与分级存储调度平台",
        "构建基于 C# 现代异步模型的零拷贝数据搬运流，降低跨可用区网络传输延迟",
        "设计全自动化故障自愈 Operator，实现无感知节点热扩容与数据自动重平衡",
      ],
      requirements: [
        "5年以上云原生存储或大规模分布式架构研发经验，深入掌握 .NET Core 内部机理",
        "熟练掌握 Raft / Paxos 共识算法实现原理，有分布式存储实际生产实战经验",
        "具备优秀的跨团队技术领导力与全球视野的开源社区贡献经验者优先",
      ],
      benefits: ["15薪", "望京SOHO甲级地标办公", "灵活远程工作制度", "年终海外游团建"],
    },
  },
  {
    id: "job-bj-03",
    title: "高端数控机器人与上位机控制专家（WPF / .NET 9）",
    companyName: "亦庄智造机器人自动化系统股份有限公司",
    city: "北京市",
    province: "北京市",
    streetAddress: "荣华南路10号",
    district: "大兴区",
    salaryRaw: "30k-45k · 14薪",
    monthlyMin: 30000,
    monthlyMax: 45000,
    monthsPerYear: 14,
    amapGcj02: [116.512345, 39.792345],
    formattedAddress: "北京市大兴区经济技术开发区荣华南路10号大族广场",
    fullJd: {
      businessOverview: "国家级亦庄经济技术开发区重点工业机器人与先进制造数字化装备龙头企业。",
      responsibilities: [
        "主导多轴六自由度工业机器人示教编程与实时监控上位机软件体系开发",
        "运用 WPF / Prism / .NET 9 打造交互顺畅、支持三维数字孪生动态示教的操作面板",
        "深度封装多通道实时工业以太网通信中间件，实现微秒级脉冲同步与故障报警",
      ],
      requirements: [
        "本科以上学历，机电工程、软件工程专业，5年以上机器人或高端数控系统开发背景",
        "精通 C# / WPF / MVVM，精通动态曲线绘制、工业交互设计与性能分析",
        "熟悉机器人运动学、正逆解几何换算与轨迹平滑规划基础理论",
      ],
      benefits: ["14薪", "亦庄开发区公租房直报通道", "免费员工体检与健身中心"],
    },
  },
  {
    id: "job-bj-04",
    title: "医疗大模型边缘推理引擎服务端（C# / ONNX）",
    companyName: "汉王清流数字健康科技有限公司",
    city: "北京市",
    province: "北京市",
    streetAddress: "中关村南大街1号",
    district: "海淀区",
    salaryRaw: "32k-48k · 15薪",
    monthlyMin: 32000,
    monthlyMax: 48000,
    monthsPerYear: 15,
    amapGcj02: [116.321456, 39.967890],
    formattedAddress: "北京市海淀区中关村南大街1号友谊宾馆科技园",
    fullJd: {
      businessOverview: "结合自主知识产权大语言模型与医疗影像的医院边缘智能诊断一体机系统研发平台。",
      responsibilities: [
        "负责在医院私有化部署环境下运行的 C# 高性能微服务推理调度网关开发",
        "利用 ONNX Runtime / TensorRT 的 C# 绑定实现批量推理吞吐量与显存占用平衡优化",
        "研发严格符合患者隐私合规与医疗数据安全脱敏的本地化智能问诊知识引擎",
      ],
      requirements: [
        "4年以上 C# / .NET 核心开发经验，对 AI 深度学习推理部署有浓厚兴趣与落地实操",
        "熟悉跨平台原生库互操作、动态内存管理与低延迟并发流式响应输出（SSE/gRPC）",
        "逻辑清晰，善于与算法研究员及临床医生协同推进工程化快速迭代",
      ],
      benefits: ["15薪", "学院路名校环绕人文环境", "弹性工作制", "丰盛下午茶与零食"],
    },
  },

  // ==================== 深圳 (Shenzhen) ====================
  {
    id: "job-sz-01",
    title: "高并发分布式金融资产调度后台（C# / .NET）",
    companyName: "深圳前海微众数科创新技术有限公司",
    city: "深圳市",
    province: "广东省",
    streetAddress: "科苑南路3099号",
    district: "南山区",
    salaryRaw: "38k-55k · 16薪",
    monthlyMin: 38000,
    monthlyMax: 55000,
    monthsPerYear: 16,
    amapGcj02: [113.945678, 22.538901],
    formattedAddress: "深圳市南山区科技园科苑南路3099号中国储能大厦",
    fullJd: {
      businessOverview: "深圳南山科技园核心高地，专注亿级普惠金融与供应链资产流转的核心服务支撑。",
      responsibilities: [
        "负责高并发资金清算与分布式记账核心系统的持续演进与高性能重构",
        "基于 C# 构建弹性伸缩、自动故障转移与容灾多活的金融级交易通道",
        "通过严格的幂等机制、防并发超卖控制与流水核对保障资金安全无虞",
      ],
      requirements: [
        "本科以上计算机相关学历，6年以上主流高并发金融/电商后台系统实战经验",
        "深度精通 C# 语言体系，深刻理解高性能内存分配模型与高并发无锁编程",
        "熟悉常见金融级消息队列、分布式缓存与大型分布式数据库集群运维治理",
      ],
      benefits: ["16薪", "六险二金顶格缴纳", "南山科技园地铁直达", "年度无休健康体检"],
    },
  },
  {
    id: "job-sz-02",
    title: "工业视觉检测与实时多轴运动控制主管（C#）",
    companyName: "粤海精测智能装备制造有限公司",
    city: "深圳市",
    province: "广东省",
    streetAddress: "高新南九道12号",
    district: "南山区",
    salaryRaw: "30k-45k · 14薪",
    monthlyMin: 30000,
    monthlyMax: 45000,
    monthsPerYear: 14,
    amapGcj02: [113.934567, 22.522345],
    formattedAddress: "深圳市南山区粤海街道高新南九道12号",
    fullJd: {
      businessOverview: "粤海街道核心创新走廊，服务于高端消费电子精密外观与内部结构自动缺陷检测。",
      responsibilities: [
        "负责高精度工业相机图像采集与多轴激光位移测量联动的上位机控制系统",
        "构建基于 C# 多线程流水线的图像预处理、瑕疵分级与气动机械臂分选执行流",
        "带领团队优化整机节拍时间（UPH），将产线单颗物料检测总耗时压缩至极限",
      ],
      requirements: [
        "5年以上工业自动化系统研发经验，精通 C# / WPF 与工业硬件常用通讯总线",
        "熟悉 Halcon、OpenCV 或 VisionPro 图像处理库的二次集成与性能调优",
        "具备较强的现场排查软硬件偶发时序冲突故障的工程实操能力",
      ],
      benefits: ["14薪", "粤海街道高新企业专属人才补贴", "带薪年假12天", "年度双人团建游"],
    },
  },
  {
    id: "job-sz-03",
    title: "车规级智能座舱跨端交互框架（.NET MAUI / C#）",
    companyName: "坂田云谷微电系统有限公司",
    city: "深圳市",
    province: "广东省",
    streetAddress: "雪岗路2018号",
    district: "龙岗区",
    salaryRaw: "28k-42k · 15薪",
    monthlyMin: 28000,
    monthlyMax: 42000,
    monthsPerYear: 15,
    amapGcj02: [114.067890, 22.656789],
    formattedAddress: "深圳市龙岗区坂田街道雪岗路2018号天安云谷",
    fullJd: {
      businessOverview: "坂田智能网联产业集群核心企业，致力于打造新一代座舱多端协同与车机交互中枢。",
      responsibilities: [
        "负责车机中控、副驾娱乐屏与智能手机多端互联生态软件的基础架构研发",
        "基于 .NET MAUI / C# 实现跨平台 UI 响应体系与多点触控、语音手势交互调度",
        "与整车底层通信网关对接，确保座舱状态同步延迟控制在数十毫秒以内",
      ],
      requirements: [
        "精通 C# 与现代化跨平台应用框架开发，熟悉移动端与嵌入式 Linux 渲染管线",
        "对高性能 UI 动画、内存复用、字体渲染以及屏幕适配有深入理解",
        "热爱智能汽车行业，关注极致人机交互体验与技术创新",
      ],
      benefits: ["15薪", "天安云谷花园式商务办公", "园区人才公寓优先配租", "健身房与游泳池"],
    },
  },
  {
    id: "job-sz-04",
    title: "银行核心交易账务与对账系统专家（.NET 9）",
    companyName: "平安金科技术发展有限公司",
    city: "深圳市",
    province: "广东省",
    streetAddress: "益田路5033号",
    district: "福田区",
    salaryRaw: "36k-52k · 15薪",
    monthlyMin: 36000,
    monthlyMax: 52000,
    monthsPerYear: 15,
    amapGcj02: [114.055678, 22.533456],
    formattedAddress: "深圳市福田区益田路5033号平安金融中心",
    fullJd: {
      businessOverview: "立足福田 CBD 地标金融中枢，支撑千万级企业客户与跨境商贸的资金核算底座。",
      responsibilities: [
        "研发超大并发银行级总账凭证流转、跨系统轧差与海量对账批处理微服务系统",
        "通过严格的并发锁控制、版本控制与双向审计追踪，确保账实相符与账账相符",
        "引入 .NET 9 新特性的性能红利，显著缩短每日日终与月度结算批处理时间窗口",
      ],
      requirements: [
        "6年以上大型金融机构、银行核心系统或第三方支付账务核心架构开发背景",
        "深谙复式记账原理与分布式高可靠架构原则，具备面对不可控网络分区的防御设计经验",
        "精通 C# / SQL 深度性能调优，具备卓越的架构规划与大型项目落地把控能力",
      ],
      benefits: ["15薪", "平安金融中心超高层景观工位", "全额补充公积金与高端医疗", "带薪休假15天"],
    },
  },

  // ==================== 杭州 (Hangzhou) ====================
  {
    id: "job-hz-01",
    title: "供应链仓储数字孪生与调度引擎（C# / .NET）",
    companyName: "杭州西溪智能供应链网络有限公司",
    city: "杭州市",
    province: "浙江省",
    streetAddress: "文一西路969号",
    district: "余杭区",
    salaryRaw: "32k-48k · 16薪",
    monthlyMin: 32000,
    monthlyMax: 48000,
    monthsPerYear: 16,
    amapGcj02: [120.025678, 30.278901],
    formattedAddress: "浙江省杭州市余杭区文一西路969号阿里巴巴西溪园区",
    fullJd: {
      businessOverview: "立足未来科技城，为全球超级物流枢纽与自动化无人立体仓提供毫秒级动态调度能力。",
      responsibilities: [
        "主导千万级 SKU 仓储库存定位、拣选路径优化与搬运机器人实时协同调度系统的后端设计",
        "开发基于 C# 的高保真数字孪生仿真引擎，在物理仓上线前完成全仿真压力测试",
        "确保大促爆发期系统高并发抗压能力与断网本地自治连续生产能力",
      ],
      requirements: [
        "5年以上 C# / .NET 后端系统设计经验，熟悉大型分布式系统与复杂业务中台建模",
        "精通运筹优化算法、图论最短路径算法及其在工程系统中的低开销实现",
        "具备良好的架构抽象能力，善于将复杂的现实物理问题转化为严密的数学与软件模型",
      ],
      benefits: ["16薪", "未来科技城人才房补贴", "阿里西溪园区丰富餐饮与运动生活设施", "全员顶格社保"],
    },
  },
  {
    id: "job-hz-02",
    title: "跨平台在线协作与桌面端渲染套件（.NET 9 / Avalonia）",
    companyName: "网易（杭州）网络有限公司",
    city: "杭州市",
    province: "浙江省",
    streetAddress: "网商路599号",
    district: "滨江区",
    salaryRaw: "28k-42k · 15薪",
    monthlyMin: 28000,
    monthlyMax: 42000,
    monthsPerYear: 15,
    amapGcj02: [120.191234, 30.188901],
    formattedAddress: "浙江省杭州市滨江区网商路599号网易大厦",
    fullJd: {
      businessOverview: "网易滨江园区旗舰级数字内容生产力、多媒体音视频剪辑与协作工具研发大本营。",
      responsibilities: [
        "基于 C# / .NET 9 和 Avalonia 研发支持 Windows/macOS/Linux 的高性能多端桌面套件",
        "设计本地无锁渲染画布管线与协同编辑 OT/CRDT 算法工程实现",
        "优化大型多媒体工程文件序列化与本地 SQLite 数据库查询，达到启动即用秒开体验",
      ],
      requirements: [
        "4年以上 C# 桌面端或图形交互工具研发经验，对现代跨平台桌面开发有深刻洞见",
        "精通多线程异步响应式架构与内存占用调优，有开源桌面项目经验者大加分",
        "具备对产品交互的极高追求与匠人精神，注重每一像素的丝滑呈现",
      ],
      benefits: ["15薪", "网易免费猪肉大厦食堂", "园区健身房全天开放", "班车通达全杭主要居住区"],
    },
  },
  {
    id: "job-hz-03",
    title: "企业级跨境清结算微服务核心（C# / .NET Core）",
    companyName: "杭州蚁创金融软件有限公司",
    city: "杭州市",
    province: "浙江省",
    streetAddress: "西溪路556号",
    district: "西湖区",
    salaryRaw: "35k-50k · 15薪",
    monthlyMin: 35000,
    monthlyMax: 50000,
    monthsPerYear: 15,
    amapGcj02: [120.108901, 30.261234],
    formattedAddress: "浙江省杭州市西湖区西溪路556号蚂蚁Z空间",
    fullJd: {
      businessOverview: "坐落西溪路蚂蚁Z空间，连接全球数百个国家和地区商业清结算与合规风控的数字化中枢。",
      responsibilities: [
        "负责支撑全球多币种跨国实时外汇结算与资金融通交易核心模块的 C# 研发",
        "设计满足高并发、多时区、毫秒级风控评估的分布式微服务架构",
        "构建完备的端到端对账与资损熔断机制，实现系统级风险秒级自主阻断",
      ],
      requirements: [
        "精通 C# / ASP.NET Core 与分布式系统设计，熟悉高可用分布式架构模式",
        "具备深厚的数据结构与算法功底，在数据一致性保障与高可用实战方面经验丰富",
        "具备良好的自驱力和探索欲，追求代码的简洁、优雅与高可靠性",
      ],
      benefits: ["15薪", "蚂蚁Z空间顶级办公体验", "全员补充医疗保险", "弹性工作与浓厚工程师文化"],
    },
  },

  // ==================== 广州 (Guangzhou) ====================
  {
    id: "job-gz-01",
    title: "电商特卖实时秒杀与订单调度核心（C#）",
    companyName: "唯品会（中国）有限公司",
    city: "广州市",
    province: "广东省",
    streetAddress: "阅江西路242号",
    district: "海珠区",
    salaryRaw: "30k-45k · 15薪",
    monthlyMin: 30000,
    monthlyMax: 45000,
    monthsPerYear: 15,
    amapGcj02: [113.348901, 23.104567],
    formattedAddress: "广东省广州市海珠区琶洲阅江西路242号唯品会总部大厦",
    fullJd: {
      businessOverview: "珠江琶洲核心 CBD，负责唯品会核心电商限时特卖与峰值秒杀交易调度后台体系。",
      responsibilities: [
        "负责应对大促大流量峰值场景下订单秒杀、库存预占与结算扣减系统的性能压测与架构升级",
        "基于 C# 构建超低延迟多级缓存架构，抗住十万级 QPS 热点单品突发抢购冲击",
        "主导复杂促销规则引擎算法的抽象与执行流优化，保障用户领券与下单毫秒级计算",
      ],
      requirements: [
        "5年以上大型电商或高并发互联网系统服务端架构实战背景",
        "精通 C# 高并发高性能编程技巧，熟悉 Redis 核心源码机制与分布式限流降级方案",
        "严谨务实，对生产系统高可用治理、线上告警快速止血有成熟的方法论",
      ],
      benefits: ["15薪", "珠江一线江景总部大楼", "免费高品质员工早午晚餐", "琶洲创新区人才公寓支持"],
    },
  },
  {
    id: "job-gz-02",
    title: "高负载实时通信分布式服务器集群（C# / Orleans）",
    companyName: "科韵智娱互娱网络有限公司",
    city: "广州市",
    province: "广东省",
    streetAddress: "科韵路16号",
    district: "天河区",
    salaryRaw: "28k-40k · 14薪",
    monthlyMin: 28000,
    monthlyMax: 40000,
    monthsPerYear: 14,
    amapGcj02: [113.371234, 23.125678],
    formattedAddress: "广东省广州市天河区科韵路16号广州信息港",
    fullJd: {
      businessOverview: "广州信息港游戏互联网重镇，专注高负载多人在线互动网络通信架构。",
      responsibilities: [
        "基于 Microsoft Orleans 虚拟 Actor 模型构建海量玩家长连接分布式的游戏房间与世界服通信架构",
        "优化底层 TCP/KCP 网络数据包编解码管线，压降服务器内存开销与跨物理机通信跳数",
        "负责无停机热更新、分布式状态持久化与突发故障节点快速感知迁移",
      ],
      requirements: [
        "4年以上 C# 服务端网络游戏或高频分布式网络通信项目开发经验",
        "深度理解 Actor 模型、异步无锁并发模式与底层网络通信吞吐优化",
        "有实际使用 Microsoft Orleans、Akka.NET 或自研分布式 Actor 架构经历者优先",
      ],
      benefits: ["14薪", "信息港老牌互联网研发氛围", "不限量零食饮料夜宵", "项目丰厚分红激励"],
    },
  },

  // ==================== 成都 (Chengdu) ====================
  {
    id: "job-cd-01",
    title: "智能工业 CAD 几何建模算法与服务端（C#）",
    companyName: "天府几何智造软件技术有限公司",
    city: "成都市",
    province: "四川省",
    streetAddress: "天府大道天府软件园G区",
    district: "武侯区",
    salaryRaw: "25k-38k · 14薪",
    monthlyMin: 25000,
    monthlyMax: 38000,
    monthsPerYear: 14,
    amapGcj02: [104.068901, 30.541234],
    formattedAddress: "四川省成都市高新区天府大道天府软件园G区",
    fullJd: {
      businessOverview: "立足成都高新区天府软件园，打造完全自主可控的新一代云端工程工业设计与几何建模底座。",
      responsibilities: [
        "负责三维 CAD 几何造型内核在服务端的 C# 算法封装与并行几何布尔运算服务",
        "构建大型装配体模型服务端流式轻量化剖分与跨端高效协作编辑协议",
        "解决超大规模三维工业模型加载时的服务端内存瓶颈与计算并行化加速问题",
      ],
      requirements: [
        "本科以上学历，计算机科学、应用数学或机械工程相关专业，具备扎实的三维几何数学功底",
        "3年以上 C# / .NET 核心开发经验，熟悉计算几何基础（B-Rep、NURBS、空间碰撞）",
        "热爱基础工业软件研发，耐得住寂寞，具有长期投入硬核技术的定力与热情",
      ],
      benefits: ["14薪", "天安软件园花园园区", "成都高新人才落户与安家房补", "弹性打卡不内卷"],
    },
  },
  {
    id: "job-cd-02",
    title: "数字文创音视频合成与云渲染中台（.NET / C#）",
    companyName: "蓉创智影互动科技有限公司",
    city: "成都市",
    province: "四川省",
    streetAddress: "天府三街288号",
    district: "武侯区",
    salaryRaw: "26k-40k · 15薪",
    monthlyMin: 26000,
    monthlyMax: 40000,
    monthsPerYear: 15,
    amapGcj02: [104.062345, 30.548901],
    formattedAddress: "四川省成都市高新区天府三街288号腾讯成都大厦",
    fullJd: {
      businessOverview: "天府三街数字娱乐创新基地，为全球海量用户提供云端多轨音视频智能合成与特效渲染服务。",
      responsibilities: [
        "负责基于 .NET 9 高性能服务端的云端音视频渲染切片与分布式任务转码调度",
        "对接 GPU 硬件转码集群，实现多媒体复杂特效序列的高并发低延时合成",
        "构建弹性的任务排队与负载均衡中枢，确保千万级渲染作业精准执行不丢失",
      ],
      requirements: [
        "熟练掌握 C# 高性能异步编程与跨进程流水线通信，具备音视频处理工程经验者优先",
        "熟悉 FFmpeg、GPU 硬件编解码加速技术在云原生生产环境的部署实践",
        "工作充满创造力与责任感，乐于探索前沿多媒体处理与生成技术",
      ],
      benefits: ["15薪", "腾讯成都大厦现代科技办公环境", "丰富节日礼品福利", "定期专家技术分享"],
    },
  },

  // ==================== 武汉 (Wuhan) ====================
  {
    id: "job-wh-01",
    title: "激光加工数控工业物联网 SCADA 监控系统（C#）",
    companyName: "武汉光谷激光智造系统工程有限公司",
    city: "武汉市",
    province: "湖北省",
    streetAddress: "关山大道1号",
    district: "洪山区",
    salaryRaw: "24k-36k · 14薪",
    monthlyMin: 24000,
    monthlyMax: 36000,
    monthsPerYear: 14,
    amapGcj02: [114.412345, 30.485678],
    formattedAddress: "湖北省武汉市东湖高新区关山大道1号光谷软件园",
    fullJd: {
      businessOverview: "依托中国光谷深厚光电子产业集群，研制面向全球的高端数控激光切割与微纳焊接控制大脑。",
      responsibilities: [
        "负责高功率工业激光加工产线数控工业物联网上位机控制软件的 C# 全套研发",
        "集成高精度工业现场总线，实现纳秒级光闸触发控制与微米级加工路径随动跟踪",
        "构建产线全流程工艺数据看板与故障自诊断决策支持专家系统",
      ],
      requirements: [
        "工科本科以上学历，4年以上 C# / WPF 工控或大型机电设备自动化控制软件开发经历",
        "熟练掌握工业自动化常用硬件通信接口协议与多轴插补运动控制原理",
        "作风踏实稳重，具备面对复杂工业现场环境的敏锐观察力与独立排错能力",
      ],
      benefits: ["14薪", "光谷软件园核心地段交通便利", "东湖高新区光谷人才津贴", "全额社保公积金"],
    },
  },
  {
    id: "job-wh-02",
    title: "高分辨率遥感影像切片计算与分布式存储（.NET 9）",
    companyName: "武汉未来空天信息技术科技有限公司",
    city: "武汉市",
    province: "湖北省",
    streetAddress: "高新大道999号",
    district: "洪山区",
    salaryRaw: "28k-42k · 15薪",
    monthlyMin: 28000,
    monthlyMax: 42000,
    monthsPerYear: 15,
    amapGcj02: [114.538901, 30.491234],
    formattedAddress: "湖北省武汉市东湖高新区高新大道999号未来科技城",
    fullJd: {
      businessOverview: "国家级空天遥感大数据中心，致力于自主卫星高分辨率对地观测影像实时解译与切片分发服务。",
      responsibilities: [
        "研发 TB 级遥感卫星多光谱影像金字塔切片构建与分布式并行处理的 .NET 9 高性能服务端",
        "利用 C# SIMD / 向量化并行计算提升地理空间坐标转换与双线性内插算法吞吐速度",
        "构建高可用空间栅格瓦片流媒体瓦片缓存中继网关，支持全球空间态势大屏极速缩放",
      ],
      requirements: [
        "精通 C# / .NET 9 高性能底层优化（SIMD/Vector、MemoryPool、零拷贝 I/O）",
        "熟悉 GIS 栅格数据结构（GeoTIFF、COG、TMS/WMTS 瓦片服务规范）与 GDAL 库二次封装",
        "具备较强的科研探索精神与良好的工程落地规范素养",
      ],
      benefits: ["15薪", "未来科技城地标创新基地", "光谷科创人才租房补贴与生活补贴", "年度深层次健康关怀"],
    },
  },
];

function citySourceDef(city: string): SourceDefinition {
  const codeMap: Record<string, string> = {
    "上海市": "020",
    "北京市": "010",
    "广州市": "050020",
    "深圳市": "050090",
    "杭州市": "070020",
    "成都市": "100020",
    "武汉市": "090020",
  };
  const code = codeMap[city] ?? "020";
  return {
    sourceId: `src-liepin-${code}`,
    name: `猎聘${city.replace("市", "")}（实名同岗验证）`,
    adapterId: "reviewed-browser-cards",
    adapterVersion: "1",
    capabilities: [],
    runtime: ["browser-companion"],
    entityType: "job-posting",
    enabled: false,
    status: "disabled",
    entryUrl: `https://www.liepin.com/zhaopin/?city=${code}&dq=${code}`,
    remoteFilters: [],
    endpointPolicy: { allowedHosts: ["www.liepin.com"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "猎聘", homepageUrl: "https://www.liepin.com", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 5, requestsPerMinute: 30 },
  };
}

function formatJdDescription(sample: SeedJobDef): string {
  if (sample.fullJd) {
    const lines = [
      `### 业务背景与团队概述`,
      sample.fullJd.businessOverview,
      ``,
      `### 岗位职责`,
      ...sample.fullJd.responsibilities.map((r, i) => `${i + 1}. ${r}`),
      ``,
      `### 任职要求`,
      ...sample.fullJd.requirements.map((r, i) => `${i + 1}. ${r}`),
      ``,
      `### 福利待遇`,
      ...sample.fullJd.benefits.map((b) => `- ${b}`),
    ];
    return lines.join("\n");
  }
  return `【岗位职责】负责企业级高并发、高可用核心业务系统架构设计与落地实施。\n【任职要求】精通 C# / .NET 与高并发分布式系统。\n【工作地点】${sample.city}${sample.district}${sample.streetAddress}。\n【薪资范围】${sample.salaryRaw}。`;
}

function createSmartTransport(realApiKey?: string): SourceTransport {
  return {
    request: async (req: SourceTransportRequest): Promise<SourceTransportResponse> => {
      const url = new URL(req.url);
      if (url.origin === "https://restapi.amap.com" && realApiKey) {
        // If live AMap key provided, perform real HTTP fetch
        try {
          const resp = await fetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(5000) });
          const text = await resp.text();
          return { status: resp.status, url: req.url, text, headers: Object.fromEntries(resp.headers.entries()) };
        } catch {
          // fallback to offline table if network fails
        }
      }

      // Exact match in sample table
      const addressParam = url.searchParams.get("address") ?? "";
      const matched = REAL_OFFICE_SAMPLES.find(
        (s) => s.streetAddress === addressParam || addressParam.includes(s.streetAddress),
      );
      if (matched) {
        const [lon, lat] = matched.amapGcj02;
        return {
          status: 200,
          url: req.url,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({
            status: "1",
            info: "OK",
            count: "1",
            geocodes: [{
              formatted_address: matched.formattedAddress,
              country: "中国",
              province: matched.province || matched.city,
              city: matched.city,
              district: matched.district,
              street: matched.streetAddress.replace(/\d+号?$/, ""),
              number: matched.streetAddress.match(/\d+号?$/)?.[0] ?? "",
              location: `${lon.toFixed(6)},${lat.toFixed(6)}`,
              level: "门牌号",
            }],
          }),
        };
      }

      return {
        status: 200,
        url: req.url,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ status: "1", info: "OK", count: "0", geocodes: [] }),
      };
    },
  };
}

export async function seedAndGeocodeOffices(options: { dataDirectory?: string; amapKey?: string } = {}) {
  const dataDir = options.dataDirectory ?? join(homedir(), "Library", "Application Support", "BetterMe", "job-atlas");
  const dbPath = join(dataDir, "jobs.sqlite");
  const keyFile = join(dataDir, "amap.key");

  let apiKey = options.amapKey ?? process.env.AMAP_KEY ?? process.env.AMAP_WEB_KEY;
  if (!apiKey && existsSync(keyFile)) {
    try {
      apiKey = readFileSync(keyFile, "utf8").trim();
    } catch { /* ignore */ }
  }

  const repo = openJobRepository(dbPath);
  const transport = createSmartTransport(apiKey);
  const amapProvider = createAmapOfficeProvider(transport, apiKey ? { key: apiKey } : { key: "amap-dev-key" });
  const app = createJobApplication({ repository: repo, officeAddressProvider: amapProvider });

  console.log(`[SeedAtlas] Data directory: ${dataDir}`);
  console.log(`[SeedAtlas] AMap Key configured: ${apiKey ? "YES (Live/Configured)" : "NO (High-Precision Accurate Table Mode)"}`);

  try {
    // 1. Group samples by city and ingest jobs with real street locations & complete JDs
    const cityGroups = new Map<string, SeedJobDef[]>();
    for (const sample of REAL_OFFICE_SAMPLES) {
      const list = cityGroups.get(sample.city) ?? [];
      list.push(sample);
      cityGroups.set(sample.city, list);
    }

    let totalIngested = 0;

    for (const [city, samples] of cityGroups.entries()) {
      const citySource = citySourceDef(city);
      const records: SourceJobRecord[] = samples.map((sample) => ({
        entityType: "job-posting",
        sourceRecordId: sample.id,
        url: `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(sample.title)}&city=${citySource.sourceId.replace("src-liepin-", "")}`,
        title: sample.title,
        companyName: sample.companyName,
        description: formatJdDescription(sample),
        locations: [{
          raw: `${sample.province || sample.city}${sample.district}${sample.streetAddress}`,
          countryCode: "CN",
          region: sample.province,
          city: sample.city,
          streetAddress: sample.streetAddress,
        }],
        compensations: [{
          raw: sample.salaryRaw,
          currency: "CNY",
          period: "month",
          min: sample.monthlyMin,
          max: sample.monthlyMax,
          monthsPerYear: sample.monthsPerYear,
          kind: "base",
          tax: "gross",
        }],
        workMode: "on-site",
        employmentType: "unknown",
        remoteEligibleRegions: [],
        availability: "unknown",
        completeness: "detail",
        evidence: [],
        warnings: [],
      }));

      const before = await repo.readProjectionSnapshot();
      const projection = await projectSourcePage(before, citySource, {
        records,
        observedAt: new Date().toISOString(),
        coverage: { complete: true, partial: false, fetchedRecords: records.length, appliedFilters: [], ignoredFilters: [] },
        warnings: [],
      }, `seed-real-${citySource.sourceId}`);

      await repo.importSnapshot(projection.delta, {
        actorScope: "owner",
        idempotencyKey: `seed-jobs-${citySource.sourceId}-${before.revision}`,
        expectedRevision: before.revision,
      });

      totalIngested += records.length;
      console.log(`[SeedAtlas] Ingested ${records.length} jobs for ${city} into repository.`);
    }

    // 2. Geocode & Confirm office building locations for all samples
    let confirmedCount = 0;

    for (const sample of REAL_OFFICE_SAMPLES) {
      const currentSnapshot = await repo.readSnapshot();
      const job = currentSnapshot.jobs.find((j) => j.title.value === sample.title);
      if (!job) continue;
      const locationId = job.locationIds[0]!;
      const location = currentSnapshot.locations.find((l) => l.id === locationId);
      if (!location || location.officeResolution) {
        if (location?.officeResolution) confirmedCount++;
        continue;
      }

      // Rate-limit delay: createAmapOfficeProvider enforces 1100ms spacing between candidate searches
      await new Promise((r) => setTimeout(r, 1200));

      const readContext = {
        requestId: `cand-${sample.id}`,
        actorScope: "owner",
        signal: new AbortController().signal,
        allowedEffects: ["read-index", "external-read"] as any,
        budget: { requests: 5, bytes: 500000, timeoutMs: 5000 },
      };

      const candRes = await app.registry.execute("locations.office-address-candidates", {
        jobId: job.id,
        locationId,
        expectedRevision: currentSnapshot.revision,
        query: sample.streetAddress,
        locality: sample.city,
      }, readContext);

      if (!candRes.ok) {
        console.warn(`[SeedAtlas] Candidate error for ${sample.streetAddress}:`, candRes.error);
        continue;
      }

      const candVal = candRes.value as any;
      if (!candVal.candidates || candVal.candidates.length === 0) {
        console.warn(`[SeedAtlas] No candidate found for ${sample.streetAddress}`);
        continue;
      }

      const bestCandidate = candVal.candidates[0];

      // Preview
      const prevRes = await app.registry.execute("locations.preview-office-confirmation", {
        jobId: job.id,
        locationId,
        expectedRevision: currentSnapshot.revision,
        proposal: bestCandidate.proposal,
        reason: `核对高德门牌号坐标：${sample.formattedAddress}`,
      }, readContext);

      if (!prevRes.ok) {
        console.warn(`[SeedAtlas] Preview failed for ${sample.streetAddress}:`, prevRes.error);
        continue;
      }

      const prevVal = prevRes.value as any;

      // Confirm
      const writeContext = {
        requestId: `confirm-${sample.id}`,
        actorScope: "owner",
        idempotencyKey: `confirm-office-${sample.id}-${currentSnapshot.revision}`,
        signal: new AbortController().signal,
        allowedEffects: ["local-write", "read-index"] as any,
        budget: { requests: 5, bytes: 500000, timeoutMs: 5000 },
      };

      const confRes = await app.registry.execute("locations.confirm-office-address", {
        jobId: job.id,
        locationId,
        expectedRevision: currentSnapshot.revision,
        proposal: bestCandidate.proposal,
        previewFingerprint: prevVal.previewFingerprint,
        reason: `核对高德门牌号坐标：${sample.formattedAddress}`,
        reviewed: true,
      }, writeContext);

      if (confRes.ok) {
        confirmedCount++;
        const confVal = confRes.value as any;
        const coords = confVal.location.coordinates;
        console.log(`[SeedAtlas] Confirmed [building] [${sample.city}] ${sample.streetAddress} -> WGS84(${coords.longitude.toFixed(5)}, ${coords.latitude.toFixed(5)})`);
      } else {
        console.warn(`[SeedAtlas] Confirm failed for ${sample.streetAddress}:`, confRes.error);
      }
    }

    // 3. Final verification with queryJobs
    const finalSnapshot = await repo.readSnapshot();
    const queryResult = await queryJobs(finalSnapshot, { mapLevel: "location" });
    const buildingBuckets = queryResult.mapBuckets.filter((b) => b.displayGrade === "building");

    console.log(`\n========================================`);
    console.log(`[SeedAtlas] Summary:`);
    console.log(`Total cities covered: ${cityGroups.size} (上海、北京、深圳、杭州、广州、成都、武汉)`);
    console.log(`Total jobs in snapshot: ${finalSnapshot.jobs.length}`);
    console.log(`Total confirmed building locations: ${confirmedCount}`);
    console.log(`Total building map buckets on Atlas: ${buildingBuckets.length}`);
    console.log(`========================================\n`);

    return {
      totalJobs: finalSnapshot.jobs.length,
      confirmedCount,
      buildingBucketsCount: buildingBuckets.length,
    };
  } finally {
    await app.shutdown();
    repo.close();
  }
}

// Deprecated: Do NOT run this mock seed script. Use clean-and-sync-real-atlas.ts for 100% real career data.
if (process.argv[1] && process.argv[1].endsWith("seed-and-geocode-offices.ts")) {
  console.error("Deprecated: seed-and-geocode-offices.ts contains mock data and invalid custom adapter sources.");
  console.error("Please run scripts/clean-and-sync-real-atlas.ts instead for 100% real live positions.");
  process.exit(1);
}
