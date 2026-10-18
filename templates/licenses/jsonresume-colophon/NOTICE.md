# Colophon native adaptation

- Upstream: https://github.com/dmnelson/jsonresume-theme-colophon
- Fixed source: npm 0.2.0; tarball SHA-1 5f4ad827d81a8b907ba54737035ce0263ba8167a
- License: MIT
- Public package author: {'name': 'David Nelson', 'url': 'https://github.com/dmnelson'}
- BetterMe files: apps/web/src/components/templates/jsonresume-community-themes.css and jsonresume-community-catalog.ts, scoped template ID jsonresume-colophon.

LICENSE copied verbatim from the pinned npm package.

## Source and changes

Source archive includes (review focused on layout, CSS, field bindings and licensing): index.js, style.css, dist/index.js.

This is a native React/CSS adaptation of the source layout for BetterMe ProjectedResume, not a bundled upstream renderer. It keeps the source's identity and chapter/entry treatments; fixed source column assignments become a profile rail or sequential body to preserve movable sections and printing. It does not infer JSON Resume fields missing from the factual projection. All content, dates, visibility, anchors and rich text remain controlled by BetterMe.

System font fallbacks replace downloaded fonts. No icon fonts, Bootstrap/Tailwind resets, external styles/scripts, example resume, Gravatar lookup, duration/skill calculations or source JavaScript are shipped. Web/dark/print source variants become a white A4 paper with the user's color, sizing and margins. The host workspace theme never recolors the paper. Original layout/renderer/typography differences mean pixel equality with upstream is not promised.

A large serif name, monospaced marginal chapter notes and warm fine rules.
