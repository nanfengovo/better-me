# billryan resume adaptation

- Upstream: https://github.com/billryan/resume
- Pinned revision: `eadc3955cf006254dc8f2419e971fbe3f5bab413` (default/master branch).
- Discovered via https://github.com/dyweb/awesome-resume-for-chinese at `fefc06e7dd667ff78bf7c5cccad715efddaef15f`.
- License: MIT; the complete upstream `LICENSE` is retained beside this notice. The upstream license file has no additional named copyright line; this notice does not replace that original text.
- Adapted file: `apps/web/src/components/templates/billryan-theme.css` (repository root).
- Inspected sources: `resume.cls`, `README.md`, `zh_CN-Adobefonts_internal.sty`, `zh_CN-Adobefonts_external.sty` and `LICENSE`.

BetterMe adapts the LaTeX class's centered name/contact masthead, small-cap serif chapter titles with full-width rules, dated entry headings and compact bullet rhythm into scoped CSS for its existing React renderer. It is an HTML/CSS adaptation and does not embed or execute XeLaTeX.

The existing Fact projection, rich text, section order, visibility, stable preview anchors and links remain the data source. The existing photo toggle is supported. Accent color, type sizes, line height, spacing and page margin follow BetterMe controls rather than the original fixed geometry. Date/title rows wrap for long content; long histories may paginate instead of being forced into one page. Chinese uses existing system font fallbacks.

The upstream README expressly states: "Copyrighted fonts are not subjected to this License." No upstream fonts (including Adobe CJK, TeX Gyre, Fontin or FontAwesome), icons, photographs, example resume facts, bibliography, scripts or build files are redistributed. The upstream `zh_CN` font branch was not fetched. The awesome index supplies discovery, not a blanket license for its linked projects. No author endorsement or exact output parity is implied.
