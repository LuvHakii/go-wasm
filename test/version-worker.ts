import { WASI, File, Directory, OpenFile, PreopenDirectory, ConsoleStdout, wasi } from '@bjorn3/browser_wasi_shim';

self.onmessage = async (event: MessageEvent<unknown>) => {
	try {
		const request = event.data;
		if (typeof request !== 'object' || request === null || !('tool' in request) || !('bytes' in request)
			|| !(request.bytes instanceof ArrayBuffer)
			|| !['go', 'compile', 'link', 'asm', 'gopls'].includes(String(request.tool))) {
			throw new Error('Invalid version worker request');
		}
		const tool = String(request.tool);
		const compileStart = performance.now();
		const module = await WebAssembly.compile(request.bytes);
		const compileMs = performance.now() - compileStart;
		const stdoutDecoder = new TextDecoder();
		const stderrDecoder = new TextDecoder();
		let stdout = '', stderr = '', clockPolls = 0;
		const host = new WASI(
			[tool, tool === 'compile' || tool === 'link' || tool === 'asm' ? '-V=full' : 'version'],
			['GOROOT=/goroot', 'HOME=/home', 'TMPDIR=/tmp', 'GOOS=wasip1', 'GOARCH=wasm', 'CGO_ENABLED=0',
				'GOENV=off', 'GOEXPERIMENT=', 'GOFLAGS=', 'GOTOOLCHAIN=local', 'GOWORK=off',
				'GOPROXY=off', 'GOSUMDB=off', 'GOTELEMETRY=off', 'GOCACHE=/cache', 'GOMODCACHE=/modules'],
			[new OpenFile(new File([])),
				new ConsoleStdout(bytes => { stdout += stdoutDecoder.decode(bytes, { stream: true }); }),
				new ConsoleStdout(bytes => { stderr += stderrDecoder.decode(bytes, { stream: true }); }),
				new PreopenDirectory('/', new Map([
					['goroot', new Directory([])], ['home', new Directory([])], ['tmp', new Directory([])],
					['cache', new Directory([])], ['modules', new Directory([])],
				]))],
		);
		const sleeper = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;
		// The shim spins and omits nevents. Step1 supports clocks only, not runtime message/FD polling.
		host.wasiImport.poll_oneoff = (input: number, output: number, count: number, nevents: number) => {
			if (count === 0) return wasi.ERRNO_INVAL;
			if (!sleeper) throw new Error('Clock polling requires isolated shared memory in this step1 host');
			const view = new DataView(host.inst.exports.memory.buffer);
			const clocks = [];
			for (let i = 0; i < count; i++) {
				const subscription = wasi.Subscription.read_bytes(view, input + i * 48);
				if (subscription.eventtype !== wasi.EVENTTYPE_CLOCK) {
					throw new Error('Step1 host does not implement FD/event polling; scheduler integration is unverified');
				}
				if (subscription.clockid !== wasi.CLOCKID_REALTIME && subscription.clockid !== wasi.CLOCKID_MONOTONIC) return wasi.ERRNO_INVAL;
				const now = () => subscription.clockid === wasi.CLOCKID_REALTIME
					? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6));
				const deadline = subscription.flags & wasi.SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME
					? subscription.timeout : now() + subscription.timeout;
				clocks.push({ subscription, now, deadline });
			}
			clockPolls++;
			for (;;) {
				let ready = 0, remaining = Infinity;
				for (const { subscription, now, deadline } of clocks) {
					const delay = Number(deadline - now()) / 1e6;
					if (delay <= 0) {
						new wasi.Event(subscription.userdata, wasi.ERRNO_SUCCESS, wasi.EVENTTYPE_CLOCK).write_bytes(view, output + ready * 32);
						ready++;
					} else remaining = Math.min(remaining, delay);
				}
				if (ready) {
					view.setUint32(nevents, ready, true);
					return wasi.ERRNO_SUCCESS;
				}
				Atomics.wait(sleeper, 0, 0, remaining);
			}
		};
		const instantiateStart = performance.now();
		const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: host.wasiImport, browser: { command: () => -1, message: () => {}, single_writer: () => 0 } });
		const instantiateMs = performance.now() - instantiateStart;
		const { memory, _start } = instance.exports;
		if (!(memory instanceof WebAssembly.Memory) || typeof _start !== 'function') throw new Error('Not a WASI command module');
		const executionStart = performance.now();
		const exitCode = host.start({ exports: { memory, _start: () => _start() } });
		const executionMs = performance.now() - executionStart;
		stdout += stdoutDecoder.decode();
		stderr += stderrDecoder.decode();
		self.postMessage({ ok: true, tool, stdout, stderr, exitCode, compileMs, instantiateMs, executionMs,
			clockPolls, linearMemoryCapacityBytes: memory.buffer.byteLength, goHeap: null,
			peakLinearMemoryBytes: null, wholeBrowserMemoryBytes: null });
	} catch (error) {
		self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
};
