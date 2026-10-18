# Professional native adaptation

- Upstream: https://github.com/jsonresume/jsonresume.org
- Fixed source: Git dd0155358c8d85a134d434e49834705243b5eede; packages/themes/jsonresume-theme-professional
- License: MIT
- Public package author: See upstream root copyright and package history
- BetterMe files: apps/web/src/components/templates/jsonresume-community-themes.css and jsonresume-community-catalog.ts, scoped template ID jsonresume-professional.

LICENSE copied verbatim from the fixed monorepo root. Package metadata independently declares MIT. Original package authorship is retained in UPSTREAM_PACKAGE.json.

## Source and changes

Source archive includes (review focused on layout, CSS, field bindings and licensing): .eslintrc.js, vite.config.js, src/index.jsx, src/ui/Awards.jsx, src/ui/Certificates.jsx, src/ui/Date.jsx, src/ui/DateRange.jsx, src/ui/Education.jsx, src/ui/Experience.jsx, src/ui/Hero.jsx, src/ui/Interests.jsx, src/ui/Languages.jsx, src/ui/List.jsx, src/ui/OneLineList.jsx, src/ui/Projects.jsx, src/ui/Publications.jsx, src/ui/References.jsx, src/ui/Resume.jsx, src/ui/Section.jsx, src/ui/Skills.jsx, src/ui/SubTitle.jsx, src/ui/Summary.jsx, src/ui/Volunteer.jsx, src/ui/Work.jsx.

This is a native React/CSS adaptation of the source layout for BetterMe ProjectedResume, not a bundled upstream renderer. It keeps the source's identity and chapter/entry treatments; fixed source column assignments become a profile rail or sequential body to preserve movable sections and printing. It does not infer JSON Resume fields missing from the factual projection. All content, dates, visibility, anchors and rich text remain controlled by BetterMe.

System font fallbacks replace downloaded fonts. No icon fonts, Bootstrap/Tailwind resets, external styles/scripts, example resume, Gravatar lookup, duration/skill calculations or source JavaScript are shipped. Web/dark/print source variants become a white A4 paper with the user's color, sizing and margins. The host workspace theme never recolors the paper. Original layout/renderer/typography differences mean pixel equality with upstream is not promised.

A large centered identity, italic roles and open, simple chapters.
