# Creative Confidence native adaptation

- Upstream: https://github.com/jsonresume/jsonresume.org
- Fixed source: Git dd0155358c8d85a134d434e49834705243b5eede; packages/themes/jsonresume-theme-creative-confidence
- License: MIT
- Public package author: Scott Lynde
- BetterMe files: apps/web/src/components/templates/jsonresume-community-themes.css and jsonresume-community-catalog.ts, scoped template ID jsonresume-creative-confidence.

LICENSE copied verbatim from the fixed monorepo root. Package metadata independently declares MIT. Original package authorship is retained in UPSTREAM_PACKAGE.json.

## Source and changes

Source archive includes (review focused on layout, CSS, field bindings and licensing): index.js.

This is a native React/CSS adaptation of the source layout for BetterMe ProjectedResume, not a bundled upstream renderer. It keeps the source's identity and chapter/entry treatments; fixed source column assignments become a profile rail or sequential body to preserve movable sections and printing. It does not infer JSON Resume fields missing from the factual projection. All content, dates, visibility, anchors and rich text remain controlled by BetterMe.

System font fallbacks replace downloaded fonts. No icon fonts, Bootstrap/Tailwind resets, external styles/scripts, example resume, Gravatar lookup, duration/skill calculations or source JavaScript are shipped. Web/dark/print source variants become a white A4 paper with the user's color, sizing and margins. The host workspace theme never recolors the paper. Original layout/renderer/typography differences mean pixel equality with upstream is not promised.

A centered navy banner, italic entry subtitles and a pale-blue skill area; sections retain your order.
