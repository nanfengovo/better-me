# Macchiato native adaptation

- Upstream: https://github.com/biosan/jsonresume-theme-macchiato
- Fixed source: npm 1.1.0; tarball SHA-1 66d61b804b191f9402dfbe95d39d9586be5199b4
- License: MIT
- Public package author: Alessandro Biondi
- BetterMe files: apps/web/src/components/templates/jsonresume-community-themes.css and jsonresume-community-catalog.ts, scoped template ID jsonresume-macchiato.

LICENSE copied verbatim from the pinned npm package.

## Source and changes

Source archive includes (review focused on layout, CSS, field bindings and licensing): commitlint.config.js, index.js, src/resume.hbs, src/style.css, src/partials/about.hbs, src/partials/awards.hbs, src/partials/basics.hbs, src/partials/education.hbs, src/partials/info-tag.hbs, src/partials/interests.hbs, src/partials/languages.hbs, src/partials/projects.hbs, src/partials/publications.hbs, src/partials/references.hbs, src/partials/resume-header.hbs, src/partials/section-header.hbs, src/partials/skills.hbs, src/partials/social.hbs, src/partials/summary.hbs, src/partials/title.hbs, src/partials/volunteer.hbs, src/partials/work.hbs, src/__tests__/visual.js.

This is a native React/CSS adaptation of the source layout for BetterMe ProjectedResume, not a bundled upstream renderer. It keeps the source's identity and chapter/entry treatments; fixed source column assignments become a profile rail or sequential body to preserve movable sections and printing. It does not infer JSON Resume fields missing from the factual projection. All content, dates, visibility, anchors and rich text remain controlled by BetterMe.

System font fallbacks replace downloaded fonts. No icon fonts, Bootstrap/Tailwind resets, external styles/scripts, example resume, Gravatar lookup, duration/skill calculations or source JavaScript are shipped. Web/dark/print source variants become a white A4 paper with the user's color, sizing and margins. The host workspace theme never recolors the paper. Original layout/renderer/typography differences mean pixel equality with upstream is not promised.

Open tracking, light section labels and a separate profile rail.
