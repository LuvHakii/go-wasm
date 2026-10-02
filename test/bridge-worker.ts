import { BrowserHost } from '../browser/host';
import type { HostRequest } from '../browser/host';

let host: BrowserHost | undefined;
self.onmessage = async (event: MessageEvent<unknown>) => {
	try {
		const raw = event.data;
		if (typeof raw !== 'object' || raw === null || !('kind' in raw)) throw new Error('Invalid worker message');
		if (raw.kind !== 'start') { host?.accept(raw); return; }
		if (!('bytes' in raw) || !(raw.bytes instanceof ArrayBuffer) || !('mode' in raw) || (raw.mode !== 'jspi' && raw.mode !== 'mailbox')) throw new Error('Invalid start');
		const mailbox = 'mailbox' in raw && raw.mailbox instanceof SharedArrayBuffer ? raw.mailbox : undefined;
		host = new BrowserHost({ argv: ['probe'], env: ['HOME=/home', 'TMPDIR=/tmp', 'GOTELEMETRY=off'], files: [], mode: raw.mode, mailbox, emit: (message: HostRequest) => self.postMessage(message) });
		const exitCode = await host.run(await WebAssembly.compile(raw.bytes));
		self.postMessage({ kind: 'done', exitCode, stdout: host.stdout, stderr: host.stderr, memory: host.linearMemoryCapacityBytes });
	} catch (error) { self.postMessage({ kind: 'error', error: error instanceof Error ? error.stack : String(error) }); }
};
