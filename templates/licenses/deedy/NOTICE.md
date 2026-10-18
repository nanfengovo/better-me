# Deedy Chinese browser adaptation

Upstream: <https://github.com/dyweb/Deedy-Resume-for-Chinese>

Pinned revision: `3fe0e55a52ad3a96958b1bcd3c8e4674fc72f5ce`.

License: Apache License, Version 2.0. The complete unmodified repository
`LICENSE` is preserved in this directory. Its appendix contains the generic
copyright placeholder, rather than a project-specific copyright year; this
notice does not invent one.

The source `resume.tex` identifies the original template author as **Debarghya
Das (http://debarghyadas.com)** and the original repository as
<https://github.com/deedydas/Deedy-Resume>. Chinese support is maintained in the
dyweb repository, with gaocegege credited through the source and README links.
These attributions are retained. No separate upstream NOTICE file appears in
the audited tree.

Source references:

- `OpenFonts.Chinese/deedy-resume-openfont.cls`: typography, monochrome colors,
  fine rule below the name, descriptor/date hierarchy and tight lists.
- `OpenFonts.Chinese/resume.tex`: 25% and 73% two-column layout and original
  attribution comments.
- `OpenFonts/deedy-resume-openfont.cls`: English light serif name; the Chinese
  class uses a bold serif name instead.
- `README.md`: distinctions between Chinese OpenFonts, English OpenFonts and
  the unmaintained MacFonts edition; separate font license boundary.

**Modified files / adaptation:** BetterMe's `deedy-theme.css` and
`deedy-catalog.ts` are browser adaptations of those design rules, rather than
unmodified LaTeX or compiled output. A centered serif identity and fine rule
remain above a quarter-width profile rail and a normally flowing main column.
The original 25%/73% minipages put education, links and skills into fixed
semantic groups; this adaptation puts profile/contact details in the rail and
retains education, skills and all other chapters in the user's selected body
order. It does not claim that the original semantic column assignments or
one-page size are reproduced. A user photo may be shown through the existing
BetterMe setting, although the original template does not contain a portrait.

Chinese names use the source's bold serif treatment and English names use its
light serif treatment with installed font fallbacks. Fine gray descriptors,
dates and tight bullets retain the source hierarchy. User font size, body font,
line spacing, margins and accent controls remain available. Browser line breaks
and pagination need not match XeTeX.

No original resume facts, hardcoded personal links, code-line skill scores,
research papers, awards, current-date stamp, font binaries, macOS proprietary
fonts, or TeX runtime are included. The source README explicitly states that
fonts follow their respective licenses; top-level Apache-2.0 is not applied to
them here. The tree contains Source Han Sans/Serif and Source Sans/Serif Pro OTF
files without a separate font license text in the audited tree. These font
directories were not downloaded or bundled; ordinary installed system serif
families provide the replacement.
