import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { CompanyColorConfigSchema, getDefaultCompanyColorConfig, type CompanyColorConfig, type QueryOptions } from "@better-me/opportunities";
import { ATLAS_BASEMAPS } from "./prototypes/basemaps";
import { COLOR_KEY } from "./atlas-filter-presets";
import { clearAtlasDevAutoConnectSuppressed, previewJobIndexEnabled } from "./dev-index-bootstrap";
import { readRuntimeConnection } from "../../lib/runtime-connection";

export type AtlasSettingsPanel = "maps" | "connection" | "home" | "colors";

const HOME_PRESETS = [
  { label: "人民广场", lat: 31.2304, lon: 121.4737 },
  { label: "张江高科", lat: 31.2047, lon: 121.5878 },
  { label: "徐家汇", lat: 31.1957, lon: 121.4365 },
  { label: "陆家嘴", lat: 31.2397, lon: 121.5000 },
  { label: "虹桥枢纽", lat: 31.1963, lon: 121.3195 },
  { label: "临港新片区", lat: 30.8872, lon: 121.9287 },
] as const;

type HomeAnchor = QueryOptions["anchor"];

type AtlasSettingsModalBodyProps = {
  settings: AtlasSettingsPanel;
  basemapId: string;
  setBasemapId: Dispatch<SetStateAction<string>>;
  setMapError: Dispatch<SetStateAction<string>>;
  endpoint: string;
  token: string;
  connecting: boolean;
  connectionError: string;
  devAutoConnectSuppressed: MutableRefObject<boolean>;
  restoreConnection: MutableRefObject<boolean>;
  onConnect: (credentials: { endpoint: string; token: string }, manual: boolean) => Promise<void>;
  onChangeConnection: (field: "endpoint" | "token", value: string) => void;
  onDisconnect: () => void;
  onReconnectPreview?: () => void;
  latitude: string;
  longitude: string;
  setLatitude: Dispatch<SetStateAction<string>>;
  setLongitude: Dispatch<SetStateAction<string>>;
  anchor: HomeAnchor;
  setAnchor: (value: HomeAnchor) => void;
  homeError: string;
  setHomeError: Dispatch<SetStateAction<string>>;
  setMaxKm: Dispatch<SetStateAction<string>>;
  setDistanceFilter: Dispatch<SetStateAction<string>>;
  sort: "relevance" | "salary" | "distance" | "updated";
  setSort: Dispatch<SetStateAction<"relevance" | "salary" | "distance" | "updated">>;
  onClose: () => void;
  colors: CompanyColorConfig;
  setColors: Dispatch<SetStateAction<CompanyColorConfig>>;
  colorsMessage: string;
  setColorsMessage: Dispatch<SetStateAction<string>>;
};

export function AtlasSettingsModalBody({
  settings,
  basemapId,
  setBasemapId,
  setMapError,
  endpoint,
  token,
  connecting,
  connectionError,
  devAutoConnectSuppressed,
  restoreConnection,
  onConnect,
  onChangeConnection,
  onDisconnect,
  onReconnectPreview,
  latitude,
  longitude,
  setLatitude,
  setLongitude,
  anchor,
  setAnchor,
  homeError,
  setHomeError,
  setMaxKm,
  setDistanceFilter,
  sort,
  setSort,
  onClose,
  colors,
  setColors,
  colorsMessage,
  setColorsMessage,
}: AtlasSettingsModalBodyProps) {
  if (settings === "maps") {
    return (
      <div>
        <p>全球与国内均使用同一经纬度视图，可连续缩放至街道。开放底图无需 API Key；联网底图会向所选服务请求当前视野的瓦片，离线轮廓不请求外部地图服务。</p>
        <label className="atlas-basemap-select">
          底图来源
          <select value={basemapId} onChange={(e) => { setBasemapId(e.target.value); setMapError(""); }}>
            <option value="auto">OpenFreeMap · 跟随浅深主题</option>
            {ATLAS_BASEMAPS.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
            <option value="offline">本地概览 · 离线边界</option>
          </select>
        </label>
        <details className="atlas-settings-disclosure">
          <summary>覆盖范围、3D 与隐私说明</summary>
          <p className="atlas-small">道路、建筑、门牌和地名是否显示取决于底图覆盖；仅对含高度属性的底图建筑做 3D 表现，不代表实测楼高。离线省域立体效果是概览示意，不代表实测地形。城市级岗位不会显示成精确办公地址。“三维地球”由 Cesium 渲染本地概略边界，不含卫星影像。地图内“实景 3D / 数据与画质”可加载 Google 摄影测量 3D Tiles 或获准使用的 3D Tiles，需自行配置服务权限、Key 与可能的计费；Key 仅保留在当前页面内存。上海街区覆盖需实测，不能用城市中心或模型网格推断办公地址。</p>
        </details>
      </div>
    );
  }

  if (settings === "connection" && previewJobIndexEnabled()) {
    return <div>
      <p>使用当前 BetterMe 账号连接沙箱里的独立岗位索引，无需填写服务地址或令牌。电脑上的岗位库不会自动同步到预览。</p>
      <div className="atlas-form-row">
        <button type="button" disabled={connecting} onClick={onReconnectPreview}>{connecting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}{connecting ? "正在连接" : "连接并读取索引"}</button>
        <button type="button" onClick={onDisconnect}>断开连接</button>
      </div>
      {connectionError && <p role="alert" className="atlas-error">{connectionError}</p>}
    </div>;
  }

  if (settings === "connection") {
    return (
      <form onSubmit={(e) => { e.preventDefault(); devAutoConnectSuppressed.current = false; clearAtlasDevAutoConnectSuppressed(); restoreConnection.current = false; void onConnect({ endpoint, token }, true); }}>
        <p>{(import.meta.env?.DEV || readRuntimeConnection()) ? "当前工作台会自动连接配套岗位服务并读取索引，不必手填服务地址和访问令牌。" : "公网页面没有本地开发接口，仍需填写本机服务地址和访问令牌。"}允许当前网页 Origin：<code>{window.location.origin}</code>。连接成功后，访问令牌仅保留在当前标签页的会话存储中，刷新可恢复连接；断开并清除后，这个标签页不会马上再自动连接。令牌不写入永久存储或网址。</p>
        <div className="atlas-form-row">
          <label>服务地址<input value={endpoint} onChange={(e) => onChangeConnection("endpoint", e.target.value)} placeholder="http://127.0.0.1:5178" /></label>
          <label>访问令牌<input type="password" autoComplete="off" value={token} onChange={(e) => onChangeConnection("token", e.target.value)} /></label>
          <button type="submit" disabled={connecting}>{connecting ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}{connecting ? "正在连接" : "连接并读取索引"}</button>
          <button type="button" onClick={onDisconnect}>断开并清除会话连接</button>
        </div>
        {connectionError && <p role="alert" className="atlas-error">{connectionError}</p>}
        <p className="atlas-small">读取公开岗位快照，在本页执行共享查询。家庭参照坐标不发送给服务。公网 HTTPS 页面连接本机可能需要浏览器本地网络授权；完整体验建议使用本机网页。</p>
      </form>
    );
  }

  if (settings === "home") {
    return (
      <form onSubmit={(e) => {
        e.preventDefault();
        const lat = Number(latitude), lon = Number(longitude);
        if (!latitude.trim() || !longitude.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          setHomeError("请输入有效的 WGS84 纬度（-90～90）和经度（-180～180）。");
          return;
        }
        setAnchor({ ref: crypto.randomUUID(), latitude: lat, longitude: lon, coordinateSystem: "WGS84" });
        setHomeError("");
        onClose();
      }}>
        <p>使用 WGS84 坐标计算直线距离，保存在当前浏览器，不发送给岗位服务。城市中心距离会标为估算；可选用快捷地标一键填入，或直接输入坐标。</p>
        <div className="atlas-home-presets">
          <span style={{ fontSize: 11, color: "var(--color-ink-muted)", alignSelf: "center", marginRight: 4 }}>快捷地标：</span>
          {HOME_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="atlas-home-preset-btn"
              onClick={() => {
                setLatitude(String(p.lat));
                setLongitude(String(p.lon));
                setAnchor({ ref: crypto.randomUUID(), latitude: p.lat, longitude: p.lon, coordinateSystem: "WGS84" });
                setHomeError("");
                onClose();
              }}
            >
              📍 {p.label}
            </button>
          ))}
        </div>
        <div className="atlas-form-row">
          <label>纬度<input inputMode="decimal" value={latitude} onChange={(e) => setLatitude(e.target.value)} placeholder="例如 31.2304" /></label>
          <label>经度<input inputMode="decimal" value={longitude} onChange={(e) => setLongitude(e.target.value)} placeholder="例如 121.4737" /></label>
          <button type="submit">应用参照点</button>
          {anchor && (
            <button
              type="button"
              onClick={() => {
                setAnchor(undefined);
                setLatitude("");
                setLongitude("");
                setMaxKm("");
                setDistanceFilter("");
                if (sort === "distance") setSort("relevance");
              }}
            >
              清除
            </button>
          )}
        </div>
        {homeError && <p role="alert" className="atlas-error">{homeError}</p>}
      </form>
    );
  }

  return (
    <div>
      <p>配色依据已核实的最终控股方来源。工作地点不代表企业来源；待核实与证据冲突单列。颜色只影响岗位地图。</p>
      <div className="atlas-color-grid">
        {colors.rules.map((rule, index) => (
          <label key={rule.id}>
            <input type="color" aria-label={`${rule.label}颜色`} value={rule.color} onChange={(e) => setColors((current) => ({ ...current, rules: current.rules.map((r, n) => n === index ? { ...r, color: e.target.value } : r) }))} />
            <span>{rule.label}</span>
          </label>
        ))}
      </div>
      <div className="atlas-form-row">
        <button onClick={() => { try { localStorage.setItem(COLOR_KEY, JSON.stringify(CompanyColorConfigSchema.parse(colors))); setColorsMessage("配色已保存到当前浏览器。"); } catch { setColorsMessage("浏览器未允许保存，当前页面仍应用此配色。"); } }}>保存配色</button>
        <button onClick={() => { setColors(getDefaultCompanyColorConfig()); setColorsMessage("已恢复默认配色；点击保存可保留。"); }}>恢复默认</button>
        <span role="status">{colorsMessage}</span>
      </div>
    </div>
  );
}
