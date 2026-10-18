# Lucide native adaptation

- Upstream: https://github.com/Clement-Cauet/jsonresume-theme-lucide
- Fixed source: npm 1.1.0; tarball SHA-1 7f73c295c1d5ef85bdaf352906a2938d579d6cfe
- License: MIT
- Public package author: Clement Cauet
- BetterMe files: apps/web/src/components/templates/jsonresume-community-themes.css and jsonresume-community-catalog.ts, scoped template ID jsonresume-lucide.

The pinned package explicitly declares SPDX MIT in package.json but ships no standalone license file. LICENSE reproduces the standard license terms; it is not represented as a verbatim upstream file. The original package metadata and authorship are retained in UPSTREAM_PACKAGE.json. No copyright year has been invented.

## Source and changes

Source archive includes (review focused on layout, CSS, field bindings and licensing): index.js, resume.hbs, test/SimpleTests.test.js, theme/.config/styles/style.css, theme/.config/styles/resume/card.css, theme/.config/styles/resume/content.css, theme/.config/styles/resume/header.css, theme/.config/styles/resume/section.css, theme/.config/styles/resume/sidebar.css, theme/hbs-helpers/birth-date.js, theme/hbs-helpers/date-helpers.js, theme/hbs-helpers/name-split.js, theme/hbs-helpers/paragraph-split.js, theme/hbs-helpers/space-to-dash.js, theme/hbs-helpers/to-lower-case.js, theme/partials/awards.hbs, theme/partials/certificates.hbs, theme/partials/content.hbs, theme/partials/date.hbs, theme/partials/education.hbs, theme/partials/header.hbs, theme/partials/informations.hbs, theme/partials/interests.hbs, theme/partials/languages.hbs, theme/partials/picture.hbs, theme/partials/projects.hbs, theme/partials/publications.hbs, theme/partials/references.hbs, theme/partials/sidebar.hbs, theme/partials/skills.hbs, theme/partials/soft-skills.hbs, theme/partials/volunteer.hbs, theme/partials/work.hbs.

This is a native React/CSS adaptation of the source layout for BetterMe ProjectedResume, not a bundled upstream renderer. It keeps the source's identity and chapter/entry treatments; fixed source column assignments become a profile rail or sequential body to preserve movable sections and printing. It does not infer JSON Resume fields missing from the factual projection. All content, dates, visibility, anchors and rich text remain controlled by BetterMe.

System font fallbacks replace downloaded fonts. No icon fonts, Bootstrap/Tailwind resets, external styles/scripts, example resume, Gravatar lookup, duration/skill calculations or source JavaScript are shipped. Web/dark/print source variants become a white A4 paper with the user's color, sizing and margins. The host workspace theme never recolors the paper. Original layout/renderer/typography differences mean pixel equality with upstream is not promised.

A blue rounded profile rail with clear body and date hierarchy.
