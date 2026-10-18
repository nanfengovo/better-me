# Elegant native adaptation

- Upstream: https://github.com/mudassir0909/jsonresume-theme-elegant
- Fixed source: npm 1.16.1; tarball SHA-1 7882cea1378684f76dc3aef770e15cd27ebdf4f9
- License: MIT
- Public package author: Mudassir Ali <mudassir.dev@gmail.com>
- BetterMe files: apps/web/src/components/templates/jsonresume-community-themes.css and jsonresume-community-catalog.ts, scoped template ID jsonresume-elegant.

The pinned package explicitly declares SPDX MIT in package.json but ships no standalone license file. LICENSE reproduces the standard license terms; it is not represented as a verbatim upstream file. The original package metadata and authorship are retained in UPSTREAM_PACKAGE.json. No copyright year has been invented.

## Source and changes

Source archive includes (review focused on layout, CSS, field bindings and licensing): Gruntfile.js, index.js, index.pug, moment-precise-range.js, render.js, serve.js, assets/css/theme.css, assets/less/base.less, assets/less/floating-nav.less, assets/less/icon.less, assets/less/info_card_styles.less, assets/less/mixins.less, assets/less/print.less, assets/less/theme.less, assets/less/utilities.less, assets/less/variables.less, assets/less/vendor-overrides.less, assets/less/sections/awards.less, assets/less/sections/education.less, assets/less/sections/interests.less, assets/less/sections/projects_experience.less, assets/less/sections/publications.less, assets/less/sections/references.less, assets/less/sections/skills.less, assets/less/sections/volunteer_work.less, assets/less/sections/work_experience.less, pug/background-card.pug, pug/floating-nav.pug, pug/profile-card.pug, pug/scripts.pug, pug/stylesheets.pug, pug/background/about.pug, pug/background/awards.pug, pug/background/certificates.pug, pug/background/education.pug.

This is a native React/CSS adaptation of the source layout for BetterMe ProjectedResume, not a bundled upstream renderer. It keeps the source's identity and chapter/entry treatments; fixed source column assignments become a profile rail or sequential body to preserve movable sections and printing. It does not infer JSON Resume fields missing from the factual projection. All content, dates, visibility, anchors and rich text remain controlled by BetterMe.

System font fallbacks replace downloaded fonts. No icon fonts, Bootstrap/Tailwind resets, external styles/scripts, example resume, Gravatar lookup, duration/skill calculations or source JavaScript are shipped. Web/dark/print source variants become a white A4 paper with the user's color, sizing and margins. The host workspace theme never recolors the paper. Original layout/renderer/typography differences mean pixel equality with upstream is not promised.

A softly shaded identity card, fine chapter borders and blue accents.
