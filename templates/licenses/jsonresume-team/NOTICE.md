# JSON Resume Team — 48 native BetterMe adaptations

Upstream: https://github.com/jsonresume/jsonresume.org

Pinned revision: `dd0155358c8d85a134d434e49834705243b5eede`

Copyright (c) 2014-2026 JSON Resume contributors. MIT; adjacent LICENSE is
copied byte for byte from the repository root at this revision. These selected
theme directories have no overriding subdirectory LICENSE. Some package.json
files omit a license field; those records explicitly use the root grant, not
an invented per-package declaration.

The official source catalog is packages/theme-config/src/metadata.js. This
group includes only its 48 JSON Resume Team entries; other authors and external
packages are audited separately and are not covered by this notice.

Adapted file: apps/web/src/components/templates/jsonresume-extra-themes.css.
Metadata: apps/web/src/components/templates/jsonresume-extra-catalog.ts. Per-file SHA-256, exact package
versions, dependencies, activity limits, and adaptation limits are recorded in
templates/jsonresume-team-source-index.json. No upstream build was executed.

These are native React/CSS adaptations over BetterMe's existing factual
renderer, not complete copies of the source frameworks or schema. Shared
content remains authoritative for facts, visibility, order, selected text
formatting, safe links and preview anchors. Upstream fonts/icons, screenshots,
sample facts, marketing logos, animations, dark paper mode, remote resources,
HTML formatting libraries, and template runtimes are excluded. System fonts
replace named web fonts; page margins and type sizes follow current controls.
No proficiency scores, metric sections, credentials or missing facts are inferred.

Category layouts that originally fixed work/education/skills in different
columns are adapted to sequential content. Executive Slate, Sidebar,
Two-Column Modernist and Sidebar Photo Strip retain a profile-only rail while
every content section keeps user order. Asymmetric Timeline uses staggered
sequential cards and normalizes the inset on print. University First does not
automatically reorder education. These differences are deliberate and are not
described as exact upstream output, Typst output or PDF/DOCX parity.

## Per-theme source paths

- **Desert Modern 0.1.5**: `packages/themes/jsonresume-theme-desert-modern/`; `src/index.jsx`, `src/Resume.jsx`, `src/styles.jsx`, `tests/theme.test.js`. Design basis: sand-tinted identity, widely spaced chapter labels and fine rules.
- **Elegant Pink 0.1.5**: `packages/themes/jsonresume-theme-elegant-pink/`; `src/index.jsx`, `src/Resume.jsx`, `tests/theme.test.js`. Design basis: rose gradient masthead, strong name and lightly shaded skill labels.
- **Tailwind 0.0.0**: `packages/themes/jsonresume-theme-tailwind/`; `src/index.jsx`, `src/ui/About.jsx`, `src/ui/Avatar.jsx`, `src/ui/Awards.jsx`, `src/ui/Badge.jsx`, `src/ui/Basics.jsx`, `src/ui/Button.jsx`, `src/ui/Card.jsx`, `src/ui/Certificates.jsx`, `src/ui/Date.jsx`, `src/ui/DateRange.jsx`, `src/ui/Education.jsx`, `src/ui/Experience.jsx`, `src/ui/Hero.jsx`, `src/ui/Interests.jsx`, `src/ui/Languages.jsx`, `src/ui/List.jsx`, `src/ui/ProjectCard.jsx`, `src/ui/Projects.jsx`, `src/ui/Publications.jsx`, `src/ui/References.jsx`, `src/ui/Resume.jsx`, `src/ui/Section.jsx`, `src/ui/Skills.jsx`, `src/ui/SubTitle.jsx`, `src/ui/Summary.jsx`, `src/ui/utils.js`, `src/ui/Volunteer.jsx`, `src/ui/Work.jsx`, `tailwind.config.js`, `tests/theme.test.js`. Design basis: lightweight identity, monospaced dates and rounded outlined badges.
- **Academic CV Lite 0.2.4**: `packages/themes/jsonresume-theme-academic-cv-lite/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: centered scholarly header, text hierarchy and fine chapter rules.
- **Bold Header Statement 1.1.4**: `packages/themes/jsonresume-theme-bold-header-statement/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: teal identity banner, bold display name and outlined skill blocks.
- **Architect's Portfolio 1.1.4**: `packages/themes/jsonresume-theme-architects-portfolio/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: light geometric identity, extended keylines and fine framed labels.
- **Consultant Polished 1.0.3**: `packages/themes/jsonresume-theme-consultant-polished/`; `src/index.jsx`, `src/ui/Awards.jsx`, `src/ui/Certificates.jsx`, `src/ui/Education.jsx`, `src/ui/Hero.jsx`, `src/ui/Interests.jsx`, `src/ui/Languages.jsx`, `src/ui/Projects.jsx`, `src/ui/Publications.jsx`, `src/ui/References.jsx`, `src/ui/Resume.jsx`, `src/ui/Section.jsx`, `src/ui/Skills.jsx`, `src/ui/Summary.jsx`, `src/ui/Volunteer.jsx`, `src/ui/Work.jsx`. Design basis: navy headings, recommended serif type and measured double-rule hierarchy.
- **Creative Studio 1.1.3**: `packages/themes/jsonresume-theme-creative-studio/`; `src/index.jsx`, `src/ui/Awards.jsx`, `src/ui/Certificates.jsx`, `src/ui/Date.js`, `src/ui/DateRange.jsx`, `src/ui/Education.jsx`, `src/ui/Hero.jsx`, `src/ui/Interests.jsx`, `src/ui/Languages.jsx`, `src/ui/Projects.jsx`, `src/ui/Publications.jsx`, `src/ui/References.jsx`, `src/ui/Resume.jsx`, `src/ui/Section.jsx`, `src/ui/Skills.jsx`, `src/ui/Summary.jsx`, `src/ui/Volunteer.jsx`, `src/ui/Work.jsx`. Design basis: coral-tinted masthead, rounded labels and soft experience cards.
- **Data-Driven 0.2.4**: `packages/themes/jsonresume-theme-data-driven/`; `src/index.jsx`, `src/ui/Resume.jsx`, `tests/theme.test.js`, `vitest.config.js`. Design basis: geometric uppercase identity, tabular dates and outlined skill tags.
- **Developer Mono 0.2.5**: `packages/themes/jsonresume-theme-developer-mono/`; `index.js`, `src/index.jsx`, `src/Resume.jsx`. Design basis: monospaced identity, code-block skills and blue accents.
- **Executive Slate 1.1.4**: `packages/themes/jsonresume-theme-executive-slate/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: slate profile rail, open main content and ruled skills.
- **Government Standard 0.2.4**: `packages/themes/jsonresume-theme-government-standard/`; `src/components/EducationSection.jsx`, `src/components/OtherSections.jsx`, `src/components/SkillsSection.jsx`, `src/components/WorkSection.jsx`, `src/index.jsx`, `src/Resume.jsx`. Design basis: centered formal identity, weighted rules and monochrome structure.
- **Marketing Narrative 0.2.4**: `packages/themes/jsonresume-theme-marketing-narrative/`; `src/index.jsx`, `src/Resume.jsx`, `src/sections/EducationSection.jsx`, `src/sections/OtherSections.jsx`, `src/sections/SkillsSection.jsx`, `src/sections/WorkSection.jsx`. Design basis: centered masthead, rose role line and narrative experience blocks.
- **Minimalist Grid 0.2.4**: `packages/themes/jsonresume-theme-minimalist-grid/`; `index.js`, `src/index.jsx`, `src/Resume.jsx`. Design basis: light typography, open tracking, fine rules and whitespace.
- **Modern Classic 1.1.4**: `packages/themes/jsonresume-theme-modern-classic/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: clear name hierarchy, fine grey sections and railed skills.
- **Operations Precision 0.3.4**: `packages/themes/jsonresume-theme-operations-precision/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: compact header, teal rules and a skills table.
- **Product Manager Canvas 0.2.4**: `packages/themes/jsonresume-theme-product-manager-canvas/`; `index.js`, `src/index.jsx`, `src/Resume.jsx`. Design basis: centered identity, violet role line and outlined blocks.
- **Reference 0.2.4**: `packages/themes/jsonresume-theme-reference/`; `src/index.jsx`, `src/Resume.jsx`, `tests/theme.test.js`. Design basis: neutral centered identity, standard hierarchy and natural reading order.
- **Sales Hunter 0.2.4**: `packages/themes/jsonresume-theme-sales-hunter/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: bold uppercase name, green rules and solid skill labels.
- **Sidebar 0.2.4**: `packages/themes/jsonresume-theme-sidebar/`; `src/index.jsx`, `src/Resume.jsx`, `tests/theme.test.js`. Design basis: deep blue profile rail, divided main chapters and open content.
- **Tokyo Modernist 1.0.7**: `packages/themes/jsonresume-theme-tokyo-modernist/`; `src/index.jsx`, `src/ui/Resume.jsx`, `src/ui/styles.jsx`, `tests/theme.test.js`. Design basis: magenta edge, geometric corner accents and uppercase identity.
- **University First 0.2.4**: `packages/themes/jsonresume-theme-university-first/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: blue centered identity banner and approachable sections.
- **Writer's Portfolio 0.2.4**: `packages/themes/jsonresume-theme-writers-portfolio/`; `src/index.jsx`, `src/Resume.jsx`, `tests/theme.test.js`. Design basis: centered literary identity, recommended serif type and fine side rules.
- **Nordic Minimal 1.1.4**: `packages/themes/jsonresume-theme-nordic-minimal/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: light identity, cool grey rules and calm spacing.
- **Graph Paper Grid 1.1.4**: `packages/themes/jsonresume-theme-graph-paper-grid/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: fine graph background, framed header and technical labels.
- **Monochrome Noir 1.1.4**: `packages/themes/jsonresume-theme-monochrome-noir/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: monochrome contrast, bold uppercase name and fine separators.
- **Mid-Century Resume 1.1.4**: `packages/themes/jsonresume-theme-mid-century-resume/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: retro geometric identity, amber rules and centered framed labels.
- **Two-Column Modernist 1.1.4**: `packages/themes/jsonresume-theme-two-column-modernist/`; `src/index.jsx`, `src/Resume.jsx`, `tests/theme.test.js`. Design basis: asymmetric profile rail, fine dividers and neutral labels.
- **Sidebar Photo Strip 1.1.4**: `packages/themes/jsonresume-theme-sidebar-photo-strip/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: dark portrait rail, grayscale optional photo and lightweight body.
- **Diagonal Accent Bar 1.1.4**: `packages/themes/jsonresume-theme-diagonal-accent-bar/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: rose diagonal accent, tracked identity and railed skill labels.
- **Asymmetric Timeline 1.1.4**: `packages/themes/jsonresume-theme-asymmetric-timeline/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: centered identity, staggered experience cards and a fine timeline.
- **Typewriter Modern 1.1.4**: `packages/themes/jsonresume-theme-typewriter-modern/`; `src/index.jsx`, `src/Resume.jsx`. Design basis: recommended typewriter face, dashed chapters and paper-like labels.
- **New York Editorial 0.2.5**: `packages/themes/jsonresume-theme-new-york-editorial/`; `index.jsx`, `src/Resume.jsx`. Design basis: heavy recommended serif identity, centered rule and restrained red details.
- **Berlin Grid 0.2.5**: `packages/themes/jsonresume-theme-berlin-grid/`; `index.jsx`, `src/Resume.jsx`. Design basis: engineered heavy rules, rectangular skill grid and precise alignment.
- **Californian Warm 0.2.5**: `packages/themes/jsonresume-theme-californian-warm/`; `index.jsx`, `src/Resume.jsx`. Design basis: warm amber rounded identity, soft shadows and gentle labels.
- **London Bureau 0.2.5**: `packages/themes/jsonresume-theme-london-bureau/`; `index.jsx`, `src/Resume.jsx`. Design basis: heritage recommended serif identity, weighted rules and compact hierarchy.
- **Pacific Horizon 0.2.5**: `packages/themes/jsonresume-theme-pacific-horizon/`; `index.jsx`, `src/Resume.jsx`. Design basis: centered modern identity, short blue rules and open skills.
- **French Atelier 0.2.5**: `packages/themes/jsonresume-theme-french-atelier/`; `index.jsx`, `src/Resume.jsx`. Design basis: contrasting recommended serif identity, plum rules and editorial rhythm.
- **Clinical Precision 0.2.5**: `packages/themes/jsonresume-theme-clinical-precision/`; `index.jsx`, `src/Resume.jsx`. Design basis: chart-like identity, green entry rail, monospaced dates and mint skills.
- **Field Researcher 0.2.5**: `packages/themes/jsonresume-theme-field-researcher/`; `index.jsx`, `src/Resume.jsx`. Design basis: notebook chapter numbering, monospaced metadata and teal marginal rules.
- **Urban Techno 0.2.5**: `packages/themes/jsonresume-theme-urban-techno/`; `index.jsx`, `src/Resume.jsx`. Design basis: split black identity, hard rules and dense technical labels.
- **Coastal Creative 0.2.5**: `packages/themes/jsonresume-theme-coastal-creative/`; `index.jsx`, `src/Resume.jsx`. Design basis: calm centered identity, ocean-blue headings and softly framed skills.
- **Investor Brief 0.2.5**: `packages/themes/jsonresume-theme-investor-brief/`; `index.jsx`, `src/Resume.jsx`. Design basis: centered report identity, compact data hierarchy and pale skill blocks.
- **Art School Modern 0.2.5**: `packages/themes/jsonresume-theme-art-school-modern/`; `index.jsx`, `src/Resume.jsx`. Design basis: gallery-like display identity, numbered chapters and vermilion details.
- **Community Garden 0.1.6**: `packages/themes/jsonresume-theme-community-garden/`; `index.jsx`, `src/Resume.jsx`. Design basis: sky-and-garden identity panel, rounded skills and approachable spacing.
- **Industrial Engineer 0.2.5**: `packages/themes/jsonresume-theme-industrial-engineer/`; `index.jsx`, `src/Resume.jsx`. Design basis: drawing-title identity, spec-table contacts and dimension rules.
- **Brutalist 0.2.5**: `packages/themes/jsonresume-theme-brutalist/`; `index.jsx`, `src/Resume.jsx`. Design basis: heavy black rules, chapter numbers and offset block shadows.
- **Art Deco 0.2.5**: `packages/themes/jsonresume-theme-art-deco/`; `index.jsx`, `src/Resume.jsx`. Design basis: symmetric jewel-tone identity, gold double rules and geometric ornament.
