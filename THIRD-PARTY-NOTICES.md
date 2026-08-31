# Third-party notices

Iwa itself is MIT licensed (see `LICENSE`). This file records third-party code
that is **vendored into this repository** — that is, checked in rather than
installed — so its terms travel with the source.

Dependencies resolved from a package registry at install time are not listed
here; their licences ship inside `node_modules` and are governed by each
package's own terms.

## Vendored code

### `scripts/demo/vendor/starknet-privacy-sdk`

StarkWare's STRK20 privacy SDK (`@starkware-libs/starknet-privacy-sdk`),
pinned at version `0.14.3-rc.5`. Upstream:
<https://github.com/starkware-libs/starknet-privacy>.

It is vendored deliberately rather than installed: the demo tooling imports it
by relative path, and the settlement work depends on the SDK matching the exact
Cairo revision the deployed contracts were built against
(`66e3caae8c0201227a6719696d004e30d90aea65`). Pinning it in-tree is what makes
that correspondence reproducible.

**Licence.** The package's own `package.json` declares `ISC`, while StarkWare's
documentation describes the SDK as Apache-2.0. Both are permissive and
compatible with this project's MIT licence, but the two statements disagree and
no `LICENSE` file ships inside the published package. Anyone redistributing
this vendored copy should confirm the intended terms with upstream rather than
rely on either statement here.

Copyright remains with StarkWare and the SDK's contributors. Nothing in this
repository's MIT licence extends to that code.

## Cryptographic and protocol references

The Cairo contracts under `contracts/starknet/` depend on the `privacy` Cairo
package from the same upstream repository, resolved by Scarb at build time and
pinned by revision in `Scarb.toml`. It is not vendored here.
