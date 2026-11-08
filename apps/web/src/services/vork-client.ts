export const AGENT_HOST_DEV_TOKEN = "better-me-agent-token";

export interface VorkStatus {
  available: boolean;
  binaryPath: string | null;
  engine: string;
  device: string;
  hardwareAcceleration: string;
  presets: Array<{
    id: string;
    name: string;
    category: string;
    description: string;
    defaultResolution: [number, number];
  }>;
}

export interface VorkRenderResponse {
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

function agentHostUrl(): string {
  // If in browser, use current origin (Vite proxies /api/v1/agent to 5179)
  return "";
}

export async function fetchVorkStatus(): Promise<VorkStatus> {
  const res = await fetch(`${agentHostUrl()}/api/v1/agent/vork/status`, {
    headers: {
      Authorization: `Bearer ${AGENT_HOST_DEV_TOKEN}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch vork status: HTTP ${res.status}`);
  }
  return res.json();
}

export async function triggerVorkRender(options: {
  presetId: string;
  resolution?: [number, number];
  profile?: "std/draft" | "std/final" | "std/path";
}): Promise<{ response: VorkRenderResponse; blob: Blob }> {
  const res = await fetch(`${agentHostUrl()}/api/v1/agent/vork/render`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AGENT_HOST_DEV_TOKEN}`,
    },
    body: JSON.stringify(options),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.error || `vork render failed: HTTP ${res.status}`);
  }

  const data: VorkRenderResponse = await res.json();
  if (!data.success) {
    throw new Error(data.error || "vork rendering failed");
  }

  // Convert base64 dataUrl to Blob
  const base64Data = data.dataUrl.split(",")[1];
  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: "image/png" });

  return { response: data, blob };
}
