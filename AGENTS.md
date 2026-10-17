# Repository agent instructions

## Cosmetic asset ownership

This repository owns the production cosmetic catalog, editable Blockbench projects,
textures, animation sources, exports and packaged assets. Keep them in sync with
`pnpm check:cosmetics`; CI must run this before deployment. Preserve the artwork's
PolyForm Noncommercial license and notices.

Cinnabar owns downloading, validation, caching and rendering, with small stable
client regression fixtures. Do not duplicate each catalog item in the client.
Use its external-catalog compatibility test for full renderer validation. Items
using existing client features ship through this API alone. Rendering features
require client support and focused client tests before publication.

Write clear documentation comments for new helper functions.
