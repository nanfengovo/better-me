import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CoreLocationAuthStatus =
  | "authorized"
  | "not_determined"
  | "not_determined_timeout"
  | "denied"
  | "unavailable"
  | "timeout";

export type MacosCoreLocationResult =
  | {
      ok: true;
      status: "authorized";
      longitude: number;
      latitude: number;
      accuracyMeters: number;
    }
  | {
      ok: false;
      status: CoreLocationAuthStatus;
      error: string;
    };

const HELPER_BUNDLE_ID = "io.github.nanfengovo.betterme.location";
const HELPER_APP_NAME = "BetterMeLocation.app";
const HELPER_BINARY_NAME = "BetterMeLocation";

const HELPER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${HELPER_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>BetterMe 定位助手</string>
  <key>CFBundleDisplayName</key>
  <string>BetterMe 定位助手</string>
  <key>CFBundleExecutable</key>
  <string>${HELPER_BINARY_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSLocationWhenInUseUsageDescription</key>
  <string>BetterMe 岗位地图需要您的位置，以在地图上标定您所在的精确街道及计算通勤距离。</string>
  <key>NSLocationUsageDescription</key>
  <string>BetterMe 岗位地图需要您的位置，以在地图上标定您所在的精确街道及计算通勤距离。</string>
</dict>
</plist>
`;

const HELPER_SWIFT_SOURCE = `import AppKit
import CoreLocation
import Foundation

final class HelperDelegate: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let callbackUrl: URL
    private let nonce: String
    private let allowPrompt: Bool
    private var settled = false
    private var bestFix: CLLocation?
    private var fixTimer: DispatchWorkItem?
    private var deadlineTimer: DispatchWorkItem?

    init(callbackUrl: URL, nonce: String, allowPrompt: Bool) {
        self.callbackUrl = callbackUrl
        self.nonce = nonce
        self.allowPrompt = allowPrompt
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func start() {
        guard CLLocationManager.locationServicesEnabled() else {
            finish(["ok": false, "status": "unavailable", "error": "macOS 系统定位服务未开启"])
            return
        }

        let auth = manager.authorizationStatus
        switch auth {
        case .denied, .restricted:
            finish(["ok": false, "status": "denied", "error": "macOS 定位权限已被拒绝"])
        case .notDetermined:
            if !allowPrompt {
                finish(["ok": false, "status": "not_determined", "error": "macOS 定位权限尚未授权"])
                return
            }
            scheduleDeadline(seconds: 11.0, timeoutStatus: "not_determined_timeout")
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways:
            scheduleDeadline(seconds: 5.5, timeoutStatus: "timeout")
            manager.startUpdatingLocation()
        @unknown default:
            finish(["ok": false, "status": "unavailable", "error": "未知的 macOS 定位权限状态"])
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let auth = manager.authorizationStatus
        if auth == .denied || auth == .restricted {
            finish(["ok": false, "status": "denied", "error": "macOS 定位权限已被拒绝"])
            return
        }
        if auth == .authorizedAlways {
            deadlineTimer?.cancel()
            scheduleDeadline(seconds: 5.5, timeoutStatus: "timeout")
            manager.startUpdatingLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard !settled else { return }
        for loc in locations where loc.horizontalAccuracy >= 0 {
            if let existing = bestFix {
                if loc.horizontalAccuracy < existing.horizontalAccuracy {
                    bestFix = loc
                }
            } else {
                bestFix = loc
            }
        }
        guard let currentBest = bestFix else { return }
        if currentBest.horizontalAccuracy <= 100 {
            emitLocation(currentBest)
            return
        }
        if fixTimer == nil {
            let item = DispatchWorkItem { [weak self] in
                guard let self, !self.settled, let fix = self.bestFix else { return }
                self.emitLocation(fix)
            }
            fixTimer = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.8, execute: item)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let nsError = error as NSError
        if nsError.domain == kCLErrorDomain && nsError.code == CLError.denied.rawValue {
            let auth = manager.authorizationStatus
            if auth == .denied || auth == .restricted || !allowPrompt {
                finish(["ok": false, "status": "denied", "error": "macOS 定位权限已被拒绝"])
            }
            return
        }
        if let fix = bestFix {
            emitLocation(fix)
        }
    }

    private func scheduleDeadline(seconds: Double, timeoutStatus: String) {
        deadlineTimer?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.settled else { return }
            if let fix = self.bestFix {
                self.emitLocation(fix)
                return
            }
            let auth = self.manager.authorizationStatus
            let status = auth == .notDetermined ? timeoutStatus : (auth == .denied || auth == .restricted ? "denied" : "timeout")
            self.finish(["ok": false, "status": status, "error": "获取 macOS 精准定位超时"])
        }
        deadlineTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    private func emitLocation(_ loc: CLLocation) {
        finish([
            "ok": true,
            "status": "authorized",
            "latitude": loc.coordinate.latitude,
            "longitude": loc.coordinate.longitude,
            "accuracyMeters": max(5.0, loc.horizontalAccuracy)
        ])
    }

    private func finish(_ payload: [String: Any]) {
        guard !settled else { return }
        settled = true
        fixTimer?.cancel()
        deadlineTimer?.cancel()
        manager.stopUpdatingLocation()

        var req = URLRequest(url: callbackUrl)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(nonce, forHTTPHeaderField: "X-Helper-Nonce")
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { _, _, _ in
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2.0)
        exit(0)
    }
}

let args = CommandLine.arguments
guard args.count >= 4,
      let port = Int(args[1]),
      port > 0,
      let url = URL(string: "http://127.0.0.1:\\(port)/")
else {
    exit(1)
}
let nonce = args[2]
let allowPrompt = args[3] == "prompt"

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = HelperDelegate(callbackUrl: url, nonce: nonce, allowPrompt: allowPrompt)
DispatchQueue.main.async {
    delegate.start()
}
app.run()
`;

const HELPER_FINGERPRINT = createHash("sha256")
  .update(HELPER_INFO_PLIST)
  .update(HELPER_SWIFT_SOURCE)
  .digest("hex")
  .slice(0, 16);

let buildPromise: Promise<string | null> | null = null;

function defaultHelperBaseDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "BetterMe", "location-helper");
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compiles and signs BetterMeLocation.app cleanly under ~/Library/Application Support/BetterMe
 * so macOS TCC Location Services permissions persist across restarts.
 */
export async function ensureMacosLocationHelperApp(baseDir = defaultHelperBaseDir()): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  const appPath = path.join(baseDir, HELPER_APP_NAME);
  const stampPath = path.join(baseDir, "helper.version");
  const binaryPath = path.join(appPath, "Contents", "MacOS", HELPER_BINARY_NAME);

  try {
    const existingStamp = (await readFile(stampPath, "utf8")).trim();
    if (existingStamp === HELPER_FINGERPRINT && (await fileExists(binaryPath))) {
      return appPath;
    }
  } catch {
    // Build fresh helper below.
  }

  if (!buildPromise) {
    buildPromise = (async () => {
      try {
        const contentsDir = path.join(appPath, "Contents");
        const macOsDir = path.join(contentsDir, "MacOS");
        const srcPath = path.join(baseDir, "BetterMeLocation.swift");
        await mkdir(macOsDir, { recursive: true });
        await writeFile(path.join(contentsDir, "Info.plist"), HELPER_INFO_PLIST, "utf8");
        await writeFile(srcPath, HELPER_SWIFT_SOURCE, "utf8");
        await execFileAsync("swiftc", ["-O", srcPath, "-o", binaryPath], { timeout: 30_000 });
        await execFileAsync("xattr", ["-cr", appPath], { timeout: 5_000 }).catch(() => {});
        await execFileAsync("codesign", ["--force", "--deep", "-s", "-", appPath], { timeout: 10_000 });
        await writeFile(stampPath, HELPER_FINGERPRINT, "utf8");
        return appPath;
      } catch {
        return null;
      } finally {
        buildPromise = null;
      }
    })();
  }

  return buildPromise;
}

export function parseMacosCoreLocationPayload(payload: unknown): MacosCoreLocationResult {
  if (!payload || typeof payload !== "object") {
    return { ok: false, status: "unavailable", error: "无效的 macOS 定位响应。" };
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === true) {
    const longitude = Number(record.longitude);
    const latitude = Number(record.latitude);
    const accuracyMeters = Number(record.accuracyMeters);
    if (
      Number.isFinite(longitude) &&
      Number.isFinite(latitude) &&
      longitude >= -180 &&
      longitude <= 180 &&
      latitude >= -90 &&
      latitude <= 90 &&
      !(Math.abs(longitude) < 1e-6 && Math.abs(latitude) < 1e-6)
    ) {
      return {
        ok: true,
        status: "authorized",
        longitude,
        latitude,
        accuracyMeters: Number.isFinite(accuracyMeters) && accuracyMeters > 0 ? Math.round(accuracyMeters) : 65,
      };
    }
    return { ok: false, status: "unavailable", error: "macOS 返回了无效坐标。" };
  }

  const rawStatus = typeof record.status === "string" ? record.status : "unavailable";
  const status: CoreLocationAuthStatus =
    rawStatus === "denied" ||
    rawStatus === "not_determined" ||
    rawStatus === "not_determined_timeout" ||
    rawStatus === "timeout"
      ? rawStatus
      : "unavailable";
  const error = typeof record.error === "string" && record.error.trim() ? record.error.trim() : "macOS 精准定位不可用。";
  return { ok: false, status, error };
}

/**
 * Queries macOS CoreLocation via LaunchServices (`open -W -n`) so macOS TCC
 * attributes location permission properly to BetterMeLocation.app instead of CLI parents.
 */
export async function requestMacosCoreLocation(options: {
  allowPrompt?: boolean;
  timeoutMs?: number;
  helperBaseDir?: string;
} = {}): Promise<MacosCoreLocationResult> {
  if (process.platform !== "darwin") {
    return { ok: false, status: "unavailable", error: "仅 macOS 支持系统 CoreLocation。" };
  }

  const appPath = await ensureMacosLocationHelperApp(options.helperBaseDir);
  if (!appPath) {
    return { ok: false, status: "unavailable", error: "无法初始化 macOS 定位助手。" };
  }

  const allowPrompt = Boolean(options.allowPrompt);
  const timeoutMs = options.timeoutMs ?? (allowPrompt ? 14_000 : 7_500);
  const nonce = randomBytes(16).toString("hex");

  return new Promise((resolve) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.headers["x-helper-nonce"] !== nonce) {
        res.statusCode = 403;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= 16_384) {
          chunks.push(chunk);
        }
      });
      req.on("end", () => {
        res.statusCode = 200;
        res.end("ok");
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(parseMacosCoreLocationPayload(parsed));
        } catch {
          finish({ ok: false, status: "unavailable", error: "macOS 定位助手数据解析失败。" });
        }
      });
    });

    const finish = (result: MacosCoreLocationResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      server.close();
      resolve(result);
    };

    server.on("error", () => {
      finish({ ok: false, status: "unavailable", error: "无法启动本地定位回调监听。" });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        finish({ ok: false, status: "unavailable", error: "无效的本地回调端口。" });
        return;
      }

      timeoutHandle = setTimeout(() => {
        finish({
          ok: false,
          status: allowPrompt ? "not_determined_timeout" : "timeout",
          error: "等待 macOS 系统精准定位超时。",
        });
      }, timeoutMs);

      execFile(
        "open",
        ["-W", "-n", "-a", appPath, "--args", String(address.port), nonce, allowPrompt ? "prompt" : "probe"],
        { timeout: timeoutMs },
        (error) => {
          if (error && !settled) {
            finish({ ok: false, status: "unavailable", error: "调用 macOS 定位助手失败。" });
          }
        },
      );
    });
  });
}
