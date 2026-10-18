/** Known visible DT labels only; do not infer a duties section from its position or size. */
export function isLiepinDescriptionHeading(text: string): boolean {
  const label = text.replace(/\s+/g, "").replace(/[:：]$/, "");
  return /^(?:职位描述|职责描述|岗位职责|工作职责|职位介绍)$/.test(label);
}

/** Requirements only supplement one identified duties paragraph in the same section. */
export function isLiepinRequirementsHeading(text: string): boolean {
  const label = text.replace(/\s+/g, "").replace(/[:：]$/, "");
  return /^(?:任职要求|职位要求)$/.test(label);
}
