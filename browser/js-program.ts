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

export async function runJSProgram(module: WebAssembly.Module, runtime: Uint8Array, argv: string[], env: string[]) {
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
