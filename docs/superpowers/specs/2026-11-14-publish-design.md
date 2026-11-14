# Publish 0.1.0 to npm and PyPI — design

Status: draft for owner review · 2026-11-14

## Why

The docs, landing page and dashboard all tell developers to `npm install @velmlabs/unstuck`, `pip install unstuck` and `npx -y @velmlabs/unstuck-engine --mcp`. None of those exist yet. Publishing makes them real, so the docs can go live and people can use Unstuck without building from source.

Success: on a clean machine, each of the three lines works, and a takeover runs from a freshly installed package on Linux x64 (the platform we can run here); the other platforms' packages are built, the right type of executable, and installable.

## Decided (owner, in conversation)

- npm scope `@velmlabs`; every package name carries `unstuck` (the org hosts other projects).
- Per-platform engine packages (approach A): npm installs only the matching one; Python wheels bundle the engine.
- Version `0.1.0` for everything.
- The npm token is the environment variable `NPM_TOKEN` (granular, `@velmlabs` read/write, 2FA bypass); the PyPI token is the environment variable `PYPI_TOKEN` (the sandbox reaches package registries directly, so the secure credential form can't inject one).
- `velmlabs/unstuck` stays **private** for now; package metadata still points at it.
- A dry run (pack, install in a clean folder, real takeover) passes before anything is published.

## What gets published

| Package | From | Contents |
|---|---|---|
| `@velmlabs/unstuck-protocol` | `protocol/` | compiled JS + `.d.ts` (Apache-2.0) |
| `@velmlabs/unstuck-core` | `core/` | compiled JS + `.d.ts` (Apache-2.0) |
| `@velmlabs/unstuck` | `sdk-ts/` | compiled JS + `.d.ts`; depends on `@velmlabs/unstuck-protocol` and (optional) the platform engine packages |
| `@velmlabs/unstuck-engine` | `engine/` | a small Node launcher as `bin` (`unstuck-engine`) that finds and runs the platform binary; optional dependencies on the five platform packages |
| `@velmlabs/unstuck-engine-<os>-<arch>` ×5 | built | `bin/unstuck-engine[.exe]`, with `os`/`cpu` fields so npm installs only the matching one: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64` |
| `unstuck` (PyPI) | `sdk-py/` | five platform wheels, each with the engine in `unstuck/_bin/`: `macosx_11_0_arm64`, `macosx_10_15_x86_64`, `manylinux_2_17_x86_64`, `manylinux_2_17_aarch64`, `win_amd64` |

Not published now: the relay packages (`relay-core`, `relay-node`, `relay-cloudflare`, AGPL) and the viewer (it is embedded in the engine). They can follow when self-hosting is documented.

## Decided design

- **Rename** the workspace packages to the published names (`unstuck` → `@velmlabs/unstuck`, `@unstuck/*` → `@velmlabs/unstuck-*`), including imports, the SDK's engine lookup (`@velmlabs/unstuck-engine-<platform>-<arch>`), tests, examples' aliases, e2e and the cloud repo's vendored copies (re-sync). One rename, everything green after it.
- **Compile** TS packages with `tsc` to `dist/` (ESM, `.d.ts`); `exports`/`main`/`types` point at `dist`; `files` limits the tarball to `dist`, `README.md`, `LICENSE`. `workspace:*` dependencies become `0.1.0` in the tarball (pnpm does this on pack/publish).
- **Engine binaries** are cross-compiled here with Bun (`bun build --compile --target=bun-<os>-<arch>`), one per platform; the viewer is embedded first as today.
- **Launcher** (`@velmlabs/unstuck-engine/bin/unstuck-engine.js`): resolves `@velmlabs/unstuck-engine-${process.platform}-${process.arch}/bin/unstuck-engine[.exe]`, spawns it with the same args and stdio, forwards the exit code and signals; clear error listing supported platforms when none matches.
- **Wheels**: build the pure wheel once per platform with the matching binary copied into `src/unstuck/_bin/`, then retag it with the platform tag (`wheel tags --platform-tag … --remove`). No sdist (it would lack the engine).
- **Metadata**: `repository` `https://github.com/velmlabs/unstuck`, `homepage` `https://unstuck.sh/docs`, `author` `Velm Labs`, licence per package, keywords; a short README per npm package pointing at the docs.
- **One script** `scripts/release.mjs` with `--dry-run` (default) and `--publish`: builds everything into `release/` (git-ignored), packs, checks, and publishes in dependency order (protocol, core, platform engines, engine, sdk; then wheels). Publishing refuses unless the dry run passed in the same invocation and versions are not already on the registries.

## Dry run (must pass before `--publish`)

1. Every tarball and wheel contains only what's listed above (no `src/`, tests, `.env`, maps).
2. In a temp folder outside the workspace, install the packed tarballs (`npm install <tarballs>`): the Quickstart example runs a real takeover with Playwright and the simulated phone; `npx unstuck-engine --version` works through the launcher.
3. `pip install` the Linux x64 wheel into a fresh venv; the Python Playwright example runs a real takeover.
4. The four non-Linux-x64 binaries exist and are the right executable type (Mach-O arm64/x86_64, ELF aarch64, PE32+ x86-64).
5. The MCP config's `npx -y @velmlabs/unstuck-engine --mcp` is exercised as `npx --yes <launcher tarball>` with the platform tarball installed, answering an MCP `tools/list`.

## Anti-goals

- Publishing anything whose dry run didn't pass, or a tarball containing tests, sources maps with local paths, or secrets.
- A token appearing in a log, file in the repo, or chat.
- Burning version 0.1.0 on a broken package (npm and PyPI never allow reusing a version).

## Left to the builder

- tsconfig details for `dist` builds; the launcher's exact error text; README wording per package.
- Whether the e2e/examples keep pnpm aliases or switch to the real names (they switch, since the packages are renamed).

## Changes after the pre-publish review

- Intel Macs (darwin-x64) are left out of 0.1.0 (owner): Bun's cross-compiled build has an invalid code signature and it can't be re-signed here. Four platforms ship; Intel Mac users get a clear message.
- The viewer stays AGPL-3.0-only (owner): engine packages and wheels are `Apache-2.0 AND AGPL-3.0-only`, with both licence texts and a NOTICE offering the viewer's source.
- PyPI under the owner's account as `unstuck` (no scopes on PyPI); an organisation can be added later.
