# Rick Osborne JSON Resume native adaptation

Original theme: **Rick Osborne**, <https://rickosborne.org>.

Source: <https://github.com/rickosborne/jsonresume-theme-rickosborne>

Pinned npm package: `jsonresume-theme-rickosborne@2022.09.16-T1450`.

Tarball SHA-1: `33537a210ad6ab334025f1fdf6270d2bd7364e26`.

License: **Creative Commons Attribution-NonCommercial-ShareAlike 4.0
International (CC BY-NC-SA 4.0)**,
<https://creativecommons.org/licenses/by-nc-sa/4.0/>. Noncommercial use only.
Adapted theme material remains under CC BY-NC-SA 4.0 and requires attribution,
an indication of changes and ShareAlike; it is not relicensed under BetterMe's
general source-code license. This restriction applies to this adapted theme,
not to other independently licensed templates by association.

## License provenance

The pinned package declares `CC-BY-NC-SA-4.0` in both `package.json` and README.
Its published archive does not include a separate LICENSE file. The original
package metadata, author name, URL, version and SPDX declaration are preserved
verbatim in `UPSTREAM_PACKAGE.json`.

`LICENSE` contains the standard full CC BY-NC-SA 4.0 legal text downloaded from
<https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt>. It is the
standard license text supplied to accompany the package's explicit license
declaration, **not** an original standalone upstream LICENSE file. No copyright
year has been invented.

## Source references and changes

- `resume.css`: light slab/serif type hierarchy, 60%/30% layout, muted uppercase
  section labels, inline entry headers, blue links, square work bullets,
  circular portrait and pale rounded keyword tags.
- `index.js`: default left/right semantic groups, Roboto Slab Google Fonts
  request and configurable section layout, titles, font and custom CSS.
- `section/basics.js`, `section/contact.js`, `section/work.js`,
  `section/projects.js`, `section/skills.js`: field placement and style roles.
- `fn/firstWord.js`: source word emphasis, reviewed but not copied into the
  current rich-text rendering pipeline.

BetterMe's `rickosborne-theme.css` and `rickosborne-catalog.ts` are **modified
native adaptations**. The paper retains a light serif identity, narrow right
profile/contact rail, gray uppercase chapters, restrained inline entry
hierarchy, square bullets and pale rounded skill tags. Fixed source semantic
groups become a right contact rail and a main column whose chapters retain the
user's chosen order. Education, projects and skills are not moved into hidden
or fixed source groupings. The main column is 64% with a 30% contact rail and a
flexible gap rather than the exact original flex sizing.

The adaptation replaces viewport-scaled font metrics and the global reset
with scoped selectors and BetterMe's user-configurable type, spacing and
margins. It replaces the Roboto Slab network request with installed system
serif families. Long identity and date strings wrap to avoid clipping; the
source's forced no-wrap behavior is not copied. Work headings retain a
position-first hierarchy but display dates after the shared title/organization
heading, rather than inserting them between source fields. Source first-word
italicization is not applied because it would alter the existing rich-text
pipeline. Printing uses the same factual renderer and natural pagination.

The catalogue and details display the separate noncommercial restriction in
Chinese or English. The preview and printed/PDF resume retain a visible footer
crediting Rick Osborne, identifying the modified BetterMe adaptation and
linking to CC BY-NC-SA 4.0 with the noncommercial restriction. This attribution
must remain present when sharing output based on this theme.

No source resume facts, Gravatar or other remote avatar services, network font,
icon bundle, JavaScript renderer, custom-CSS execution, or upstream runtime is
included. User photos remain controlled by the existing photo setting. This
adaptation does not claim browser or print pixel parity with the source.
