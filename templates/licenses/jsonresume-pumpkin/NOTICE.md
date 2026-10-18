# Pumpkin native adaptation

- Upstream: https://github.com/bvosk/jsonresume-theme-pumpkin
- Fixed source: npm 1.1.4; tarball SHA-1 ec5dbc0f80556fdc6c12d93cbb062b5cd4543ebc
- License: MIT
- Public package author: Brian
- BetterMe files: apps/web/src/components/templates/jsonresume-community-themes.css and jsonresume-community-catalog.ts, scoped template ID jsonresume-pumpkin.

The pinned package explicitly declares SPDX MIT in package.json but ships no standalone license file. LICENSE reproduces the standard license terms; it is not represented as a verbatim upstream file. The original package metadata and authorship are retained in UPSTREAM_PACKAGE.json. No copyright year has been invented.

## Source and changes

Source archive includes (review focused on layout, CSS, field bindings and licensing): index.js, resume.hbs, style.css.

This is a native React/CSS adaptation of the source layout for BetterMe ProjectedResume, not a bundled upstream renderer. It keeps the source's identity and chapter/entry treatments; fixed source column assignments become a profile rail or sequential body to preserve movable sections and printing. It does not infer JSON Resume fields missing from the factual projection. All content, dates, visibility, anchors and rich text remain controlled by BetterMe.

System font fallbacks replace downloaded fonts. No icon fonts, Bootstrap/Tailwind resets, external styles/scripts, example resume, Gravatar lookup, duration/skill calculations or source JavaScript are shipped. Web/dark/print source variants become a white A4 paper with the user's color, sizing and margins. The host workspace theme never recolors the paper. Original layout/renderer/typography differences mean pixel equality with upstream is not promised.

A charcoal identity banner, golden accents and flat chapter labels.
