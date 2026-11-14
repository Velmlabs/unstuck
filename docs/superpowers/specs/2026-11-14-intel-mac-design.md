# Intel Macs (darwin-x64) in 0.1.1 — design

Status: draft for owner review · 2026-11-14

## Why

0.1.0 left Intel Macs out: Bun's cross-compiled x64 Mach-O has an invalid code signature, so macOS would refuse to run it. Intel Mac users get "no engine for Intel Macs yet". 0.1.1 gives them the engine through npm and PyPI like every other platform.

## What we found

Bun builds the x64 binary from its own Developer ID–signed `bun` and appends our code, but keeps the old signature: 75 page hashes no longer match and the signature stops short of the file's end (code limit 97,387,984; signature at 97,945,040). For arm64, Bun re-signs ad-hoc itself, which is why that build is valid.

## Decided

- **Re-sign with `rcodesign` (owner).** After Bun compiles darwin-x64, replace its signature with an ad-hoc one: `rcodesign sign <binary>` with no certificate. No Apple Developer account or notarisation is needed. Only darwin-x64 is re-signed; darwin-arm64 keeps Bun's own valid ad-hoc signature, as shipped in 0.1.0.
- **Everything at 0.1.1**: every package, wheel and the launcher's optional dependencies, which pin the platform versions exactly.

## Approaches

- **rcodesign (chosen by the owner):** a maintained, widely used signer; one more tool in the release build.
- Our own ad-hoc signer in JS: no extra tool, but we would own Mach-O signing code that nobody else tests.
- Ship it unsigned (strip the signature): Intel Macs generally run unsigned code, but it's the least standard and can trip Gatekeeper/XProtect and Rosetta.

## How (builder's calls, stated)

- **Getting rcodesign:** the release build downloads the pinned official Linux binary (apple-codesign 0.29.0, x86_64 musl) from its GitHub release once, checks it against a SHA-256 written in the script, and caches it under the git-ignored `release/`. A mismatch stops the build.
- **Platform entry:** `darwin-x64`, Bun target `bun-darwin-x64-baseline` (no AVX2 needed, like the other x64 builds), wheel tag `macosx_13_0_x86_64` (Bun's minimum is macOS 13.0, checked like arm64), `exe: unstuck-engine`.
- **Dry run checks** (no Mac can run here): file type is Mach-O x86_64; our signature check says `valid`, now also requiring that the signature covers all code up to itself and that the requirements and entitlements hashes match; minimum macOS 13.0 matches the wheel tag. (`rcodesign verify` was dropped after a spike: its own output says it "is known to be buggy", and it fails on correct ad-hoc signatures.) The other checks (contents, clean install, takeovers on Linux, registry state) run as in 0.1.0 with five platforms.
- **Flags and entitlements:** rcodesign carries over Bun's hardened runtime and its five `com.apple.security.cs.*` entitlements (JIT, unsigned executable memory, and so on), the same configuration as Bun's official x64 binary; we keep them. Identifier `unstuck-engine`.
- **Launcher, READMEs, package texts:** drop "Intel Macs come in a later version" and the Intel-Mac error; supported list becomes macOS (Apple silicon and Intel), Linux x64/arm64, Windows x64.

## Goals, non-goals, anti-goals

- Goal: `npm install @velmlabs/unstuck`, `npx -y @velmlabs/unstuck-engine --mcp` and `pip install unstuck` work on an Intel Mac running macOS 13+.
- Non-goal: notarisation or a Developer ID signature.
- Anti-goal: publishing a darwin-x64 build whose signature any of our checks call invalid; changing the arm64 binary.

## Left open

- **Real-hardware proof.** Nothing here runs a Mac binary. Before publishing, the owner can run the darwin-x64 engine on an Intel Mac, or on Apple silicon with `arch -x86_64 ./unstuck-engine --version`. Without that, "works" rests on our own signature check.
- Publishing 0.1.1 is a separate go-ahead after the dry run passes.
