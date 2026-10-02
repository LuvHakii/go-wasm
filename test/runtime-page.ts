import { benchEdits, benchFiles, benchPackage } from './bench-project';

type Reply = { kind: string; requestId?: number; stdout?: string; stderr?: string; exitCode?: number; error?: string; [key: string]: unknown };

async function run(mode: 'jspi' | 'mailbox') {
	const worker = new Worker('/broker.js', { type: 'module' });
	const replies: Reply[] = [];
	let wake = Promise.withResolvers<void>();
	worker.onmessage = (event: MessageEvent<unknown>) => {
		const raw = event.data;
		if (typeof raw !== 'object' || raw === null || !('kind' in raw) || typeof raw.kind !== 'string') throw new Error('Invalid broker reply');
		replies.push({ ...raw, kind: raw.kind });
		wake.resolve(); wake = Promise.withResolvers<void>();
	};
	const wait = async (kind: string, id?: number): Promise<Reply> => {
		const deadline = performance.now() + 120000;
		for (;;) {
			const error = replies.find(reply => reply.kind === 'error');
			if (error) throw new Error(String(error.error));
			const index = replies.findIndex(reply => reply.kind === kind && (id === undefined || reply.requestId === id));
			if (index >= 0) { const [reply] = replies.splice(index, 1); if (reply) return reply; }
			if (performance.now() >= deadline) throw new Error(`Timeout waiting for ${kind}/${id}: ${JSON.stringify(replies)}`);
			const delay = Promise.withResolvers<void>();
			const timer = setTimeout(delay.resolve, 1000);
			await Promise.race([wake.promise, delay.promise]); clearTimeout(timer);
		}
	};
	try {
		const measureMemory = async (label: string) => {
			if (new URLSearchParams(location.search).get('mem') !== '1') return;
			const measured = await (performance as unknown as { measureUserAgentSpecificMemory(): Promise<{ bytes: number; breakdown: { bytes: number; types: string[]; attribution: { url: string; scope: string }[] }[] }> }).measureUserAgentSpecificMemory();
			replies.push({ kind: 'mem-proof', label, totalMiB: Math.round(measured.bytes / 1048576), parts: measured.breakdown.filter(part => part.bytes > 4e6).map(part => ({ MiB: Math.round(part.bytes / 1048576), types: part.types, where: part.attribution.map(a => `${a.scope} ${a.url}`.trim()).join(', ') })) });
		};
		worker.postMessage({ kind: 'init', mode });
		const loaded = await wait('ready');
		await measureMemory('after init');
		worker.postMessage({ kind: 'files', files: [
			{ path: '/workspace/go.mod', bytes: new TextEncoder().encode('module example.test/browser\n\ngo 1.27.0\n') },
			{ path: '/workspace/main.go', bytes: new TextEncoder().encode('package main\nimport ("fmt"; _ "embed"; "strings"; "example.test/browser/leaf")\n//go:embed data.txt\nvar data string\ntype named interface { Name() string }\ntype label string\nfunc (v label) Name() string { return string(v) }\nfunc main() { var n named = label("wasm"); c := make(chan int); go func() { c <- leaf.Twice(21) }(); fmt.Println(<-c, n.Name(), strings.TrimSpace(data)) }\n') },
			{ path: '/workspace/excluded_linux.go', bytes: new TextEncoder().encode('package wrong\n') },
			{ path: '/workspace/sc/main.go', bytes: new TextEncoder().encode('package main\nfunc main() {\n\tc := make(chan int)\n\tselect {\n\tcase x := <-c:\n\t\t_ = x\n\t}\n}\n') },
			{ path: '/workspace/leaf/leaf.go', bytes: new TextEncoder().encode('package leaf\nfunc Twice[T ~int](n T) T { return n+n }\n') },
			{ path: '/workspace/data.txt', bytes: new TextEncoder().encode('embedded\n') },
		] });
		await wait('saved');
		let requestId = 0;
		const command = async (argv: string[], env: string[] = []) => {
			const id = ++requestId;
			worker.postMessage({ kind: 'command', requestId: id, argv: ['go', ...argv], env: new URLSearchParams(location.search).get('trace') ? [`BROWSER_WASI_TRACE=${new URLSearchParams(location.search).get('trace')}`, ...env] : env, cwd: '/workspace' });
			const reply = await wait('result', id);
			if (reply.exitCode !== 0) throw new Error(`go ${argv.join(' ')}: ${reply.stderr}`);
			return reply;
		};
		const env = await command(['env', 'GOROOT', 'GOOS', 'GOARCH']);
		if (env.stdout !== '/goroot\nwasip1\nwasm\n') throw new Error(`Unexpected Go environment: ${env.stdout}`);
		const listed = await command(['list', '-e', '-deps', '-compiled', '-json=ImportPath,GoFiles,Error', './...']);
		if (typeof listed.stdout !== 'string' || !listed.stdout.includes('example.test/browser') || listed.stdout.includes('excluded_linux.go') || listed.stdout.includes('"Error"')) throw new Error(`Incorrect package metadata: ${listed.stdout}`);
		if (new URLSearchParams(location.search).get('scope') === 'editor') {
			worker.postMessage({ kind: 'gopls' }); await wait('gopls-ready');
			const rpc = (message: object) => worker.postMessage({ kind: 'lsp', json: JSON.stringify({ jsonrpc: '2.0', ...message }) });
			const response = async (id: number) => {
				for (;;) {
					const event = await wait('lsp');
					if (typeof event.json !== 'string') throw new Error('LSP output is not a whole JSON string');
					const message = JSON.parse(event.json);
					if (message.id === id) { if (message.error) throw new Error(JSON.stringify(message.error)); return message.result; }
				}
			};
			rpc({ id: 100, method: 'initialize', params: { processId: null, rootUri: 'file:///workspace', capabilities: {} } });
			const initialized = await response(100);
			if (!initialized.capabilities.hoverProvider || !initialized.capabilities.completionProvider) throw new Error('Core editor capabilities missing');
			rpc({ method: 'initialized', params: {} });
			rpc({ method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///workspace/main.go', languageId: 'go', version: 1, text: 'package main\nvar answer int = \"bad\"\nfunc main() {}\n' } } });
			let diagnosed = false;
			while (!diagnosed) {
				const event = await wait('lsp');
				if (typeof event.json !== 'string') throw new Error('Invalid LSP output');
				const message = JSON.parse(event.json);
				if (message.method === 'textDocument/publishDiagnostics' && message.params.uri === 'file:///workspace/main.go' && message.params.diagnostics.some((diagnostic: { message: string }) => diagnostic.message.includes('cannot use'))) diagnosed = true;
			}
			rpc({ method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///workspace/main.go', version: 2 }, contentChanges: [{ text: 'package main\nvar answer int = 42\nfunc main() {}\n' }] } });
			let cleared = false;
			while (!cleared) {
				const event = await wait('lsp');
				if (typeof event.json !== 'string') throw new Error('Invalid LSP output');
				const message = JSON.parse(event.json);
				if (message.method === 'textDocument/publishDiagnostics' && message.params.uri === 'file:///workspace/main.go' && message.params.version === 2 && message.params.diagnostics.length === 0) cleared = true;
			}
			rpc({ id: 101, method: 'textDocument/hover', params: { textDocument: { uri: 'file:///workspace/main.go' }, position: { line: 1, character: 5 } } });
			const hover = await response(101);
			if (!JSON.stringify(hover).includes('answer int')) throw new Error('Hover did not reflect unsaved text');
			rpc({ method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///workspace/main.go', version: 3 }, contentChanges: [{ text: 'package main\nimport "example.test/browser/leaf"\nvar answer = leaf.Tw\nfunc main() {}\n' }] } });
			rpc({ id: 103, method: 'textDocument/completion', params: { textDocument: { uri: 'file:///workspace/main.go' }, position: { line: 2, character: 20 } } });
			const completion = await response(103);
			if (!JSON.stringify(completion).includes('Twice')) throw new Error('Cross-package completion missing');
			rpc({ method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///workspace/main.go', version: 4 }, contentChanges: [{ text: 'package main\nimport "example.test/browser/leaf"\nvar answer = leaf.Twice(21)\nfunc main() {}\n' }] } });
			rpc({ id: 104, method: 'textDocument/definition', params: { textDocument: { uri: 'file:///workspace/main.go' }, position: { line: 2, character: 19 } } });
			if (!JSON.stringify(await response(104)).includes('/leaf/leaf.go')) throw new Error('Definition did not reach leaf package');
			rpc({ id: 105, method: 'textDocument/rename', params: { textDocument: { uri: 'file:///workspace/main.go' }, position: { line: 2, character: 19 }, newName: 'Double' } });
			const renamed = JSON.stringify(await response(105));
			if (!renamed.includes('/leaf/leaf.go') || !renamed.includes('Double')) throw new Error('Cross-package rename incomplete');
			rpc({ id: 106, method: 'textDocument/formatting', params: { textDocument: { uri: 'file:///workspace/main.go' }, options: { tabSize: 4, insertSpaces: false } } });
			if (!JSON.stringify(await response(106)).includes('newText')) throw new Error('Formatting did not return edits');
			replies.push({ kind: 'editor-proof', diagnostics: 'invalid then cleared', hover: 'answer int', completion: 'Twice', definition: '/leaf/leaf.go', rename: 'Double', formatting: 'edits' });
			// S1000 is a default-on staticcheck analyzer: a single-case select should be a plain receive.
			rpc({ method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///workspace/sc/main.go', languageId: 'go', version: 1, text: 'package main\nfunc main() {\n\tc := make(chan int)\n\tselect {\n\tcase x := <-c:\n\t\t_ = x\n\t}\n}\n' } } });
			let staticcheck: string | undefined;
			while (!staticcheck) {
				const event = await wait('lsp');
				if (typeof event.json !== 'string') throw new Error('Invalid LSP output');
				const message = JSON.parse(event.json);
				if (message.method === 'textDocument/publishDiagnostics' && message.params.uri === 'file:///workspace/sc/main.go') {
					const found = message.params.diagnostics.find((d: { source?: string; code?: string }) => d.source === 'S1000' || d.code === 'S1000');
					if (found) staticcheck = found.message;
				}
			}
			replies.push({ kind: 'staticcheck-proof', S1000: staticcheck });
			rpc({ id: 102, method: 'shutdown', params: null }); await response(102);
			rpc({ method: 'exit', params: null });
		}
		if (new URLSearchParams(location.search).get('scope') === 'build') {
			const built = await command(['build', '-ldflags=-s -w', '-o', '/workspace/out.wasm', './']);
			worker.postMessage({ kind: 'run', requestId: ++requestId, path: '/workspace/out.wasm' });
			const executed = await wait('result', requestId);
			if (executed.exitCode !== 0 || executed.stdout !== '42 wasm embedded\n') throw new Error(`Incorrect compiled output: ${JSON.stringify(executed)}`);
			const warmed = await command(['build', '-ldflags=-s -w', '-o', '/workspace/out.wasm', './']);
			const jsBuild = await command(['build', '-ldflags=-s -w', '-o', '/workspace/js.wasm', './'], ['GOOS=js']);
			worker.postMessage({ kind: 'run', requestId: ++requestId, path: '/workspace/js.wasm' });
			const jsResult = await wait('result', requestId);
			if (jsResult.exitCode !== 0 || jsResult.stdout !== '42 wasm embedded\n') throw new Error(`Incorrect JS-target output: ${JSON.stringify(jsResult)}`);
			replies.push({ kind: 'build-proof', target: 'js', elapsedMs: jsBuild.elapsedMs, output: jsResult.stdout });
			replies.push({ kind: 'build-proof', coldMs: built.elapsedMs, warmMs: warmed.elapsedMs, output: executed.stdout });

			const encode = (text: string) => new TextEncoder().encode(text);
			worker.postMessage({ kind: 'files', files: [
				{ path: '/workspace/typeerr/main.go', bytes: encode('package main\nvar x int = "s"\nfunc main() {}\n') },
				{ path: '/workspace/nodep/main.go', bytes: encode('package main\nimport _ "example.test/missing"\nfunc main() {}\n') },
			] });
			await wait('saved');
			const rejected = async (argv: string[], env: string[], expected: string) => {
				const id = ++requestId;
				worker.postMessage({ kind: 'command', requestId: id, argv: ['go', ...argv], env, cwd: '/workspace' });
				const reply = await wait('result', id);
				if (reply.exitCode === 0 || !String(reply.stderr).includes(expected)) throw new Error(`Expected failure containing "${expected}": ${JSON.stringify(reply)}`);
			};
			await rejected(['build', '-o', '/workspace/x.wasm', './typeerr'], [], 'cannot use');
			await rejected(['build', '-o', '/workspace/x.wasm', './nodep'], [], 'example.test/missing');
			await rejected(['build', './'], ['GOARCH=amd64'], 'unsupported target: wasip1/amd64');
			await rejected(['build', './'], ['GOOS=linux'], 'unsupported target: linux/wasm');
			await rejected(['build', './'], ['CGO_ENABLED=1'], 'unsupported: cgo');
			await rejected(['get', 'example.test/x'], [], 'unsupported browser go command');

			// Same byte length, different behavior: the cache must key on content.
			worker.postMessage({ kind: 'files', files: [{ path: '/workspace/leaf/leaf.go', bytes: encode('package leaf\nfunc Twice[T ~int](n T) T { return n*n }\n') }] });
			await wait('saved');
			await command(['build', '-ldflags=-s -w', '-o', '/workspace/out.wasm', './']);
			worker.postMessage({ kind: 'run', requestId: ++requestId, path: '/workspace/out.wasm' });
			const edited = await wait('result', requestId);
			if (edited.stdout !== '441 wasm embedded\n') throw new Error(`Stale build after same-length edit: ${JSON.stringify(edited)}`);
			replies.push({ kind: 'errors-proof', rejected: 6, sameLengthEditRebuilt: true });

			// hash/crc32 and text/tabwriter are outside the seeded std closure: compile on demand.
			worker.postMessage({ kind: 'files', files: [{ path: '/workspace/unseeded/main.go', bytes: encode('package main\nimport ("fmt"; "hash/crc32"; "os"; "text/tabwriter")\nfunc main() { w := tabwriter.NewWriter(os.Stdout, 0, 4, 1, \' \', 0); fmt.Fprintf(w, "%08x\\t|\\n", crc32.ChecksumIEEE([]byte("go"))); w.Flush() }\n') }] });
			await wait('saved');
			const ondemand = await command(['build', '-o', '/workspace/unseeded.wasm', './unseeded']);
			worker.postMessage({ kind: 'run', requestId: ++requestId, path: '/workspace/unseeded.wasm' });
			const unseeded = await wait('result', requestId);
			if (unseeded.exitCode !== 0 || unseeded.stdout !== 'b6689356 |\n') throw new Error(`On-demand std build wrong: ${JSON.stringify(unseeded)}`);
			replies.push({ kind: 'ondemand-proof', elapsedMs: ondemand.elapsedMs });

			// No .s file was built, so asm.wasm must not have been fetched.
			worker.postMessage({ kind: 'stats' });
			const stats = await wait('stats');
			if (!Array.isArray(stats.modules) || stats.modules.includes('asm') || !stats.modules.includes('compile')) throw new Error(`asm.wasm loaded unnecessarily: ${JSON.stringify(stats)}`);
			replies.push({ kind: 'lazy-proof', modules: stats.modules });
		}
		if (new URLSearchParams(location.search).get('scope') === 'capabilities') {
			const encode = (text: string) => new TextEncoder().encode(text);
			worker.postMessage({ kind: 'files', files: [
				{ path: '/workspace/capwasi/main.go', bytes: encode(`package main
import ("fmt"; "net"; "os"; "os/exec"; "os/signal"; "os/user"; "runtime"; "syscall")
func report(name string, err error) { if err != nil { fmt.Printf("%s: FAIL %v\\n", name, err) } else { fmt.Printf("%s: ok\\n", name) } }
func main() {
	_, err := net.Listen("tcp", "127.0.0.1:0"); report("net.Listen", err)
	_, err = net.Dial("tcp", "127.0.0.1:80"); report("net.Dial", err)
	if l, err := net.Listen("tcp", "127.0.0.1:0"); err == nil {
		go func() { if c, err := l.Accept(); err == nil { c.Write([]byte("hi")); c.Close() } }()
		if c, err := net.Dial("tcp", l.Addr().String()); err == nil {
			b := make([]byte, 2); n, _ := c.Read(b); fmt.Println("loopback read:", string(b[:n]))
		} else { report("net.loopback", err) }
	}
	err = exec.Command("true").Run(); report("os/exec", err)
	_, _, err = os.Pipe(); report("os.Pipe", err)
	f, _ := os.Create("/tmp/x"); f.Close()
	report("os.Chmod", os.Chmod("/tmp/x", 0o600))
	report("os.Chown", os.Chown("/tmp/x", 0, 0))
	report("os.Symlink", os.Symlink("/tmp/x", "/tmp/y"))
	_, err = os.Executable(); report("os.Executable", err)
	_, err = user.Current(); report("os/user", err)
	c := make(chan os.Signal, 1); signal.Notify(c, syscall.SIGINT); report("signal.Notify", nil)
	fmt.Println("GOMAXPROCS", runtime.GOMAXPROCS(0), "NumCPU", runtime.NumCPU())
}
`) },
				{ path: '/workspace/capjs/main.go', bytes: encode(`package main
import ("fmt"; "syscall/js")
func main() {
	origin := js.Global().Get("location").Get("origin").String()
	done := make(chan string)
	then := js.FuncOf(func(this js.Value, a []js.Value) any { done <- a[0].String(); return nil })
	toText := js.FuncOf(func(this js.Value, a []js.Value) any { return a[0].Call("text") })
	js.Global().Call("fetch", origin+"/probe.txt").Call("then", toText).Call("then", then)
	fmt.Println("fetch:", <-done)
}
`) },
			] });
			await wait('saved');
			await command(['build', '-o', '/workspace/capwasi.wasm', './capwasi']);
			worker.postMessage({ kind: 'run', requestId: ++requestId, path: '/workspace/capwasi.wasm' });
			const wasi = await wait('result', requestId);
			await command(['build', '-o', '/workspace/capjs.wasm', './capjs'], ['GOOS=js']);
			worker.postMessage({ kind: 'run', requestId: ++requestId, path: '/workspace/capjs.wasm' });
			const js = await wait('result', requestId);
			const lines = String(wasi.stdout).split('\n').filter(Boolean);
			const probes: Record<string, string> = {};
			for (const line of lines) { const i = line.indexOf(': '); if (i > 0) probes[line.slice(0, i)] = line.slice(i + 2); else probes[line.split(' ')[0] ?? line] = line; }
			for (const name of ['net.Dial', 'os/exec', 'os.Pipe', 'os.Chown', 'os.Executable']) {
				if (!String(probes[name]).startsWith('FAIL')) throw new Error(`${name} unexpectedly works on wasip1: ${probes[name]}`);
			}
			if (probes['loopback read'] !== 'hi') throw new Error(`In-process loopback socket failed: ${JSON.stringify(probes)}`);
			if (probes['GOMAXPROCS'] !== 'GOMAXPROCS 1 NumCPU 1') throw new Error(`Expected a single CPU: ${probes['GOMAXPROCS']}`);
			if (String(js.stdout).trim() !== 'fetch: probe-ok') throw new Error(`js/wasm fetch failed: ${JSON.stringify(js)}`);
			replies.push({ kind: 'capabilities-proof', wasip1: probes, wasip1ExitCode: wasi.exitCode, wasip1Stderr: wasi.stderr, jsExitCode: js.exitCode, js: String(js.stdout).trim(), jsStderr: js.stderr });
		}
		if (new URLSearchParams(location.search).get('scope') === 'bench') {
			const files = Object.entries(benchFiles()).map(([path, text]) => ({ path: `/workspace/${path}`, bytes: new TextEncoder().encode(text) }));
			worker.postMessage({ kind: 'files', files }); await wait('saved');
			const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! : 0;
			const measure = async (label: string, argv: string[]) => {
				worker.postMessage({ kind: 'stats', reset: true }); await wait('stats');
				const parallel = new URLSearchParams(location.search).get('p');
				const reply = await command(argv, parallel ? [`GOFLAGS=-p=${parallel} -trimpath`] : []);
				worker.postMessage({ kind: 'stats', reset: true });
				const stats = await wait('stats');
				const spawned = stats.spawns as { tool: string; sentBytes: number; wallMs: number; runMs: number; changedBytes: number; memory: number }[];
				const by: Record<string, unknown> = {};
				for (const tool of ['go', 'compile', 'link', 'asm']) {
					const items = spawned.filter(s => s.tool === tool);
					if (!items.length) continue;
					by[tool] = { calls: items.length, firstWallMs: Math.round(items[0]!.wallMs), wallMs: Math.round(items.reduce((n, s) => n + s.wallMs, 0)), runMs: Math.round(items.reduce((n, s) => n + s.runMs, 0)), medianWallMs: Math.round(median(items.map(s => s.wallMs))), medianRunMs: Math.round(median(items.map(s => s.runMs))), sentMB: +(items.reduce((n, s) => n + s.sentBytes, 0) / 1e6).toFixed(1), returnedMB: +(items.reduce((n, s) => n + s.changedBytes, 0) / 1e6).toFixed(1), maxMemoryMB: +(Math.max(...items.map(s => s.memory)) / 1e6).toFixed(1) };
				}
				replies.push({ kind: 'bench-proof', label, totalMs: Math.round(reply.elapsedMs as number), tools: by });
				await measureMemory(`after ${label}`);
			};
			const build = ['build', '-o', '/workspace/bench.wasm', benchPackage];
			await measure('cold', build);
			worker.postMessage({ kind: 'run', requestId: ++requestId, path: '/workspace/bench.wasm' });
			const ran = await wait('result', requestId);
			if (ran.exitCode !== 0 || !String(ran.stdout).startsWith('bench ')) throw new Error(`bench program failed: ${JSON.stringify(ran)}`);
			await measure('no-op rebuild', build);
			for (const edit of benchEdits) {
				worker.postMessage({ kind: 'files', files: [{ path: `/workspace/${edit.path}`, bytes: new TextEncoder().encode(edit.text) }] }); await wait('saved');
				await measure(edit.label, build);
			}
		}
		worker.postMessage({ kind: 'close' }); await wait('closed');
		return { mode, loaded, environment: env.stdout, packagesCorrect: true, proofs: replies.filter(reply => reply.kind.endsWith('-proof')) };
	} finally { worker.terminate(); }
}

const results = [];
try {
	for (const mode of new URLSearchParams(location.search).get('scope') === 'bench' ? ['jspi'] as const : ['jspi', 'mailbox'] as const) results.push(await run(mode));
	Object.assign(window, { __result: { ok: true, scope: 'runtime', results }, __done: true });
} catch (error) { Object.assign(window, { __result: { ok: false, results, error: error instanceof Error ? error.stack : String(error) }, __done: true }); }
document.body.textContent = JSON.stringify('__result' in window ? window.__result : null, null, 2);
export {};
