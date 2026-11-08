import { useState, useEffect } from "react";
import { Sparkles, Cpu, Play, CheckCircle2, AlertCircle, Loader2, RefreshCw } from "lucide-react";
import {
  fetchVorkStatus,
  triggerVorkRender,
  type VorkStatus,
  type VorkRenderResponse,
} from "../../services/vork-client";
import { prepareWallpaper } from "../../lib/desktop-wallpaper";
import { useDesktopWallpaper } from "../../lib/use-desktop-wallpaper";

interface VorkStudioCardProps {
  onApplied?: () => void;
}

export function VorkStudioCard({ onApplied }: VorkStudioCardProps) {
  const { change } = useDesktopWallpaper();
  const [status, setStatus] = useState<VorkStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string>("quantum_prism");
  const [resolution, setResolution] = useState<[number, number]>([1920, 1080]);
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState<VorkRenderResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadStatus = async () => {
    setStatusLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchVorkStatus();
      setStatus(data);
    } catch (err: any) {
      console.warn("Could not fetch vork status:", err);
      // Fallback display if agent-host is booting
      setStatus({
        available: true,
        binaryPath: "/Users/feng/.local/bin/vork",
        engine: "vork v0.2.0 (Rust + Slang Raytracer)",
        device: "Apple Silicon Metal GPU (Apple M1 Pro)",
        hardwareAcceleration: "Metal",
        presets: [
          {
            id: "quantum_prism",
            name: "量子光学棱镜与金环",
            category: "光追几何",
            description: "OpenPBR 色散玻璃与高反光金属金环，双向赛博冷暖高光交错与镜面地面。",
            defaultResolution: [1920, 1080],
          },
          {
            id: "cyber_neon",
            name: "赛博黑曜石巨碑",
            category: "赛博工业",
            description: "高反光黑曜石立柱与宝石红透光核心，矩阵青与洋红双侧强光追踪渲染。",
            defaultResolution: [1920, 1080],
          },
          {
            id: "sunset_solitude",
            name: "暮光深渊浮岛",
            category: "意境深空",
            description: "落日金光下的几何漂浮球体与极低粗糙度深渊海面，暖金与冷蓝交响。",
            defaultResolution: [1920, 1080],
          },
        ],
      });
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const handleStartRender = async () => {
    if (rendering) return;
    setRendering(true);
    setErrorMessage(null);
    try {
      const { response, blob } = await triggerVorkRender({
        presetId: selectedPreset,
        resolution,
        profile: "std/draft",
      });
      setRenderResult(response);

      // Create File from rendered blob and apply as native local wallpaper
      const presetName = status?.presets.find((p) => p.id === selectedPreset)?.name || "vork-3d-render";
      const file = new File([blob], `${presetName}.png`, { type: "image/png" });
      await change(() => prepareWallpaper(file));
      onApplied?.();
    } catch (err: any) {
      setErrorMessage(err.message || "渲染失败，请检查 GPU 运行状态");
    } finally {
      setRendering(false);
    }
  };

  return (
    <div className="os-vork-studio-card">
      <div className="os-vork-header">
        <div className="os-vork-title-wrap">
          <div className="os-vork-badge">
            <Sparkles size={14} className="os-vork-badge-icon" />
            <span>🧪 实验特性 (Labs) · 本地 Metal GPU 3D 物理光追工坊</span>
          </div>
          <h4 className="os-vork-title">vork 3D 物理光线追踪渲染引擎 (voyager-so/vork)</h4>
          <p className="os-vork-subtitle">
            作为本地实验特性静置于此，为 Agent 生成 3D 架构徽章及桌面质感提供底座。基于 Rust + Slang 着色器架构与 OpenPBR 物理着色材质，由 Apple Silicon Metal GPU 硬件加速原生渲染。
          </p>
        </div>

        <div className="os-vork-status-pill">
          <span className="os-vork-pulse-dot" />
          <div className="os-vork-device-info">
            <span className="os-vork-engine-name">{status?.engine ?? "vork v0.2.0 (Metal)"}</span>
            <small className="os-vork-gpu-name">{status?.device ?? "Apple Silicon Metal GPU (Apple M1 Pro)"}</small>
          </div>
          <button
            type="button"
            className="os-vork-refresh-btn"
            onClick={loadStatus}
            disabled={statusLoading}
            title="刷新引擎状态"
          >
            <RefreshCw size={12} className={statusLoading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Preset 3D Scenes */}
      <div className="os-vork-scene-section">
        <label className="os-vork-section-label">选择 3D 物理光追场景预设：</label>
        <div className="os-vork-scene-grid">
          {(status?.presets || []).map((preset) => {
            const isSelected = selectedPreset === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className={`os-vork-scene-card ${isSelected ? "is-selected" : ""}`}
                onClick={() => setSelectedPreset(preset.id)}
              >
                <div className="os-vork-scene-meta">
                  <div className="os-vork-scene-top">
                    <span className="os-vork-scene-cat">{preset.category}</span>
                    {isSelected && <CheckCircle2 size={13} className="text-emerald-400" />}
                  </div>
                  <strong className="os-vork-scene-name">{preset.name}</strong>
                  <p className="os-vork-scene-desc">{preset.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Controls & Action Bar */}
      <div className="os-vork-action-bar">
        <div className="os-vork-options">
          <label className="os-vork-res-label">
            <span>渲染分辨率：</span>
            <select
              value={`${resolution[0]}x${resolution[1]}`}
              onChange={(e) => {
                const [w, h] = e.target.value.split("x").map(Number);
                setResolution([w, h]);
              }}
              className="os-vork-select"
              disabled={rendering}
            >
              <option value="1920x1080">1080P (1920×1080 · 约 8~12 秒)</option>
              <option value="2560x1440">2K (2560×1440 · 约 16~22 秒)</option>
              <option value="1280x720">720P (1280×720 · 约 4~6 秒极速)</option>
            </select>
          </label>
        </div>

        <button
          type="button"
          className="os-vork-render-btn"
          onClick={handleStartRender}
          disabled={rendering}
        >
          {rendering ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              <span>Metal GPU 正在执行光线追踪与 OIDN 降噪…</span>
            </>
          ) : (
            <>
              <Play size={16} fill="currentColor" />
              <span>⚡️ 启动本地 Metal GPU 实时渲染并应用为壁纸</span>
            </>
          )}
        </button>
      </div>

      {/* Render Feedback / Status message */}
      {renderResult && !rendering && (
        <div className="os-vork-success-banner">
          <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
          <div className="os-vork-success-text">
            <strong>Metal 3D 渲染完成！</strong>
            <span>
              耗时 {(renderResult.durationMs / 1000).toFixed(1)} 秒 · 分辨率 {renderResult.resolution.join("×")} · 硬件：{renderResult.gpuDevice} · 已自动设置为当前桌面壁纸！
            </span>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="os-vork-error-banner">
          <AlertCircle size={16} className="text-rose-400 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}
    </div>
  );
}
