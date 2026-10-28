import { createControlledSourceTransport, createGoogleDohResolver, createCareerWebSearchProvider } from "@better-me/source-adapters";
import { createJobApplication } from "./application.js";
import { createNominatimOfficeProvider, createAmapOfficeProvider } from "./office-address-provider.js";
import type { JobRepository } from "./repository.js";
import type { JobServiceConfig } from "./lifecycle.js";

/** Host-selected dependencies only; no endpoint/provider can be installed by an RPC. */
export function configuredApplicationOptions(config: JobServiceConfig, repository: JobRepository) {
  const transport = createControlledSourceTransport({ ...(config.dns === "google-doh" ? { resolve: createGoogleDohResolver() } : {}), timeoutMs: 35_000 });
  return {
    repository, transport,
    ...(config.officeGeocoder?.provider === "nominatim" ? { officeAddressProvider: createNominatimOfficeProvider(transport) } : {}),
    ...(config.officeGeocoder?.provider === "amap" ? { officeAddressProvider: createAmapOfficeProvider(transport, { key: config.officeGeocoder.key, dataDirectory: config.dataDirectory }) } : {}),
    ...(config.careerSearch ? { careerWebSearchProvider: createCareerWebSearchProvider(config.careerSearch) } : {}),
  } satisfies Parameters<typeof createJobApplication>[0];
}
