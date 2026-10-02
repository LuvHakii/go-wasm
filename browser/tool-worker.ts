import { BrowserHost } from './host';
import type { SavedFile } from './host';

declare global {
	var fs: unknown;
	var Go: new () => {
		argv: string[];
		env: Record<string, string>;
		exit: (code: number) => void;
		importObject: WebAssembly.Imports;
		run: (instance: WebAssembly.Instance) => Promise<void>;
	};
}

async function runJSProgram(module: WebAssembly.Module, runtime: Uint8Array, argv: string[], env: string[]) {
	const url = URL.createObjectURL(new Blob([runtime.slice()], { type: 'text/javascript' }));
	// Runtime bytes are selected by the verified toolchain manifest.
	try { await import(url); } finally { URL.revokeObjectURL(url); }
	if (!('fs' in globalThis) || typeof globalThis.fs !== 'object' || globalThis.fs === null || !('writeSync' in globalThis.fs)) throw new Error('Go JavaScript runtime did not initialize its filesystem');
	let stdout = '', stderr = '', exitCode = 0;
	const decoder = new TextDecoder();
	globalThis.fs.writeSync = (fd: number, bytes: Uint8Array) => {
		if (fd === 1) stdout += decoder.decode(bytes, { stream: true });
		else stderr += decoder.decode(bytes, { stream: true });
		return bytes.length;
	};
	const go = new Go();
	go.argv = argv;
	go.env = Object.fromEntries(env.map(entry => { const split = entry.indexOf('='); return [entry.slice(0, split), entry.slice(split + 1)]; }));
	go.exit = code => { exitCode = code; };
	const instance = await WebAssembly.instantiate(module, go.importObject);
	await go.run(instance);
	const memory = instance.exports.mem;
	return { exitCode, stdout, stderr, changedFiles: [], linearMemoryCapacityBytes: memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0 };
}

let host: BrowserHost | undefined;
self.onmessage = async (event: MessageEvent<unknown>) => {
	try {
		const raw = event.data;
		if (typeof raw !== 'object' || raw === null || !('kind' in raw)) throw new Error('Invalid worker message');
		if (raw.kind !== 'start') { host?.accept(raw); return; }
		if (!('module' in raw) || !(raw.module instanceof WebAssembly.Module) || !('argv' in raw) || !Array.isArray(raw.argv) || !raw.argv.every(value => typeof value === 'string') || !('env' in raw) || !Array.isArray(raw.env) || !raw.env.every(value => typeof value === 'string') || !('files' in raw) || !Array.isArray(raw.files) || !('mode' in raw) || (raw.mode !== 'jspi' && raw.mode !== 'mailbox')) throw new Error('Invalid tool invocation');
		if (WebAssembly.Module.imports(raw.module).some(entry => entry.module === 'gojs')) {
			if (!('goRuntime' in raw) || !(raw.goRuntime instanceof Uint8Array)) throw new Error('Missing matching Go JavaScript runtime');
			const started = performance.now();
			const result = await runJSProgram(raw.module, raw.goRuntime, raw.argv, raw.env);
			self.postMessage({ kind: 'done', ...result, elapsedMs: performance.now() - started });
			return;
		}
		const files: SavedFile[] = [];
		for (const entry of raw.files) {
			if (typeof entry !== 'object' || entry === null || typeof entry.path !== 'string' || !(entry.bytes instanceof Uint8Array) || typeof entry.readonly !== 'boolean') throw new Error('Invalid mounted file');
			files.push({ path: entry.path, bytes: entry.bytes, readonly: entry.readonly });
		}
		const mailbox = 'mailbox' in raw && raw.mailbox instanceof SharedArrayBuffer ? raw.mailbox : undefined;
		const directories = 'directories' in raw && Array.isArray(raw.directories) && raw.directories.every(path => typeof path === 'string') ? raw.directories : [];
		host = new BrowserHost({ argv: raw.argv, env: raw.env, files, directories, mode: raw.mode, mailbox, serializedWrites: 'serializedWrites' in raw && raw.serializedWrites === true, emit: request => self.postMessage(request) });
		const start = performance.now();
		const exitCode = await host.run(raw.module);
		self.postMessage({ kind: 'done', exitCode, stdout: host.stdout, stderr: host.stderr, changedFiles: host.changes(), elapsedMs: performance.now() - start, linearMemoryCapacityBytes: host.linearMemoryCapacityBytes });
	} catch (error) {
		self.postMessage({ kind: 'done', exitCode: 1, stdout: host?.stdout ?? '', stderr: (host?.stderr ?? '') + (error instanceof Error ? error.stack : String(error)), changedFiles: host?.changes() ?? [], elapsedMs: 0, linearMemoryCapacityBytes: host?.linearMemoryCapacityBytes ?? 0 });
	}
};
