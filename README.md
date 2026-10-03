# go-wasm

Runs `gopls`, `go`, `compile`, `link`, `asm` and the programs they build in browser WebAssembly. No native backend.

The repo ships no upstream code. It holds a codemod, overlay files, patches, scripts and a workflow. `scripts/setup.ts` downloads the pinned Go source, clones the pinned `golang/tools`, and runs the codemod and overlay over it. `scripts/build.ts` edits the Go source and builds `dist/`.

## Commands

```
bun scripts/setup.ts            # pinned Go source + native bootstrap, golang/tools clone + codemod + overlay, modules (ROOT=~/go-wasm-build)
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
- `scripts/rules/honnef.yml` and `scripts/setup.ts`: staticcheck builds its analyzer docs at init with four `strings.NewReplacer` calls per analyzer, which TinyGo's compile-time interpreter takes minutes to evaluate. `setup.ts` copies the module to `ROOT/honnef-tools`, rewrites `toMarkdown` and `stripMarkdown` with `strings.ReplaceAll`, and points `gopls/go.mod` at it with a relative `replace`. The output differs only when a `\` comes straight before a `\'`. Both `gopls` builds use it, and it also removes about 600 `NewReplacer` calls from the Go build's start-up.
- `scripts/rules/tinygo.yml` (`ssagen`): `ssa.Cache` is 211 KB, which TinyGo refuses as a slice element, so the cache slice holds pointers.
- `browser/host.ts`: an LSP `shutdown` request is answered by the host (`null` result) and ends the run as a normal exit; `gopls` never sees it. `gopls` built with TinyGo never finishes `Session.Shutdown` (a goroutine keeps the first snapshot referenced; the cause is not found), and nothing is flushed at shutdown anyway: `gopls` writes its cache files as results complete, and the changed files still reach the broker when the run ends. An analysis still in flight at that moment loses its cache entry.
- `scripts/rules/browser.yml`: three insertions at function starts (`runOut`, `toolID`, `ToolPath`), applied with ast-grep (`scripts/rules.ts`, pinned in `package.json`). Every rule carries `metadata.expect`, and the runner stops when a rule matches a different number of times, so a Go bump either applies or names the rule to update. Each insertion leaves a blank line.
- `scripts/overlay/`: new files only, copied into the Go tree.
- `go.wasm` builds with `-tags cmd_go_bootstrap`, which stubs `net/http`, vcs and auth.
- `-buildvcs=false` on every tool build, so output does not depend on the checkout.
- `scripts/build-tinygo.ts`, `patches/tinygo-wasip1.patch`, `scripts/overlay-tinygo/`, `scripts/rules/tinygo.yml`: `link.wasm`, `go.wasm`, `asm.wasm` and `gopls.wasm` built with TinyGo 0.43-dev from its own CI artifact (expires 2026-12-31; bump `source-lock.json` after that), 3.3, 5.6, 1.4 and 16.3 MB against 10.1, 16.5, 8.8 and 39.6 MB. `asm` builds from a copy of the Go tree that keeps the real `cmd/internal/obj` packages. TinyGo's `internal/abi` is replaced with the pinned Go's, and the build sets `runtime.buildVersion` to the pinned Go version. The TinyGo patch adds `runtime.MemProfileRate`, `os.ProcessState.UserTime/SystemTime` and `reflect.Value.FieldByIndexErr`, switches `os.RemoveAll` to the generic implementation, makes `reflect.Value.MethodByName` return an invalid value, and sets `runtime.Compiler` to `gc`, which `cmd/go` reads. TinyGo's func types carry no signature, so `reflect.Type.NumIn/NumOut/In/Out` and `Value.Call` cannot work. In the TinyGo copy of the Go tree only, `text/template` takes function signatures from a table (`overlay-tinygo/src/text/template/tinygo_call.go`) and `go list` wraps `context` and `module` in it. Consequences: `go list -f` works with its own functions and the builtins, `call` and methods on the data do not. `compile` is not built with TinyGo yet.

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
