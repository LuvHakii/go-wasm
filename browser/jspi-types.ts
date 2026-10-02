declare global {
	namespace WebAssembly {
		const Suspending: new (fn: (...args: number[]) => Promise<number>) => (...args: number[]) => number;
		function promising(fn: Function): (...args: number[]) => Promise<unknown>;
	}
}
export {};
