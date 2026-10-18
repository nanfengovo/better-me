# RenderCV theme adaptations

- Upstream: https://github.com/rendercv/rendercv
- Source version: RenderCV 2.8
- Source commit: `1d4b87bc427e4cf61c0ef49623c971b0e2224708`
- Upstream license: MIT; reproduced in [LICENSE](LICENSE).
- Copyright: (c) 2023 to present Sina Atalay and individual contributors.

BetterMe adapts all nine built-in RenderCV 2.8 themes: Classic, Engineering
Resumes, Engineering Classic, Sb2nov, ModernCV, Harvard, Ink, Opal and Ember.
Their parameters are implemented
into `apps/web/src/components/templates/rendercv-themes.css`, rendered through
BetterMe's shared React resume component. The source files examined and adapted
are:

- `src/rendercv/schema/models/design/classic_theme.py`
- `src/rendercv/schema/models/design/other_themes/engineeringresumes.yaml`
- `src/rendercv/schema/models/design/other_themes/moderncv.yaml`
- `src/rendercv/schema/models/design/other_themes/engineeringclassic.yaml`
- `src/rendercv/schema/models/design/other_themes/sb2nov.yaml`
- `src/rendercv/schema/models/design/other_themes/harvard.yaml`
- `src/rendercv/schema/models/design/other_themes/ink.yaml`
- `src/rendercv/schema/models/design/other_themes/opal.yaml`
- `src/rendercv/schema/models/design/other_themes/ember.yaml`

These adaptations use the upstream heading treatments, header alignment,
contact presentation, spacing relationships and, for ModernCV, the left date
column. The implementation is new browser CSS, with editable BetterMe typography,
accent, visibility, section order and page margins. Browser pagination uses
normal flow, a floating date rail and entry-heading keep rules. It does not bundle or execute
RenderCV's Python, Jinja or Typst renderer, and is not an exact reproduction of
its PDF output.

No upstream font files, Font Awesome assets, photographs, example resume content,
rendered preview images or commercial website assets are distributed. Source
Sans 3, XCharter, Fontin, Raleway, New Computer Modern, EB Garamond, Lato,
Ubuntu and Gentium Book Plus are upstream font choices, not included fonts. System
font fallbacks can change metrics, glyphs and pagination. The separately licensed
`rendercv-fonts` dependency and `typst_fontawesome` submodule were not imported;
the repository's MIT license must not be assumed to cover those assets.

BetterMe's content schema has a smaller vocabulary than RenderCV's full CV
schema. The browser themes do not invent missing degree, area, location,
publication, footer, computed duration or update-date data. Text formatting and
photos continue to use BetterMe's existing functionality. The YAML export is a
separate interchange path and requires a local RenderCV installation to render.
No ATS certification or PDF/DOCX layout equivalence is claimed.

The nine browser variants retain their actual source differences: left or
centered headers, regular or bold section labels, continued/full/double-sided/no
section rules, date rails, stacked italic entry subtitles, hollow/round/diamond
bullets and shorter second rows. Themes with similar source parameters share
base rules; their differences are explicit selectors, not additional aliases.
Ember uses the system serif stack for its identity over a user-configurable
body. Exact upstream typefaces and independent per-element font/size controls,
Typst justification, icon connections, location columns, degree columns,
computed time spans, top notes and page footers are not reproduced. BetterMe
retains A4, user-selected page margins, visible fact fields and a shared photo
placement rather than silently replacing those settings with theme defaults.
