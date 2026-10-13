# anti-slop (vendored)

Source: https://github.com/dmmulroy/anti-slop
Vendored commit: 95a56e5d24fb3d849673c2d51eb0908b8bd2d33b (upstream `src/`, unchanged)
License: MIT (see LICENSE)

There is no npm package. Upstream tells you to copy `src/` into the repo, so this
folder is that copy. Do not edit these files by hand. To update, copy upstream `src/`
over this folder again and bump the commit above.

`@oxlint/plugins` (root package.json) must be pinned to the exact same version as `oxlint`.
When you bump oxlint, bump `@oxlint/plugins` too.

Rules are registered in `.oxlintrc.json` under `jsPlugins`. This folder is ignored by
oxlint and oxfmt so vendored code is never linted or reformatted.
