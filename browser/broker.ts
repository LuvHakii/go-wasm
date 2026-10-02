import { parseTar } from 'nanotar';
import { createMailbox, Mailbox } from './mailbox';
import type { Command, SavedFile } from './host';
import { PersistentCache } from './cache';

type Result = { exitCode: number; stdout: string; stderr: string; changedFiles: { path: string; data: string | null }[]; elapsedMs: number; linearMemoryCapacityBytes: number };
type Session = { worker: Worker; mailbox: Mailbox; mode: 'jspi' | 'mailbox'; complete: PromiseWithResolvers<Result>; children: Map<number, Session>; pending: Set<number>; cancelled: Set<number>; closed: boolean; persistent: boolean };
type Spawn = { tool: string; sentFiles: number; sentBytes: number; wallMs: number; runMs: number; changedFiles: number; changedBytes: number; memory: number };
let spawns: Spawn[] = [];
const modules = new Map<string, Promise<WebAssembly.Module>>();
const artifacts = new Map<string, { sha256: string; size: number }>();
const assets: SavedFile[] = [];
const archives = new Map<string, Promise<void>>();
const writable = new Map<string, SavedFile>();
const diskCache = new PersistentCache();
let mode: 'jspi' | 'mailbox' = 'mailbox';
let goSession: Session | undefined;
let goplsSession: Session | undefined;
let serial = Promise.resolve();
let workspaceRevision = 0;
let active: Session | undefined;
let closed = false;
let goVersion = '';

async function loadArtifact(path: string): Promise<ArrayBuffer> {
	const expected = artifacts.get(path);
	if (!expected) throw new Error(`Unregistered artifact: ${path}`);
	const response = await fetch(`/dist/${path}`);
	if (!response.ok) throw new Error(`Missing artifact: ${path}`);
	const bytes = await response.arrayBuffer();
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
	if (bytes.byteLength !== expected.size || hash !== expected.sha256) throw new Error(`Artifact integrity mismatch: ${path}`);
	return bytes;
}

async function loadModule(name: string): Promise<WebAssembly.Module> {
	let module = modules.get(name);
	if (!module) {
		module = loadArtifact(`${name}.wasm`).then(bytes => WebAssembly.compile(bytes));
		modules.set(name, module);
	}
	return module;
}

async function loadArchive(path: string, prefix: string): Promise<void> {
	let loaded = archives.get(path);
	if (!loaded) {
		loaded = (async () => {
			const buffer = await loadArtifact(path);
			const shared = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(buffer.byteLength) : buffer;
			if (typeof SharedArrayBuffer === 'function' && shared instanceof SharedArrayBuffer) new Uint8Array(shared).set(new Uint8Array(buffer));
			for (const entry of parseTar(new Uint8Array(buffer))) {
				if (entry.type !== 'file') continue;
				const bytes = entry.data ? new Uint8Array(shared, entry.data.byteOffset, entry.data.byteLength) : new Uint8Array(0);
				assets.push({ path: `${prefix}/${entry.name}`, bytes, readonly: true });
			}
		})();
		archives.set(path, loaded);
	}
	await loaded;
}

async function send(session: Session, event: unknown) {
	if (session.mode === 'mailbox') await session.mailbox.send(event);
	else session.worker.postMessage(event);
}

async function applyChanges(changes: Result['changedFiles']) {
	for (const file of changes) {
		if (!file.path.startsWith('/') || file.path.split('/').includes('..')) throw new Error('Invalid changed path');
		if (file.data === null) writable.delete(file.path);
		else writable.set(file.path, { path: file.path, bytes: Uint8Array.from(atob(file.data), c => c.charCodeAt(0)), readonly: false });
	}
	const changed = changes.flatMap(file => {
		const entry = writable.get(file.path);
		return file.data !== null && entry ? [entry] : [];
	});
	await diskCache.save(changed, changes.filter(file => file.data === null).map(file => file.path));
}

function stop(session: Session) {
	session.closed = true;
	for (const child of session.children.values()) stop(child);
	session.children.clear();
	session.mailbox.close(true);
	session.worker.terminate();
	session.complete.resolve({ exitCode: 1, stdout: '', stderr: 'cancelled', changedFiles: [], elapsedMs: 0, linearMemoryCapacityBytes: 0 });
}

const GO_VERBS = ['env', 'list', 'version', 'build', 'mod', 'work'];

function rejectUnsupported(argv: string[], env: string[]) {
	if (!GO_VERBS.includes(argv[1] ?? '')) throw new Error(`unsupported browser go command: ${argv[1]}`);
	const requested = new Map(env.map(entry => { const split = entry.indexOf('='); return [entry.slice(0, split), entry.slice(split + 1)]; }));
	const os = requested.get('GOOS') ?? 'wasip1', arch = requested.get('GOARCH') ?? 'wasm';
	if ((os !== 'wasip1' && os !== 'js') || arch !== 'wasm') throw new Error(`unsupported target: ${os}/${arch}`);
	if (requested.get('CGO_ENABLED') === '1') throw new Error('unsupported: cgo');
}

async function execute(name: string, command: Command, files: SavedFile[], persistent = false, existing?: Session, binary?: Uint8Array, directories: string[] = []): Promise<Session> {
	if (name === 'go') rejectUnsupported(command.argv, command.env);
	const module = binary ? await WebAssembly.compile(binary) : await loadModule(name);
	const worker = existing?.worker ?? new Worker('/tool-worker.js', { type: 'module' });
	const mailbox = existing?.mailbox ?? new Mailbox(createMailbox());
	const session: Session = { worker, mailbox, mode, complete: Promise.withResolvers<Result>(), children: new Map(), pending: new Set(), cancelled: new Set(), closed: false, persistent };
	const started = performance.now();
	const spawn: Spawn = { tool: name, sentFiles: files.length, sentBytes: files.reduce((sum, file) => sum + file.bytes.length, 0), wallMs: 0, runMs: 0, changedFiles: 0, changedBytes: 0, memory: 0 };
	worker.onmessage = async event => {
		try {
			const message = event.data;
			if (message.kind === 'lsp') { self.postMessage({ kind: 'lsp', json: message.json }); return; }
			if (message.kind === 'done') {
				if (Array.isArray(message.changedFiles)) Object.assign(spawn, { wallMs: performance.now() - started, runMs: message.elapsedMs, changedFiles: message.changedFiles.length, changedBytes: message.changedFiles.reduce((sum: number, entry: { data: string | null }) => sum + (entry.data?.length ?? 0), 0), memory: message.linearMemoryCapacityBytes });
				spawns.push(spawn);
				if (typeof message.exitCode !== 'number' || typeof message.stdout !== 'string' || typeof message.stderr !== 'string' || !Array.isArray(message.changedFiles)) throw new Error('Invalid execution result');
				for (const entry of message.changedFiles) if (typeof entry.path !== 'string' || (entry.data !== null && typeof entry.data !== 'string')) throw new Error('Invalid file update');
				session.complete.resolve({ exitCode: message.exitCode, stdout: message.stdout, stderr: message.stderr, changedFiles: message.changedFiles, elapsedMs: message.elapsedMs, linearMemoryCapacityBytes: message.linearMemoryCapacityBytes });
				if (!persistent) worker.terminate();
				return;
			}
			if (message.kind === 'cancel') {
				if (session.pending.has(message.fd)) session.cancelled.add(message.fd);
				const child = session.children.get(message.fd);
				if (child) { stop(child); session.children.delete(message.fd); }
				return;
			}
			if (message.kind !== 'command' || typeof message.fd !== 'number' || !message.command || !Array.isArray(message.command.argv) || !message.command.argv.every((arg: unknown) => typeof arg === 'string') || !Array.isArray(message.command.env) || !message.command.env.every((arg: unknown) => typeof arg === 'string') || typeof message.command.cwd !== 'string' || !Array.isArray(message.files)) throw new Error('Invalid nested command');
			const tool = String(message.command.argv[0]).split('/').at(-1);
			if (!tool || !['go', 'compile', 'link', 'asm'].includes(tool)) {
				await send(session, { kind: 'result', fd: message.fd, stdout: '', stderr: `unsupported browser tool: ${tool}`, exitCode: 1, files: [] });
				return;
			}
			// The go command asks asm for its version to key the build cache; the manifest knows it, so asm.wasm loads only when a .s file builds.
			if (tool === 'asm' && message.command.argv[1] === '-V=full' && goVersion) {
				await send(session, { kind: 'result', fd: message.fd, stdout: `asm version ${goVersion}\n`, stderr: '', exitCode: 0, files: [] });
				return;
			}
			session.pending.add(message.fd);
			const invoke = async () => {
				try {
					if (session.closed || session.cancelled.has(message.fd)) return;
					if (!Array.isArray(message.directories) || !message.directories.every((path: unknown) => typeof path === 'string')) throw new Error('Invalid directory snapshot');
					const child = await execute(tool, message.command, message.files, false, undefined, undefined, message.directories);
					if (session.closed || session.cancelled.has(message.fd)) { stop(child); return; }
					session.children.set(message.fd, child);
					const result = await child.complete.promise;
					session.children.delete(message.fd);
					if (!session.closed && !session.cancelled.has(message.fd)) await send(session, { kind: 'result', fd: message.fd, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, files: result.changedFiles });
				} finally { session.pending.delete(message.fd); session.cancelled.delete(message.fd); }
			};
			if (tool === 'go') {
				serial = serial.then(invoke).catch(error => { session.complete.reject(error); });
			} else await invoke();
		} catch (error) { session.complete.reject(error); stop(session); }
	};
	worker.onerror = event => { session.complete.reject(new Error(event.message)); stop(session); };
	const envMap = new Map(command.env.map(entry => { const split = entry.indexOf('='); return [entry.slice(0, split), entry.slice(split + 1)]; }));
	for (const [key, value] of Object.entries({ GOROOT: '/goroot', HOME: '/home', TMPDIR: '/tmp', GOENV: 'off', GOTOOLCHAIN: 'local', GOTELEMETRY: 'off', GOSUMDB: 'off', GOPROXY: 'off', CGO_ENABLED: '0', GOEXPERIMENT: '', GOFLAGS: '-p=1 -trimpath', GOMODCACHE: '/modules', GOPATH: '/home/go' })) if (key !== 'GOFLAGS' || !envMap.has(key)) envMap.set(key, value);
	if (!envMap.has('GOOS')) envMap.set('GOOS', 'wasip1');
	envMap.set('GOARCH', envMap.get('GOARCH') ?? 'wasm');
	if (envMap.get('GOOS') === 'js') await loadArchive('std-cache-js.tar', '/cache');
	envMap.set('GOCACHE', `/cache/${envMap.get('GOOS')}_wasm`);
	envMap.set('PWD', command.cwd === '.' ? '/workspace' : command.cwd);
	envMap.set('BROWSER_TOOL_SHA256', artifacts.get(`${name}.wasm`)?.sha256 ?? '');
	let argv = [name, ...command.argv.slice(1)];
	if (name === 'go') {
		argv =[name, '-C', envMap.get('PWD') ?? '/workspace', ...argv.slice(1)];
	}
	const goRuntime = name === 'program' ? assets.find(file => file.path === '/goroot/lib/wasm/wasm_exec.js')?.bytes : undefined;
	worker.postMessage({ kind: 'start', mode, module, argv, env: [...envMap].map(([key, value]) => `${key}=${value}`), files: [...assets, ...files], directories, mailbox: mailbox.buffer, serializedWrites: true, goRuntime });
	return session;
}

self.onmessage = async (event: MessageEvent<unknown>) => {
	const raw = event.data;
	try {
		if (typeof raw !== 'object' || raw === null || !('kind' in raw)) throw new Error('Invalid broker request');
		if (raw.kind === 'init') {
			if (!('mode' in raw) || (raw.mode !== 'jspi' && raw.mode !== 'mailbox')) throw new Error('Invalid mode');
			mode = raw.mode;
			const manifest: unknown = await (await fetch('/dist/tool-manifest.json')).json();
			if (typeof manifest !== 'object' || manifest === null || !('schemaVersion' in manifest) || manifest.schemaVersion !== 1 || !('artifacts' in manifest) || !Array.isArray(manifest.artifacts)) throw new Error('Invalid artifact manifest');
			if (!('goVersion' in manifest) || typeof manifest.goVersion !== 'string') throw new Error('Manifest lacks goVersion');
			goVersion = manifest.goVersion;
			for (const entry of manifest.artifacts) {
				if (typeof entry !== 'object' || entry === null || typeof entry.path !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(wasm|tar)$/.test(entry.path) || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0 || artifacts.has(entry.path)) throw new Error('Invalid manifest entry');
				artifacts.set(entry.path, { sha256: entry.sha256, size: entry.size });
			}
			await loadArchive('goroot.tar', '/goroot');
			await loadArchive('std-cache.tar', '/cache');
			const identity = artifacts.get('go.wasm')?.sha256;
			if (!identity) throw new Error('Missing Go artifact identity');
			for (const file of await diskCache.open(identity)) writable.set(file.path, file);
			self.postMessage({ kind: 'ready', mode, immutableAssetBytes: assets.reduce((sum, file) => sum + file.bytes.length, 0) });
			return;
		}
		if (raw.kind === 'stats') {
			self.postMessage({ kind: 'stats', modules: [...modules.keys()], archives: [...archives.keys()], spawns });
			if ('reset' in raw && raw.reset === true) spawns = [];
			return;
		}
		if (raw.kind === 'close') {
			closed = true;
			if (active) stop(active);
			if (goSession) stop(goSession);
			if (goplsSession) stop(goplsSession);
			modules.clear(); assets.length = 0; writable.clear();
			self.postMessage({ kind: 'closed' });
			return;
		}
		if (raw.kind === 'cancel') { if (active) stop(active); return; }
		if (closed) throw new Error('broker closed');
		if (raw.kind === 'files' && 'files' in raw && Array.isArray(raw.files)) {
			for (const file of raw.files) {
				if (typeof file.path !== 'string' || !(file.bytes instanceof Uint8Array)) throw new Error('Invalid workspace file');
				writable.set(file.path, { path: file.path, bytes: file.bytes, readonly: false });
			}
			if (goplsSession) {
				const files = raw.files.map(file => {
					let encoded = '';
					for (let i = 0; i < file.bytes.length; i += 8192) encoded += String.fromCharCode(...file.bytes.subarray(i, i + 8192));
					return { path: file.path, data: btoa(encoded) };
				});
				await send(goplsSession, { kind: 'files', files });
			}
			workspaceRevision++;
			self.postMessage({ kind: 'saved', workspaceRevision });
			return;
		}
		if (raw.kind === 'lsp' && 'json' in raw && typeof raw.json === 'string') {
			if (!goplsSession) throw new Error('gopls not started');
			await send(goplsSession, { kind: 'lsp', json: raw.json });
			return;
		}
		if (raw.kind === 'gopls') {
			goplsSession = await execute('gopls', { argv: ['gopls', 'serve'], env: [], cwd: '/workspace' }, [...writable.values()], true);
			goplsSession.complete.promise.then(async result => { await applyChanges(result.changedFiles); self.postMessage({ kind: 'gopls-exit', ...result }); }).catch(error => self.postMessage({ kind: 'error', error: String(error) }));
			self.postMessage({ kind: 'gopls-ready' });
			return;
		}
		if (raw.kind === 'command' && 'requestId' in raw && typeof raw.requestId === 'number' && 'argv' in raw && Array.isArray(raw.argv) && raw.argv.every(arg => typeof arg === 'string') && 'env' in raw && Array.isArray(raw.env) && raw.env.every(arg => typeof arg === 'string') && 'cwd' in raw && typeof raw.cwd === 'string') {
			const command = { argv: raw.argv, env: raw.env, cwd: raw.cwd };
			serial = serial.then(async () => {
				if (closed) throw new Error('broker closed');
				goSession = await execute('go', command, [...writable.values()], true, goSession);
				active = goSession;
				const result = await goSession.complete.promise;
				await applyChanges(result.changedFiles);
				active = undefined;
				self.postMessage({ kind: 'result', requestId: raw.requestId, workspaceRevision, ...result });
			}).catch(error => {
				active = undefined;
				self.postMessage({ kind: 'result', requestId: raw.requestId, workspaceRevision, exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), changedFiles: [], elapsedMs: 0, linearMemoryCapacityBytes: 0 });
			});
			return;
		}
		if (raw.kind === 'run' && 'requestId' in raw && typeof raw.requestId === 'number' && 'path' in raw && typeof raw.path === 'string') {
			const file = writable.get(raw.path);
			if (!file) throw new Error('Program not found');
			const execution = await execute('program', { argv: ['program'], env: [], cwd: '/workspace' }, [], false, undefined, file.bytes);
			self.postMessage({ kind: 'result', requestId: raw.requestId, ...await execution.complete.promise });
			return;
		}
		throw new Error('Unsupported broker request');
	} catch (error) { self.postMessage({ kind: 'error', error: error instanceof Error ? error.stack : String(error) }); }
};
