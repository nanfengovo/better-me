# Tan Responsive native adaptation

- Upstream: https://github.com/veeravn/jsonresume-theme-responsive
- Fixed source: npm 0.0.7; tarball SHA-1 7049b9dc06e6567e85fc97466dcabe91a24976aa
- License: MIT
- Public package author: Veerav Naidu
- BetterMe files: apps/web/src/components/templates/jsonresume-community-themes.css and jsonresume-community-catalog.ts, scoped template ID jsonresume-tan-responsive.

LICENSE copied verbatim from the pinned npm package.

## Source and changes

Source archive includes (review focused on layout, CSS, field bindings and licensing): index.js, style.css.

This is a native React/CSS adaptation of the source layout for BetterMe ProjectedResume, not a bundled upstream renderer. It keeps the source's identity and chapter/entry treatments; fixed source column assignments become a profile rail or sequential body to preserve movable sections and printing. It does not infer JSON Resume fields missing from the factual projection. All content, dates, visibility, anchors and rich text remain controlled by BetterMe.

System font fallbacks replace downloaded fonts. No icon fonts, Bootstrap/Tailwind resets, external styles/scripts, example resume, Gravatar lookup, duration/skill calculations or source JavaScript are shipped. Web/dark/print source variants become a white A4 paper with the user's color, sizing and margins. The host workspace theme never recolors the paper. Original layout/renderer/typography differences mean pixel equality with upstream is not promised.

A gray information band, amber rule and italic marginal chapter labels.
