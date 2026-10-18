# NewFuture CV adaptation

- Upstream: https://github.com/NewFuture/CV
- Pinned revision: `748b54d843fab4347a82943967ba8eedbeaa4ae6`
- Copyright (c) 2017 New Future.
- License: MIT; the complete upstream license is retained in `LICENSE` beside this notice.
- Adapted file: `apps/web/src/components/templates/newfuture-theme.css` (repository root).
- Native selections: `newfuture` (basic), `newfuture-flex`, `newfuture-block`.
- Inspected source: `_layouts/resume.html`, `_sass/resume.scss`, `_sass/mobile.scss`, `_sass/print/_print.scss`, `_sass/print/basic.scss`, `_sass/print/flex.scss`, `_sass/print/block.scss`, `assets/css/main.scss`, `_config.yml`.

BetterMe translates the Liquid/Jekyll and Sass presentation into scoped CSS for its existing React renderer. It preserves the source's split identity/contact masthead, heavy accent underline, right-aligned marginal chapter labels, strong entry headings and outlined date/tag details. All selectors are scoped to `resume-template-newfuture`.

Adaptations: the existing Fact projection, visible section order, rich text, stable preview anchors, links and photo toggle remain the data/interaction source; no upstream example resume facts are included. Font sizes, accent, line height, spacing and page margins follow BetterMe's existing user settings. Chinese/English labels share a physical marginal column; small-screen previews keep the A4 document proportions rather than rearranging the resume itself. Print uses flow/floats instead of nested grid and does not apply upstream's broad `page-break-inside: avoid` rules to whole articles/lists, allowing long histories to paginate.

The `newfuture` selection adapts `_sass/print/basic.scss` and the original screen side-label layout. `newfuture-flex` adapts `_sass/print/flex.scss`: denser section and entry spacing, unboxed dates, plain metadata and comma-separated tags. `newfuture-block` adapts `_sass/print/block.scss`: no side-label column, centered full-width chapter titles, and the dense entry presentation. All three selected presentations stay consistent between the live paper preview and PDF. Print fragmentation remains normal flow rather than the upstream nested flex rules.

No Jekyll, Ruby, upstream JavaScript, IE shims, SVG icons, screenshots, photos, or font files are bundled. BetterMe uses the already configured system font stack. Browser PDF output is an adaptation, not a claim of pixel identity to the upstream web page or print renderer. The project authors do not imply endorsement by NewFuture.
