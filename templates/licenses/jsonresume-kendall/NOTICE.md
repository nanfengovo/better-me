# JSON Resume Kendall — BetterMe adaptation

- Upstream: https://github.com/LinuxBozo/jsonresume-theme-kendall
- Pinned revision: `90438746fd64fc8184f439d5731a7d118660ab7a`
- Upstream package version at that revision: `0.2.0`
- Copyright: (c) 2014 M. Adam Kendall
- License: MIT. The adjacent `LICENSE` is copied byte for byte from that revision.

BetterMe adapts the centered masthead, shaded experience heads, education rail,
and dark keyword labels from upstream `resume.template`, `style.css`, and
`print.css` into the scoped `resume-template-jsonresume-kendall` CSS in
`apps/web/src/components/templates/jsonresume-themes.css`.

This is a native React adaptation. **The source's fixed 60/40 columns are
changed to sequential single-column sections** to preserve BetterMe's existing
user-defined section order, accessible reading order, and browser printing.
The original Bootstrap website layout is not reproduced in full. Existing
projected facts, safe links, text formatting, visibility, preview anchors, and
layout controls are preserved; verified skill ratings are not available, so
no skill level is fabricated. Optional photographs follow the user's photo
setting, including print, instead of the source's unconditional print hiding.

No Bootstrap, Font Awesome icons, Open Sans font, Gravatar request, Lodash,
Mustache runtime, source HTML formatter, or sample resume is distributed or
executed by this adaptation. All CSS is scoped to the selected paper template;
the source's page background, fixed columns, negative margins, and external
stylesheets are excluded. BetterMe's selected system font, accent, type sizes,
spacing, and print margin remain active.
