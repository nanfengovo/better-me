# JSON Resume Stack Overflow — BetterMe adaptation

- Upstream: https://github.com/phoinixi/jsonresume-theme-stackoverflow
- Pinned revision: `868d6db3fc322047c05e872f63a56fd026894f0a`
- Upstream package version at that revision: `3.3.0`
- Copyright: (c) 2019-present Francesco Esposito
- License: MIT. The adjacent `LICENSE` is copied byte for byte from that revision.

BetterMe adapts the visual rules in `styles/global.css` and
`src/components/{Basics,SectionHeader,TimelineItem,KeywordList}.svelte` into the
scoped `resume-template-jsonresume-stackoverflow` CSS in
`apps/web/src/components/templates/jsonresume-themes.css`.

This is a native React adaptation, not the original Svelte renderer or an
identical reproduction. BetterMe's existing projected facts, safe links,
rich-text formatting, visibility, section order, font/size/color controls,
preview anchors, and browser print mechanism supply the content and behavior.
The source's grouped proficiency bars are omitted because BetterMe has no
verified proficiency data. Existing skills render as keyword labels. No skill
ratings, categories, awards, references, or other facts are inferred.

No upstream screenshot, sample identity, Font Awesome icon, bundled font,
external stylesheet, Svelte runtime, HTML formatter, build script, or automatic
dark paper mode is distributed or executed as part of this adaptation. The
paper uses BetterMe's selected system font and remains white. Its selected
accent and page margin override the source's orange and fixed print margin.
