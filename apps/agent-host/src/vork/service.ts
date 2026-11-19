import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface VorkRenderRequest {
  presetId?: string;
  resolution?: [number, number];
  profile?: "std/draft" | "std/final" | "std/path";
  sceneJson?: Record<string, unknown>;
  themeColor?: string;
}

export interface VorkRenderResult {
  success: boolean;
  presetId?: string;
  durationMs: number;
  imagePath: string;
  dataUrl: string;
  resolution: [number, number];
  engine: string;
  gpuDevice: string;
  error?: string;
}

export const VORK_PRESETS = [
  {
    id: "quantum_prism",
    name: "量子光学棱镜 (Quantum Glass & Gold)",
    category: "光追几何",
    description: "OpenPBR 光学色散玻璃球体与高反光金属金环，双向赛博冷暖高光交错与镜面地面。",
    defaultResolution: [1920, 1080] as [number, number],
    scene: {
      $schema: "https://voyager.so/vork/schema/scene.schema.json",
      version: 2,
      nodes: [
        {
          type: "mesh",
          name: "glass_sphere",
          translation: [0, 1.2, 0],
          geometry: { std: "sphere", radius: 1.2, segments: 96, rings: 48 },
          materials: [{
            inputs: {
              base_color: [0.95, 0.98, 1.0],
              specular_roughness: 0.05,
              transmission_weight: 0.92,
              coat_weight: 0.5,
              specular_ior: 1.52,
            },
          }],
        },
        {
          type: "mesh",
          name: "gold_ring",
          translation: [0, 1.2, 0],
          rotation: { euler: [0.6, 0.4, 0] },
          geometry: { std: "box", size: [3.2, 0.08, 3.2] },
          materials: [{
            inputs: {
              base_color: [1.0, 0.78, 0.28],
              specular_roughness: 0.15,
              base_metalness: 0.95,
            },
          }],
        },
        {
          type: "mesh",
          name: "neon_pedestal",
          translation: [0, 0.1, 0],
          geometry: { std: "box", size: [2.2, 0.2, 2.2] },
          materials: [{
            inputs: {
              base_color: [0.05, 0.08, 0.15],
              specular_roughness: 0.2,
            },
          }],
        },
        {
          type: "mesh",
          name: "dark_mirror_floor",
          geometry: { std: "grid", size: [200, 200] },
          materials: [{
            inputs: {
              base_color: [0.03, 0.03, 0.06],
              specular_roughness: 0.1,
              coat_weight: 0.6,
            },
          }],
        },
        {
          type: "light",
          shape: "rectangle",
          translation: [-4, 6, 5],
          target: [0, 1.2, 0],
          energy: 2200,
          size: 5,
          color: [0.2, 0.7, 1.0],
        },
        {
          type: "light",
          shape: "rectangle",
          translation: [5, 4, -3],
          target: [0, 1.2, 0],
          energy: 1800,
          size: 4,
          color: [1.0, 0.35, 0.65],
        },
        {
          type: "light",
          shape: "point",
          translation: [0, 8, 0],
          energy: 1200,
          color: [0.9, 0.95, 1.0],
        },
        {
          type: "camera",
          translation: [3.2, 2.8, 5.4],
          target: [0, 1.1, 0],
        },
      ],
      render: { resolution: [1920, 1080], duration: 1 },
    },
  },
  {
    id: "cyber_neon",
    name: "赛博黑曜石巨碑 (Cyberpunk Monolith)",
    category: "赛博工业",
    description: "高反光黑曜石立柱与宝石红透光核心，矩阵青与洋红双侧强光追踪渲染。",
    defaultResolution: [1920, 1080] as [number, number],
    scene: {
      $schema: "https://voyager.so/vork/schema/scene.schema.json",
      version: 2,
      nodes: [
        {
          type: "mesh",
          name: "central_monolith",
          translation: [0, 1.8, 0],
          rotation: { euler: [0, 0.45, 0] },
          geometry: { std: "box", size: [1.4, 3.6, 0.4] },
          materials: [{
            inputs: {
              base_color: [0.02, 0.02, 0.04],
              specular_roughness: 0.08,
              base_metalness: 0.8,
              coat_weight: 0.8,
            },
          }],
        },
        {
          type: "mesh",
          name: "left_pillar",
          translation: [-2.2, 1.2, 0.8],
          rotation: { euler: [0, -0.2, 0] },
          geometry: { std: "box", size: [0.8, 2.4, 0.8] },
          materials: [{
            inputs: {
              base_color: [0.03, 0.05, 0.08],
              specular_roughness: 0.15,
              base_metalness: 0.9,
            },
          }],
        },
        {
          type: "mesh",
          name: "right_gem",
          translation: [2.0, 1.0, 0.5],
          geometry: { std: "sphere", radius: 0.9, segments: 64, rings: 32 },
          materials: [{
            inputs: {
              base_color: [0.9, 0.1, 0.4],
              specular_roughness: 0.1,
              transmission_weight: 0.85,
              specular_ior: 1.6,
            },
          }],
        },
        {
          type: "mesh",
          name: "grid_floor",
          geometry: { std: "grid", size: [200, 200] },
          materials: [{
            inputs: {
              base_color: [0.04, 0.04, 0.07],
              specular_roughness: 0.12,
              coat_weight: 0.5,
            },
          }],
        },
        {
          type: "light",
          shape: "rectangle",
          translation: [-4, 3, 2],
          target: [0, 1.5, 0],
          energy: 2600,
          size: 6,
          color: [0.05, 0.85, 1.0],
        },
        {
          type: "light",
          shape: "rectangle",
          translation: [4, 4, 1],
          target: [0, 1.5, 0],
          energy: 2400,
          size: 5,
          color: [1.0, 0.1, 0.55],
        },
        {
          type: "light",
          shape: "point",
          translation: [0, 5, -2],
          energy: 1500,
          color: [0.8, 0.6, 1.0],
        },
        {
          type: "camera",
          translation: [0, 2.2, 5.8],
          target: [0, 1.4, 0],
        },
      ],
      render: { resolution: [1920, 1080], duration: 1 },
    },
  },
  {
    id: "sunset_solitude",
    name: "暮光深渊浮岛 (Sunset Solitude)",
    category: "意境深空",
    description: "落日金光下的几何漂浮球体与极低粗糙度深渊海面，暖金与冷蓝交响。",
    defaultResolution: [1920, 1080] as [number, number],
    scene: {
      $schema: "https://voyager.so/vork/schema/scene.schema.json",
      version: 2,
      nodes: [
        {
          type: "mesh",
          name: "sun_sphere",
          translation: [-0.8, 1.4, 0],
          geometry: { std: "sphere", radius: 1.1, segments: 64, rings: 32 },
          materials: [{
            inputs: {
              base_color: [1.0, 0.5, 0.15],
              specular_roughness: 0.25,
              coat_weight: 0.4,
            },
          }],
        },
        {
          type: "mesh",
          name: "secondary_cube",
          translation: [1.2, 0.6, 0.8],
          rotation: { euler: [0.2, 0.6, 0.1] },
          geometry: { std: "box", size: [1.2, 1.2, 1.2] },
          materials: [{
            inputs: {
              base_color: [0.1, 0.2, 0.35],
              specular_roughness: 0.1,
              base_metalness: 0.85,
            },
          }],
        },
        {
          type: "mesh",
          name: "ocean_floor",
          geometry: { std: "grid", size: [200, 200] },
          materials: [{
            inputs: {
              base_color: [0.02, 0.04, 0.08],
              specular_roughness: 0.08,
              coat_weight: 0.7,
            },
          }],
        },
        {
          type: "light",
          shape: "rectangle",
          translation: [-6, 3, -4],
          target: [0, 1, 0],
          energy: 3500,
          size: 8,
          color: [1.0, 0.6, 0.2],
        },
        {
          type: "light",
          shape: "rectangle",
          translation: [4, 5, 5],
          target: [0, 1, 0],
          energy: 1400,
          size: 4,
          color: [0.2, 0.5, 0.9],
        },
        {
          type: "camera",
          translation: [2.5, 2.2, 5.0],
          target: [0, 1.0, 0],
        },
      ],
      render: { resolution: [1920, 1080], duration: 1 },
    },
  },
];

export class VorkRenderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "VorkRenderError";
  }
}

const VALID_PROFILES = new Set(["std/draft", "std/final", "std/path"]);

export class VorkEngineService {
  private binaryPath: string | null = null;
  private isDarwinArm64 = process.platform === "darwin" && process.arch === "arm64";
  private renderQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.binaryPath = this.resolveBinary();
  }

  private resolveBinary(): string | null {
    const candidates = [
      process.env.VORK_BIN,
      path.join(os.homedir(), ".local/bin/vork"),
      "/usr/local/bin/vork",
      "/opt/homebrew/bin/vork",
    ].filter(Boolean) as string[];

    for (const c of candidates) {
      if (existsSync(c)) {
        return c;
      }
    }
    return null;
  }

  public getStatus() {
    const available = Boolean(this.binaryPath && existsSync(this.binaryPath));
    return {
      available,
      binaryPath: available && this.binaryPath ? path.basename(this.binaryPath) : null,
      engine: "vork v0.2.0 (Rust + Slang Raytracing Engine)",
      device: this.isDarwinArm64 ? "Apple Silicon Metal GPU (Hardware-accelerated)" : `${process.platform}-${process.arch}`,
      hardwareAcceleration: this.isDarwinArm64 ? "Metal" : "Vulkan/CPU",
      presets: VORK_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        description: p.description,
        defaultResolution: p.defaultResolution,
      })),
    };
  }

  public render(request: VorkRenderRequest): Promise<VorkRenderResult> {
    const run = this.renderQueue.then(() => this.executeRender(request));
    this.renderQueue = run.catch(() => undefined);
    return run;
  }

  private async executeRender(request: VorkRenderRequest): Promise<VorkRenderResult> {
    const startTime = Date.now();
    if (!this.binaryPath || !existsSync(this.binaryPath)) {
      throw new VorkRenderError(503, "vork_unavailable", "vork 可执行文件未就绪，请先安装 vork (https://github.com/voyager-so/vork)");
    }

    const requestedPresetId = request.presetId || "quantum_prism";
    const preset = VORK_PRESETS.find((p) => p.id === requestedPresetId);
    if (!preset) {
      throw new VorkRenderError(400, "invalid_vork_preset", "请求的渲染预设不存在，未启动渲染。");
    }

    const resolution = request.resolution || preset.defaultResolution;
    if (
      !Array.isArray(resolution) ||
      resolution.length !== 2 ||
      !resolution.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 64 && n <= 4096)
    ) {
      throw new VorkRenderError(400, "invalid_vork_resolution", "渲染分辨率必须在 64×64 至 4096×4096 的整数范围内。");
    }

    const profile = request.profile || "std/draft";
    if (!VALID_PROFILES.has(profile)) {
      throw new VorkRenderError(400, "invalid_vork_profile", "不支持的渲染质量档位。");
    }

    // Prepare scene
    const scene = request.sceneJson ? JSON.parse(JSON.stringify(request.sceneJson)) : JSON.parse(JSON.stringify(preset.scene));
    scene.render = {
      ...(scene.render || {}),
      resolution,
      duration: 1,
    };

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-vork-"));
    await fs.chmod(tmpDir, 0o700).catch(() => {});

    const sceneFile = path.join(tmpDir, "scene.json");
    const outFile = path.join(tmpDir, "render.png");

    await fs.writeFile(sceneFile, JSON.stringify(scene, null, 2), { encoding: "utf8", mode: 0o600 });

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          this.binaryPath!,
          ["render", sceneFile, "--out", outFile, "--profile", profile],
          { timeout: 60_000 },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`vork 渲染失败: ${error.message} - ${stderr || stdout}`));
            } else {
              resolve();
            }
          }
        );
      });

      const imgBuffer = await fs.readFile(outFile);
      const dataUrl = `data:image/png;base64,${imgBuffer.toString("base64")}`;
      const durationMs = Date.now() - startTime;

      return {
        success: true,
        presetId: preset.id,
        durationMs,
        imagePath: path.basename(outFile),
        dataUrl,
        resolution,
        engine: "vork v0.2.0 (Metal GPU Raytracer)",
        gpuDevice: this.isDarwinArm64 ? "Apple Silicon Metal GPU (Hardware-accelerated)" : `${process.platform}-${process.arch}`,
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export const vorkService = new VorkEngineService();
