import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalJobServiceError, startLocalJobService, validateJobServiceConfig, type JobServiceConfig, type LocalJobServiceHandle } from "./lifecycle.js";

export const JOB_SERVICE_USAGE = `BetterMe local job service

Usage:
  pnpm --filter @better-me/job-service start --data-dir <absolute-directory> --origin <exact-ui-origin> [options]

Required:
  --data-dir <path>      Dedicated local data directory; choose a private location outside Git.
  --origin <origin>      Exact allowed UI origin; repeat for each UI, for example http://localhost:5173.

Options:
  --host <address>       127.0.0.1 (default) or ::1 only.
  --port <number>        5178 by default; 1-65535.
  --dns <provider>       system (default) or google-doh; applies only inside this service.
  --career-search <id>   Optional duckduckgo-html or searxng; disabled by default.
  --career-search-endpoint <https-url>  Required only for searxng; no API keys are supported.
  --office-geocoder <id> Optional nominatim or photon address lookup; disabled by default, explicit per-address queries only.
  --help, -h            Show help without creating files or starting a listener.

The service stores jobs.sqlite, service.token and an exclusive owner lock in the data directory.
Logs show the token file path only. Read that private file locally to configure a trusted client.
On Windows, choose a directory whose NTFS permissions are restricted to your account.
On POSIX systems, an existing data directory must exclude group and other users.
Ctrl+C stops new requests and waits for running writes before closing SQLite.
duckduckgo-html is an explicitly enabled experimental HTML provider, not an official search API.
For searxng, use an instance you manage; this service does not rotate public instances.
Nominatim and Photon are for occasional user-triggered office address lookup, not autocomplete or bulk collection.
Address queries go to the explicitly selected provider; candidates require your review and retain attribution.
`;
export function parseJobServiceArgs(args: readonly string[]): { help: true } | { help: false; config: JobServiceConfig } {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return { help: true };
  const values = new Map<string, string>();
  const origins: string[] = [];
  const supported = new Set(["--data-dir", "--origin", "--host", "--port", "--dns", "--career-search", "--career-search-endpoint", "--office-geocoder"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!supported.has(flag) || !value || value.startsWith("--") || (flag !== "--origin" && values.has(flag))) throw new LocalJobServiceError("invalid-config", "Use named options once and provide every option value. See --help.");
    if (flag === "--origin") origins.push(value); else values.set(flag, value);
  }
  const rawPort = values.get("--port");
  if (rawPort !== undefined && (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)) throw new LocalJobServiceError("invalid-config", "The CLI port must be an integer from 1 to 65535.");
  const careerProvider = values.get("--career-search"), careerEndpoint = values.get("--career-search-endpoint");
  if (careerProvider !== undefined && !["duckduckgo-html", "searxng"].includes(careerProvider)
    || careerEndpoint !== undefined && careerProvider !== "searxng") throw new LocalJobServiceError("invalid-config", "Career search supports duckduckgo-html or searxng; only searxng accepts an endpoint.");
  const careerSearch: JobServiceConfig["careerSearch"] = careerProvider === "duckduckgo-html" ? { provider: "duckduckgo-html" }
    : careerProvider === "searxng" ? { provider: "searxng", endpoint: careerEndpoint ?? "" } : undefined;
  const officeProvider = values.get("--office-geocoder");
  if (officeProvider !== undefined && !["nominatim", "photon"].includes(officeProvider)) throw new LocalJobServiceError("invalid-config", "Office geocoding supports nominatim or photon only; omit the option to disable external address queries.");
  const config = validateJobServiceConfig({
    dataDirectory: values.get("--data-dir") ?? "",
    host: (values.get("--host") ?? "127.0.0.1") as JobServiceConfig["host"],
    port: rawPort === undefined ? 5178 : Number(rawPort),
    allowedOrigins: origins,
    dns: (values.get("--dns") ?? "system") as JobServiceConfig["dns"],
    ...(careerSearch ? { careerSearch } : {}),
    ...(officeProvider === "nominatim" || officeProvider === "photon" ? { officeGeocoder: { provider: officeProvider } } : {}),
  });
  return { help: false, config };
}
export type JobServiceSignalSource = {
  on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  off: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
};
export async function runJobServiceCli(args: readonly string[], options: {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  signals?: JobServiceSignalSource;
  start?: (config: JobServiceConfig) => Promise<LocalJobServiceHandle>;
} = {}): Promise<number> {
  const output = options.stdout ?? ((text) => { process.stdout.write(text); });
  const errors = options.stderr ?? ((text) => { process.stderr.write(text); });
  let parsed: ReturnType<typeof parseJobServiceArgs>;
  try { parsed = parseJobServiceArgs(args); }
  catch (error) { errors(`${error instanceof LocalJobServiceError ? error.message : "Invalid service options."}\n`); return 2; }
  if (parsed.help) { output(JOB_SERVICE_USAGE); return 0; }
  const signals = options.signals ?? process;
  let notifyStop!: () => void;
  const stopRequested = new Promise<void>((resolveStop) => { notifyStop = resolveStop; });
  signals.on("SIGINT", notifyStop);
  signals.on("SIGTERM", notifyStop);
  try {
    const service = await (options.start ?? startLocalJobService)(parsed.config);
    output(`BetterMe job service: ${service.url}\nData directory: ${JSON.stringify(service.dataDirectory)}\nDatabase: ${JSON.stringify(service.databasePath)}\nToken file: ${JSON.stringify(service.tokenPath)}\nAllowed UI origins: ${JSON.stringify(service.allowedOrigins)}\nDNS provider: ${service.dns}\nCareer search: ${parsed.config.careerSearch?.provider ?? "disabled"}\nOffice address lookup: ${parsed.config.officeGeocoder?.provider ?? "disabled"}\nRecovered interrupted runs: ${service.recoveredRuns}\n`);
    await stopRequested;
    await service.close();
    output("Job service stopped after pending writes finished.\n");
    return 0;
  } catch (error) {
    errors(`${error instanceof LocalJobServiceError ? error.message : "The job service failed; inspect its local configuration and data directory."}\n`);
    return 1;
  } finally {
    signals.off("SIGINT", notifyStop);
    signals.off("SIGTERM", notifyStop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await runJobServiceCli(process.argv.slice(2));
