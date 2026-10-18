/** Chinese Deedy source adaptation. The original 25/73 minipages contain
 * fixed semantic groups; here the profile occupies the rail and all resume
 * chapters retain the user's selected section order in the main column. */
export const DEEDY_TEMPLATES = [{
  id: "deedy", source: "community", name: "Deedy · 中文适配", label: "DEEDY 中文",
  description: "居中宋体姓名、细分隔线与四分之一资料轨；教育、技能和经历按当前分节顺序保留在正文。",
  tag: "宋体与窄资料轨",
  en: { name: "Deedy · Chinese adaptation", description: "A centered serif identity, fine rule and quarter-width profile rail. Education, skills and experience retain the current chapter order in the main column.", tag: "Serif identity and narrow rail" },
  recommended: { accentColor: "#6a6a6a", fontFamily: "serif" },
  upstreamUrl: "https://github.com/dyweb/Deedy-Resume-for-Chinese", licensePath: "deedy", licenseLabel: "Apache-2.0",
}] as const;
