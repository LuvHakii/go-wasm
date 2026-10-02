export const CHUNK_BYTES = 64 * 1024;
export const EMPTY = 0, REQUEST = 1, RESPONSE = 2, CANCELLED = 3, CLOSED = 4;
const HEADER_WORDS = 6;

export function createMailbox(): SharedArrayBuffer {
	return new SharedArrayBuffer(HEADER_WORDS * 4 + CHUNK_BYTES);
}

export class Mailbox {
	readonly control: Int32Array;
	readonly bytes: Uint8Array;
	private sequence = 0;
	private sending: Promise<void> = Promise.resolve();
	constructor(readonly buffer: SharedArrayBuffer) {
		if (buffer.byteLength !== HEADER_WORDS * 4 + CHUNK_BYTES) throw new Error('Invalid mailbox size');
		this.control = new Int32Array(buffer, 0, HEADER_WORDS);
		this.bytes = new Uint8Array(buffer, HEADER_WORDS * 4);
	}
	send(value: unknown): Promise<void> {
		const encoded = new TextEncoder().encode(JSON.stringify(value));
		const operation = this.sending.then(async () => {
			const sequence = ++this.sequence;
			for (let offset = 0; offset < encoded.length; offset += CHUNK_BYTES) {
				while (Atomics.load(this.control, 0) !== EMPTY) {
					const state = Atomics.load(this.control, 0);
					if (state === CLOSED || state === CANCELLED) throw new Error('Mailbox closed');
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, 1);
					await promise;
				}
				const length = Math.min(CHUNK_BYTES, encoded.length - offset);
				this.bytes.set(encoded.subarray(offset, offset + length));
				Atomics.store(this.control, 1, sequence);
				Atomics.store(this.control, 2, encoded.length);
				Atomics.store(this.control, 3, offset);
				Atomics.store(this.control, 4, length);
				Atomics.store(this.control, 0, RESPONSE);
				Atomics.notify(this.control, 0);
			}
		});
		this.sending = operation.catch(() => {});
		return operation;
	}
	receive(timeoutMs: number): unknown | undefined {
		const started = performance.now();
		let result: Uint8Array | undefined, received = 0, sequence = 0;
		for (;;) {
			const state = Atomics.load(this.control, 0);
			if (state === CLOSED || state === CANCELLED) throw new Error('Mailbox closed');
			if (state !== RESPONSE) {
				const remaining = result ? Infinity : timeoutMs - (performance.now() - started);
				if (remaining <= 0) return undefined;
				if (Atomics.wait(this.control, 0, state, remaining) === 'timed-out' && !result) return undefined;
				continue;
			}
			const total = Atomics.load(this.control, 2), offset = Atomics.load(this.control, 3), length = Atomics.load(this.control, 4);
			if (!result) {
				if (total <= 0 || offset !== 0) throw new Error('Invalid mailbox packet');
				result = new Uint8Array(total);
				sequence = Atomics.load(this.control, 1);
			}
			if (Atomics.load(this.control, 1) !== sequence || total !== result.length || offset !== received || length <= 0 || length > CHUNK_BYTES || received + length > total) throw new Error('Invalid mailbox chunk');
			result.set(this.bytes.subarray(0, length), received);
			received += length;
			Atomics.store(this.control, 0, EMPTY);
			Atomics.notify(this.control, 0);
			if (received === total) return JSON.parse(new TextDecoder().decode(result));
		}
	}
	close(cancel = false): void {
		Atomics.store(this.control, 0, cancel ? CANCELLED : CLOSED);
		Atomics.notify(this.control, 0);
	}
}
