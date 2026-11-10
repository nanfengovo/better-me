/** One non-letter product identity across the desktop, login and settings. */
export function ProductMark({ size = 24 }: { size?: number }) {
  const base = import.meta.env?.BASE_URL ?? "/";
  return <img className="betterme-product-mark" src={`${base}brand/betterme-icon.png`} alt="" aria-hidden="true" width={size} height={size} style={{ display: "block", flexShrink: 0, objectFit: "contain" }} />;
}
