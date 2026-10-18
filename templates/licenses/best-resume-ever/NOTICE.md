# best-resume-ever adaptation notice

Upstream: <https://github.com/salomonelli/best-resume-ever>

Pinned revision: `29e753cd842585b4a2e9dbbb5e1ef3a0f5e66767`.

License: MIT. Copyright (c) 2017 Sara Steiert. The unmodified upstream
`LICENCE.md` text is preserved as `LICENSE` in this directory.

BetterMe adapts the actual Vue template layouts into its own browser renderer
and CSS. The source templates are not loaded or executed at runtime. Each
template uses the current projected resume and the user's selected section
order; source sample people and resume content are not included.

| BetterMe template ID | Upstream sourceRef |
| --- | --- |
| `best-resume-cool` | `src/resumes/cool.vue` |
| `best-resume-cool-rtl` | `src/resumes/cool-rtl.vue` |
| `best-resume-cool-rtl2` | `src/resumes/cool-rtl2.vue` |
| `best-resume-creative` | `src/resumes/creative.vue` |
| `best-resume-green` | `src/resumes/green.vue` |
| `best-resume-left-right` | `src/resumes/left-right.vue` |
| `best-resume-left-right-projects` | `src/resumes/left-right-projects.vue` |
| `best-resume-left-right-rtl` | `src/resumes/left-right-rtl.vue` |
| `best-resume-material-dark` | `src/resumes/material-dark.vue` |
| `best-resume-material-dark-projects` | `src/resumes/material-dark-projects.vue` |
| `best-resume-oblique` | `src/resumes/oblique.vue` |
| `best-resume-oblique-projects` | `src/resumes/oblique-projects.vue` |
| `best-resume-oblique-rtl` | `src/resumes/oblique-rtl.vue` |
| `best-resume-purple` | `src/resumes/purple.vue` |
| `best-resume-side-bar` | `src/resumes/side-bar.vue` |
| `best-resume-side-bar-projects` | `src/resumes/side-bar-projects.vue` |
| `best-resume-side-bar-rtl` | `src/resumes/side-bar-rtl.vue` |

`src/resumes/template.vue` was inspected and excluded: it is an empty authoring
scaffold with `TEMPLATE-NAME`, a TODO and no theme styles. Thus 18 Vue files
provide 17 usable themes, rather than 18 finished resume designs.

The adaptation retains the seven source families and their actual variations:
Cool has a green masthead and dark information rail; Creative a violet identity
rail; Green and Purple share a layout with different palettes; Left Right uses
a framed name and columns; Material Dark uses a dark rail and white cards on
grey; Oblique uses a diagonal masthead; Side Bar uses a spacious identity and
round skill labels. Source Projects variants receive explicit project or
density rules. Source RTL direction is retained only where the original sets
it (Left Right, Oblique and Side Bar); Cool's two rtl files mirror columns and,
for rtl2, text alignment without introducing a new Unicode writing direction.

Adaptation differences are intentional: semantic fixed left/right groupings
become sequential body columns so user ordering is retained; Material Dark
Projects' three fixed columns become a contact rail and a two-column project
area; fixed absolute footers, oversized triangle coordinates and cover photos
are replaced by normal document flow and CSS backgrounds. The shared header
places a Side Bar or Cool portrait after the contacts. Cool's selected green is
darkened for legible white text. Typography, spacing and accent colors remain
user adjustable; Green and Purple are documented as palette variants rather
than distinct layout engines. Browser pagination is not represented as exact
upstream Puppeteer or pixel parity.

No bundled fonts, icon fonts, Material Icons, hobby icons, photos, backgrounds,
source sample personal data, or automatically generated skill scores are
included. Existing user photos may be displayed only through BetterMe's
existing photo setting. Source font-family names are not used as a claim that
the upstream font assets are installed or licensed by the repository MIT text.
