# Even native adaptation

- Upstream: https://github.com/rbardini/jsonresume-theme-even
- Fixed source: npm 0.26.1; tarball SHA-1 5213abd46f48ba65854c4a4eca7dccbf1d0a3bfa
- License: MIT
- Public package author: Rafael Bardini
- BetterMe files: apps/web/src/components/templates/jsonresume-community-themes.css and jsonresume-community-catalog.ts, scoped template ID jsonresume-even.

LICENSE copied verbatim from the pinned npm package.

## Source and changes

Source archive includes (review focused on layout, CSS, field bindings and licensing): bin/cli.js, dist/index.js.

This is a native React/CSS adaptation of the source layout for BetterMe ProjectedResume, not a bundled upstream renderer. It keeps the source's identity and chapter/entry treatments; fixed source column assignments become a profile rail or sequential body to preserve movable sections and printing. It does not infer JSON Resume fields missing from the factual projection. All content, dates, visibility, anchors and rich text remain controlled by BetterMe.

System font fallbacks replace downloaded fonts. No icon fonts, Bootstrap/Tailwind resets, external styles/scripts, example resume, Gravatar lookup, duration/skill calculations or source JavaScript are shipped. Web/dark/print source variants become a white A4 paper with the user's color, sizing and margins. The host workspace theme never recolors the paper. Original layout/renderer/typography differences mean pixel equality with upstream is not promised.

A light masthead, clear sections and a continuous experience timeline.
