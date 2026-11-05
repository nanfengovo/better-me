import { z } from "zod";

export const SocialProviderIdSchema = z.enum(["wechat", "qq", "github", "google", "microsoft", "gitlab", "discord"]);
export type SocialProviderId = z.infer<typeof SocialProviderIdSchema>;
export const SOCIAL_PROVIDERS = [
  { id: "wechat", label: "微信", type: "WeChat", primary: true },
  { id: "qq", label: "QQ", type: "QQ", primary: true },
  { id: "github", label: "GitHub", type: "GitHub", primary: true },
  { id: "google", label: "Google", type: "Google", primary: true },
  // Exact adapter names in the pinned Casdoor v4.25.0, not display names.
  { id: "microsoft", label: "Microsoft", type: "AzureAD", primary: false },
  { id: "gitlab", label: "GitLab", type: "GitLab", primary: false },
  { id: "discord", label: "Discord", type: "Discord", primary: false },
] as const;

export const SocialChannelSchema = z.object({
  id: SocialProviderIdSchema,
  label: z.string().max(30),
  state: z.enum(["available", "not_configured", "disabled", "unsafe_binding", "unsupported_context", "unavailable"]),
  message: z.string().max(300),
  canSignUp: z.boolean(),
}).strict();
export type SocialChannel = z.infer<typeof SocialChannelSchema>;

/** Public capability metadata, never upstream profiles, provider IDs or credentials. */
export const SocialLoginCatalogSchema = z.object({
  casdoor: z.boolean(),
  service: z.enum(["ready", "offline", "not_configured"]),
  message: z.string().max(300),
  authorizeOrigin: z.string().url().optional(),
  unifiedLoginAvailable: z.boolean(),
  // Keep accepting the original four-channel response during a rolling local reload.
  channels: z.array(SocialChannelSchema).min(4).max(SOCIAL_PROVIDERS.length).superRefine((channels, context) => {
    const ids = new Set(channels.map(channel => channel.id));
    if (ids.size !== channels.length || SOCIAL_PROVIDERS.some(provider => provider.primary && !ids.has(provider.id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Login catalog must include each primary channel once and contain no duplicate channels" });
    }
  }),
}).strict();
export type SocialLoginCatalog = z.infer<typeof SocialLoginCatalogSchema>;
export const LoginMethodsSchema = z.object({ localPassword: z.boolean(), unifiedLinked: z.boolean() }).strict();
export type LoginMethods = z.infer<typeof LoginMethodsSchema>;
