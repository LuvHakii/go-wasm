import { WASI, Fd, File, Directory, PreopenDirectory, ConsoleStdout, wasi } from '@bjorn3/browser_wasi_shim';
import { Mailbox } from './mailbox';

declare global {
	namespace WebAssembly {
		const Suspending: new (fn: (...args: number[]) => Promise<number>) => (...args: number[]) => number;
		function promising(fn: Function): (...args: number[]) => Promise<unknown>;
	}
}

export type SavedFile = { path: string; bytes: Uint8Array; readonly: boolean };
export type Command = { argv: string[]; env: string[]; cwd: string };
export type HostEvent = { kind: 'lsp'; json: string } | { kind: 'result'; fd: number; stdout: string; stderr: string; exitCode: number; files: { path: string; data: string | null }[] } | { kind: 'close' };
export type HostRequest = { kind: 'command'; fd: number; command: Command; files: SavedFile[]; directories: string[] } | { kind: 'lsp'; json: string } | { kind: 'cancel'; fd: number };

class Input extends Fd {
	data = new Uint8Array(0);
	position = 0;
	finished = false;
	constructor(readonly cancel: (pending: boolean) => void) { super(); }
	get ready() { return this.position < this.data.length || this.finished; }
	fd_read(size: number) {
		if (!this.ready) return { ret: wasi.ERRNO_AGAIN, data: new Uint8Array(0) };
		const end = Math.min(this.position + size, this.data.length);
		const data = this.data.subarray(this.position, end);
		this.position = end;
		if (end === this.data.length) { this.data = new Uint8Array(0); this.position = 0; }
		return { ret: 0, data };
	}
	append(bytes: Uint8Array) {
		const pending = this.data.subarray(this.position);
		const combined = new Uint8Array(pending.length + bytes.length);
		combined.set(pending); combined.set(bytes, pending.length);
		this.data = combined; this.position = 0;
	}
	fd_fdstat_get() { return { ret: 0, fdstat: new wasi.Fdstat(wasi.FILETYPE_SOCKET_STREAM, wasi.FDFLAGS_NONBLOCK) }; }
	fd_fdstat_set_flags() { return 0; }
	fd_filestat_get() { return { ret: 0, filestat: new wasi.Filestat(0n, wasi.FILETYPE_SOCKET_STREAM, 0n) }; }
	fd_close() {
		const pending = !this.finished;
		this.finished = true;
		this.data = new Uint8Array(0);
		this.cancel(pending);
		return 0;
	}
}

export class BrowserHost {
	readonly wasi: WASI;
	readonly root = new Directory([]);
	readonly inputs = new Map<number, Input>();
	readonly input = new Input(() => {});
	readonly mailbox: Mailbox | undefined;
	stdout = '';
	stderr = '';
	private wake = Promise.withResolvers<void>();
	private instance: WebAssembly.Instance | undefined;
	private baseline = new Map<string, Uint8Array>();
	private closed = false;
	private exiting = false;
	constructor(readonly options: { argv: string[]; env: string[]; files: SavedFile[]; directories?: string[]; mode: 'jspi' | 'mailbox'; mailbox?: SharedArrayBuffer; serializedWrites?: boolean; emit: (event: HostRequest) => void }) {
		if (options.mode === 'mailbox') {
			if (!options.mailbox) throw new Error('Missing mailbox');
			this.mailbox = new Mailbox(options.mailbox);
		}
		for (const path of options.directories ?? []) this.directory(path);
		for (const file of options.files) this.mount(file);
		for (const path of ['/tmp', '/home', '/cache', '/modules', '/workspace']) this.directory(path);
		this.baseline = new Map(this.snapshot().map(file => [file.path, file.bytes.slice()]));
		this.wasi = new WASI(options.argv, options.env, [this.input,
			new ConsoleStdout(bytes => { this.stdout += new TextDecoder().decode(bytes); }),
			new ConsoleStdout(bytes => { this.stderr += new TextDecoder().decode(bytes); }),
			new PreopenDirectory('/', this.root.contents)]);
		this.inputs.set(0, this.input);
		this.wasi.wasiImport.poll_oneoff = options.mode === 'jspi'
			? this.suspending((input: number, output: number, count: number, nevents: number) => this.pollAsync(input, output, count, nevents))
			: (input: number, output: number, count: number, nevents: number) => this.pollSync(input, output, count, nevents);
		if (options.env.some(entry => entry.startsWith('BROWSER_WASI_TRACE='))) {
			const imports = this.wasi.wasiImport as Record<string, (...args: number[]) => number>;
			for (const [name, fn] of Object.entries(imports)) {
				if (name === 'poll_oneoff' || typeof fn !== 'function') continue;
				imports[name] = (...args) => { const code = fn.apply(imports, args); if (typeof code === 'number' && (code !== 0 || options.env.includes('BROWSER_WASI_TRACE=2')) && !/^fd_(read|write|close|seek|fdstat_get)$/.test(name)) this.stderr += `wasi ${name} -> ${code}\n`; return code; };
			}
		}
	}
	private suspending(fn: (...args: number[]) => Promise<number>): (...args: number[]) => number {
		const api = WebAssembly;
		if (!('Suspending' in api) || typeof api.Suspending !== 'function') throw new Error('JSPI unavailable');
		return new api.Suspending(fn);
	}
	private directory(path: string): Directory {
		let dir = this.root;
		for (const part of path.split('/').filter(Boolean)) {
			const next = dir.contents.get(part);
			if (next && !(next instanceof Directory)) throw new Error(`Not a directory: ${path}`);
			if (next instanceof Directory) dir = next;
			else { const child = new Directory([]); dir.contents.set(part, child); dir = child; }
		}
		return dir;
	}
	mount(file: SavedFile) {
		if (!file.path.startsWith('/') || file.path.split('/').includes('..')) throw new Error('Invalid file path');
		const split = file.path.lastIndexOf('/');
		const node = new File([], { readonly: file.readonly });
		node.data = file.bytes;
		this.directory(file.path.slice(0, split)).contents.set(file.path.slice(split + 1), node);
	}
	snapshot(): SavedFile[] {
		const files: SavedFile[] = [];
		const visit = (dir: Directory, prefix: string) => {
			for (const [name, inode] of dir.contents) {
				const path = `${prefix}/${name}`;
				if (inode instanceof Directory) visit(inode, path);
				else if (inode instanceof File && !inode.readonly) files.push({ path, bytes: inode.data, readonly: false });
			}
		};
		visit(this.root, '');
		return files;
	}
	directories(): string[] {
		const paths: string[] = [];
		const visit = (dir: Directory, prefix: string) => {
			for (const [name, inode] of dir.contents) {
				const path = `${prefix}/${name}`;
				if (inode instanceof Directory && path !== '/goroot') { paths.push(path); visit(inode, path); }
			}
		};
		visit(this.root, '');
		return paths;
	}
	changes(): { path: string; data: string | null }[] {
		const changes: { path: string; data: string | null }[] = [];
		const remaining = new Set(this.baseline.keys());
		for (const file of this.snapshot()) {
			remaining.delete(file.path);
			const before = this.baseline.get(file.path);
			if (!before || before.length !== file.bytes.length || before.some((b, i) => b !== file.bytes[i])) {
				let binary = '';
				for (let i = 0; i < file.bytes.length; i += 8192) binary += String.fromCharCode(...file.bytes.subarray(i, i + 8192));
				changes.push({ path: file.path, data: btoa(binary) });
			}
		}
		for (const path of remaining) changes.push({ path, data: null });
		return changes;
	}
	private applyFileChanges(files: unknown[]) {
		for (const entry of files) {
			if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string' || !entry.path.startsWith('/') || entry.path.split('/').includes('..') || !('data' in entry) || (entry.data !== null && typeof entry.data !== 'string')) throw new Error('Invalid file update');
			if (entry.data === null) {
				const split = entry.path.lastIndexOf('/');
				this.directory(entry.path.slice(0, split)).contents.delete(entry.path.slice(split + 1));
			} else if (typeof entry.data === 'string') this.mount({ path: entry.path, bytes: Uint8Array.from(atob(entry.data), c => c.charCodeAt(0)), readonly: false });
		}
	}
	accept(raw: unknown) {
		if (typeof raw !== 'object' || raw === null || !('kind' in raw)) throw new Error('Invalid host event');
		if (raw.kind === 'close') {
			this.closed = true;
			for (const input of this.inputs.values()) input.finished = true;
		} else if (raw.kind === 'lsp' && 'json' in raw && typeof raw.json === 'string') {
			this.input.append(new TextEncoder().encode(raw.json + '\n'));
			if (raw.json.includes('"shutdown"')) {
				const request = JSON.parse(raw.json);
				if (request.method === 'shutdown' && request.id !== undefined) {
					this.options.emit({ kind: 'lsp', json: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) });
					this.exiting = true;
				}
			}
		} else if (raw.kind === 'files' && 'files' in raw && Array.isArray(raw.files)) {
			this.applyFileChanges(raw.files);
		} else if (raw.kind === 'result' && 'fd' in raw && typeof raw.fd === 'number' && 'stdout' in raw && typeof raw.stdout === 'string' && 'stderr' in raw && typeof raw.stderr === 'string' && 'exitCode' in raw && typeof raw.exitCode === 'number' && 'files' in raw && Array.isArray(raw.files)) {
			const input = this.inputs.get(raw.fd);
			if (!input) return;
			this.applyFileChanges(raw.files);
			input.append(new TextEncoder().encode(JSON.stringify({ stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exitCode })));
			input.finished = true;
		} else throw new Error('Invalid host event shape');
		this.wake.resolve();
		this.wake = Promise.withResolvers<void>();
	}
	private pollReady(input: number, output: number, count: number, nevents: number, started: number): { ready: number; wait: number } {
		if (!this.instance) throw new Error('Host not started');
		const memory = this.instance.exports.memory;
		if (!(memory instanceof WebAssembly.Memory)) throw new Error('Missing memory');
		const view = new DataView(memory.buffer);
		let ready = 0, wait = Infinity;
		for (let i = 0; i < count; i++) {
			const offset = input + i * 48;
			const user = view.getBigUint64(offset, true), type = view.getUint8(offset + 8);
			if (type === wasi.EVENTTYPE_CLOCK) {
				const clock = view.getUint32(offset + 16, true), timeout = view.getBigUint64(offset + 24, true), flags = view.getUint16(offset + 40, true);
				const now = clock === wasi.CLOCKID_REALTIME ? Date.now() : performance.now();
				const delay = flags & 1 ? Number(timeout) / 1e6 - now : Number(timeout) / 1e6 - (performance.now() - started);
				if (delay <= 0) new wasi.Event(user, 0, type).write_bytes(view, output + ready++ * 32);
				else wait = Math.min(wait, delay);
			} else {
				const fd = view.getUint32(offset + 16, true), stream = this.inputs.get(fd);
				if (type === wasi.EVENTTYPE_FD_WRITE || stream?.ready || this.closed) new wasi.Event(user, 0, type).write_bytes(view, output + ready++ * 32);
			}
		}
		view.setUint32(nevents, ready, true);
		if (this.exiting) throw Object.assign(new Error('shutdown'), { code: 0 });
		return { ready, wait };
	}
	private pollSync(input: number, output: number, count: number, nevents: number): number {
		if (!count) return wasi.ERRNO_INVAL;
		const started = performance.now();
		for (;;) {
			const result = this.pollReady(input, output, count, nevents, started);
			if (result.ready) return 0;
			const event = this.mailbox?.receive(result.wait);
			if (event !== undefined) this.accept(event);
		}
	}
	private async pollAsync(input: number, output: number, count: number, nevents: number): Promise<number> {
		if (!count) return wasi.ERRNO_INVAL;
		const started = performance.now();
		for (;;) {
			const result = this.pollReady(input, output, count, nevents, started);
			if (result.ready) return 0;
			const delay = Promise.withResolvers<void>();
			const timer = Number.isFinite(result.wait) ? setTimeout(delay.resolve, result.wait) : undefined;
			await Promise.race([this.wake.promise, delay.promise]);
			clearTimeout(timer);
		}
	}
	async run(module: WebAssembly.Module): Promise<number> {
		this.instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: this.wasi.wasiImport, browser: {
			single_writer: () => this.options.serializedWrites ? 1 : 0,
			command: (ptr: number, length: number) => {
				const memory = this.instance?.exports.memory;
				if (!(memory instanceof WebAssembly.Memory)) throw new Error('Missing memory');
				const command: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length)));
				if (typeof command !== 'object' || command === null || !('argv' in command) || !Array.isArray(command.argv) || !command.argv.every(arg => typeof arg === 'string') || !('env' in command) || !Array.isArray(command.env) || !command.env.every(arg => typeof arg === 'string') || !('cwd' in command) || typeof command.cwd !== 'string') throw new Error('Invalid command request');
				const fd = this.wasi.fds.length;
				const stream = new Input(pending => { if (pending) this.options.emit({ kind: 'cancel', fd }); this.inputs.delete(fd); });
				this.wasi.fds.push(stream); this.inputs.set(fd, stream);
				this.options.emit({ kind: 'command', fd, command: { argv: command.argv, env: command.env, cwd: command.cwd }, files: this.snapshot(), directories: this.directories() });
				return fd;
			},
			message: (ptr: number, length: number) => {
				const memory = this.instance?.exports.memory;
				if (!(memory instanceof WebAssembly.Memory)) throw new Error('Missing memory');
				this.options.emit({ kind: 'lsp', json: new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length)) });
			},
		} });
		const { memory, _start } = this.instance.exports;
		if (!(memory instanceof WebAssembly.Memory) || typeof _start !== 'function') throw new Error('Not a WASI command');
		this.wasi.initialize({ exports: { memory } });
		let start = _start;
		if (this.options.mode === 'jspi') {
			const api = WebAssembly;
			if (!('promising' in api) || typeof api.promising !== 'function') throw new Error('JSPI unavailable');
			start = api.promising(_start);
		}
		try { await start(); return 0; }
		catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number') return error.code; throw error; }
	}
	get linearMemoryCapacityBytes(): number {
		const memory = this.instance?.exports.memory;
		return memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0;
	}
}
