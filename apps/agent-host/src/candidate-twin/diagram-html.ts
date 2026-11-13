import { createHash } from "node:crypto";
import { CandidateTwinError, type TwinDiagram } from "./types.js";

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
function lines(text: string, maximum = 3): string[] {
  const points = [...text], result: string[] = [];
  for (let offset = 0; offset < points.length && result.length < maximum; offset += 22) result.push(points.slice(offset, offset + 22).join(""));
  if (points.length > 22 * maximum) result[result.length - 1] = `${result.at(-1)!.slice(0, -1)}…`;
  return result;
}

/** Static presentation of already-approved public fields. No original source
 * IDs, paths, DOM markup, coordinates, event handlers or network resources are
 * accepted from the diagram. Exact long labels remain available in titles and
 * an escaped textual topology below the drawing. This is not a renderer of
 * private whiteboard notes or evidence, and cannot certify implementation. */
export function renderTwinDiagramHtml(diagram: TwinDiagram, publicationId: string): string {
  if (!Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges) || diagram.nodes.length > 100 || diagram.edges.length > 200
    || new Set(diagram.nodes.map(node => node.id)).size !== diagram.nodes.length
    || diagram.nodes.some(node => typeof node.id !== "string" || typeof node.label !== "string" || !node.label.trim() || [...node.label].length > 200)
    || diagram.edges.some(edge => typeof edge.label !== "string" || [...edge.label].length > 200)) throw new CandidateTwinError("invalid_twin_diagram");
  const columns = Math.max(1, Math.min(4, diagram.nodes.length)), width = columns * 236 + 36;
  const height = Math.max(96, Math.ceil(diagram.nodes.length / columns) * 112 + 36);
  const boxes = new Map(diagram.nodes.map((node, index) => [node.id, { x: 18 + index % columns * 236, y: 18 + Math.floor(index / columns) * 112, label: node.label }]));
  if (diagram.edges.some(edge => !boxes.has(edge.from) || !boxes.has(edge.to))) throw new CandidateTwinError("invalid_twin_diagram");
  const suffix = createHash("sha256").update(publicationId).digest("hex").slice(0, 16), arrow = `twin-arrow-${suffix}`;
  const edges = diagram.edges.map(edge => {
    const from = boxes.get(edge.from)!, to = boxes.get(edge.to)!, sameRow = from.y === to.y, forward = from.x < to.x;
    const x1 = sameRow ? from.x + (forward ? 212 : 0) : from.x + 106, y1 = sameRow ? from.y + 38 : from.y + 76;
    const x2 = sameRow ? to.x + (forward ? 0 : 212) : to.x + 106, y2 = sameRow ? to.y + 38 : to.y;
    const middleX = (x1 + x2) / 2, middleY = (y1 + y2) / 2;
    const path = edge.from === edge.to ? `M ${from.x + 212} ${from.y + 22} C ${from.x + 232} ${from.y - 2}, ${from.x + 232} ${from.y + 78}, ${from.x + 212} ${from.y + 54}`
      : sameRow ? `M ${x1} ${y1} C ${middleX} ${y1}, ${middleX} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} C ${x1} ${middleY}, ${x2} ${middleY}, ${x2} ${y2}`;
    return `<g><title>${escape(`${from.label} → ${to.label}${edge.label ? `: ${edge.label}` : ""}`)}</title><path d="${path}" fill="none" stroke="#52667e" stroke-width="1.8" marker-end="url(#${arrow})"/>${edge.label ? `<text x="${middleX}" y="${middleY - 7}" text-anchor="middle" font-size="11" fill="#24364b" paint-order="stroke" stroke="white" stroke-width="3">${escape(lines(edge.label, 1)[0]!)}</text>` : ""}</g>`;
  }).join("");
  const nodes = [...boxes.values()].map(box => {
    const labelLines = lines(box.label), firstY = box.y + 38 - (labelLines.length - 1) * 8;
    return `<g><title>${escape(box.label)}</title><rect x="${box.x}" y="${box.y}" width="212" height="76" rx="9" fill="#f4f8fd" stroke="#607a96"/><text x="${box.x + 106}" y="${firstY}" text-anchor="middle" font-size="12" fill="#142a42">${labelLines.map((line, index) => `<tspan x="${box.x + 106}" dy="${index ? 16 : 0}">${escape(line)}</tspan>`).join("")}</text></g>`;
  }).join("");
  const text = `<ul>${diagram.nodes.map(node => `<li>${escape(node.label)}</li>`).join("")}</ul><ul>${diagram.edges.map(edge => `<li>${escape(boxes.get(edge.from)!.label)} → ${escape(boxes.get(edge.to)!.label)}${edge.label ? `: ${escape(edge.label)}` : ""}</li>`).join("")}</ul>`;
  return `<figure><figcaption>Approved architecture design — not proof of implementation or authorship.</figcaption><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="twin-title-${suffix} twin-desc-${suffix}" style="display:block;width:100%;height:auto;max-width:100%;font-family:system-ui,sans-serif"><title id="twin-title-${suffix}">Approved architecture topology</title><desc id="twin-desc-${suffix}">${diagram.nodes.length} design nodes and ${diagram.edges.length} selected connections. Full labels are available in the text topology.</desc><defs><marker id="${arrow}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7 Z" fill="#52667e"/></marker></defs>${edges}${nodes}</svg><details><summary>Exact approved topology labels</summary>${text}</details></figure>`;
}
