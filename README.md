# go-wasm

Runs `gopls`, `go`, `compile`, `link`, `asm` and the programs they build in browser WebAssembly. No native backend.

The repo ships no upstream code. It holds a codemod, overlay files, patches, scripts and a workflow. `scripts/setup.ts` downloads the pinned Go source, clones the pinned `golang/tools`, and runs the codemod and overlay over it. `scripts/build.ts` edits the Go source and builds `dist/`.

## Commands

```
bun scripts/setup.ts            # pinned Go source + native bootstrap, golang/tools clone + codemod + overlay, modules, gopatch (ROOT=~/go-wasm-build)
bun scripts/build.ts            # edits the Go source, builds dist/
bun scripts/build-tinygo.ts     # link built with TinyGo, into dist-tinygo/
bun test/browser.ts ./dist      # Chromium acceptance, all scopes
bun test/browser.ts ./dist --scope=build --serve   # serve one scope; open the URL in another browser
bun scripts/measure.ts ./dist   # raw/gzip/brotli sizes
```

Scopes: `step1` (asset hashes, tool versions), `bridge` (Go scheduler + host calls), `runtime` (`go env`, `go list`), `editor` (LSP, including a staticcheck diagnostic), `build` (compile, link, run, error paths, on-demand std packages), `capabilities` (what `wasip1` and `js/wasm` programs can and cannot do). `bench` is a 40-package build that records per-call time, bytes and memory; it is not part of the default run.

Pins are in `source-lock.json`: Go, `golang/tools`, and the TinyGo CI artifact.

## Architecture

- Workers: broker, `gopls` (long-lived), `go` (serial), transient `compile`/`link`/`asm`/program workers.
- Tools are `wasip1/wasm`. Programs may target `wasip1/wasm` or `js/wasm`.
- Go blocks on host calls through real WASI `poll_oneoff`. Two waiting adapters, same binaries: JSPI (`WebAssembly.Suspending`) and a `SharedArrayBuffer` mailbox with worker-only `Atomics.wait`.
- LSP messages cross the worker boundary as whole JSON strings.
- Command results carry changed files. The broker owns saved workspace files and serializes writable cache access.
- The build cache persists in OPFS, keyed by the `go.wasm` hash. The std seed covers common packages; others compile on demand.

## Caveats

- `scripts/trim -tools` and `scripts/overlay-tools/`: gopls and the shared packages target wasip1 only. The codemod deletes the debug server, assembly view, govulncheck, telemetry prompt and web UI by file and declaration name, and the overlay supplies small stubs in their place, plus `internal/browserhost` (`go` runs through it instead of `os/exec`), the whole-message LSP transport and the browser `gopls/main.go`. Staticcheck keeps every analyzer except `SA1008`, which imports `net/http`: the codemod drops that entry and derives the analyzer list from the config table. Every rule is anchored by name, so a `golang/tools` bump either applies or stops with the rule to update. No plain patch is needed.
- `scripts/trim`: a `go/ast` codemod, over the Go source and, with `-tools`, over `golang/tools`. Rules are anchored by name, not line, so a Go bump either applies or stops with the rule to update. It keeps only the `wasm` backend in compile, link and asm, drops `go` commands that cannot run, swaps `runtime/pprof` for a stub, and stubs version-control access, host-object loaders and the ELF/Mach-O build-ID readers.
- `scripts/gopatch/browser.patch`: three insertions at function starts, applied with `gopatch`. gopatch silently does nothing when a pattern misses, so `build.ts` checks each target gained its browser call.
- `scripts/overlay/`: new files only, copied into the Go tree.
- `go.wasm` builds with `-tags cmd_go_bootstrap`, which stubs `net/http`, vcs and auth.
- `-buildvcs=false` on every tool build, so output does not depend on the checkout.
- `patches/tinygo-wasip1.patch` and `scripts/build-tinygo.ts`: `link.wasm` built with TinyGo 0.43-dev from its own CI artifact (expires 2026-12-31; bump `source-lock.json` after that), 3.3 MB against 10.1 MB. TinyGo's `internal/abi` is replaced with the pinned Go's, and `runtime.MemProfileRate` is added. `go.wasm` is not built with TinyGo: its `reflect` lacks `Type.NumOut` and `MethodByName`, so `go list -f '{{context.ReleaseTags}}'`, which gopls runs at startup, panics. `cmd/compile` is not built with TinyGo either: it needs more than 3 GB and ran past 12 minutes without finishing.

## Requirements

- Serve with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, same-origin assets.
- JSPI, or cross-origin-isolated `SharedArrayBuffer`. Otherwise tools refuse to start.

## Not available

- Cannot work in the browser: the gopls web UI and debug server, govulncheck, telemetry upload, `go run`/`test`/`fmt`/`generate`/`doc`/`tool`, `go get`, `os/exec`, outbound sockets.
- Rejected explicitly: targets other than `wasip1/wasm` and `js/wasm`, `CGO_ENABLED=1`, and `go` verbs other than `env list version build mod work`.
- Dependencies must be in the mounted module cache or vendor tree.

## Not verified

- Safari. The mailbox path is exercised in Chromium only.
- A Go version bump.
