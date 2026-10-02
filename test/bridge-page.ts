import { createMailbox, Mailbox } from '../browser/mailbox';

async function check(mode: 'jspi' | 'mailbox') {
	const bytes = await (await fetch('/bridge.wasm')).arrayBuffer();
	const shared = createMailbox(), mailbox = new Mailbox(shared);
	const worker = new Worker('/bridge-worker.js', { type: 'module' });
	const completion = Promise.withResolvers<unknown>();
	const timer = setTimeout(() => completion.reject(new Error(`${mode} timed out`)), 15000);
	let cancellations = 0;
	worker.onmessage = async event => {
		try {
			const message = event.data;
			if (message.kind === 'done') { completion.resolve(message); return; }
			if (message.kind === 'error') { completion.reject(new Error(message.error)); return; }
			if (message.kind === 'cancel') { cancellations++; return; }
			if (message.kind !== 'command') throw new Error('Unexpected request');
			if (message.command.argv[0] === 'never') return;
			const delay = Promise.withResolvers<void>();
			setTimeout(delay.resolve, 50);
			await delay.promise;
			const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message.command.argv[1]));
			const reply = { kind: 'result', fd: message.fd, stdout: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''), stderr: '', exitCode: 0, files: [{ path: '/tmp/payload', data: btoa(message.command.argv[1]) }] };
			if (mode === 'mailbox') await mailbox.send(reply); else worker.postMessage(reply);
		} catch (error) { completion.reject(error); }
	};
	worker.onerror = event => completion.reject(new Error(event.message));
	try {
		worker.postMessage({ kind: 'start', mode, bytes, mailbox: shared }, [bytes]);
		const result = await completion.promise;
		if (typeof result !== 'object' || result === null || !('exitCode' in result) || result.exitCode !== 0 || !('stdout' in result) || typeof result.stdout !== 'string' || !result.stdout.startsWith('bridge passed; scheduler ticks=')) throw new Error(JSON.stringify(result));
		if (cancellations < 1) throw new Error('Cancellation was not delivered');
		return { mode, result, cancellations };
	} finally { clearTimeout(timer); mailbox.close(); worker.terminate(); }
}

const results = [];
try {
	for (const mode of ['jspi', 'mailbox'] as const) results.push(await check(mode));
	Object.assign(window, { __result: { ok: true, results }, __done: true });
} catch (error) { Object.assign(window, { __result: { ok: false, error: error instanceof Error ? error.stack : String(error), results }, __done: true }); }
document.body.textContent = JSON.stringify('__result' in window ? window.__result : null, null, 2);
