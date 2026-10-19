SAPPHIFY UI foundation (local preview, 0.1.0)

Ownership
- tokens.css owns shared typography, semantic colors, spacing and radius tokens.
- Studio corporate.css adapts these tokens to device controls.
- Astro site foundation.css and docs.css adapt tokens to Company/Store and Starlight.
- UI components own behavior and layout; pages own content only.

Consumers
studio: file:../packages/ui
operations/sapphify-astro-preview: file:../../rotem-software/packages/ui
These local dependencies require this sibling checkout. Before independent production deployment,
publish a versioned UI package or vendor a reviewed package artifact. Do not publish private CAD.

Changes
Change a semantic token here first. Check Company, Store, Docs and Studio together in light/dark,
keyboard focus and narrow/mobile layouts. Keep interface adapters free of a second brand palette.
The package is a design foundation, not yet a complete cross-framework component library.
