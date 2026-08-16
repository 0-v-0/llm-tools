/** 100ns ticks per millisecond (10,000). */
export const TICKS_PER_MS = 10_000n;

/** Multiplier: ms offset within the current ms boundary from hrtime. */
const HR_TICKS_PER_MS = 1_000_000n; // 1_000_000 ns per ms

/**
 * Unix epoch time in 100ns ticks (BigInt).
 * Combines Date.now() wall-clock with process.hrtime() sub-ms precision.
 */
export function nowTicks(): bigint {
	const hr = process.hrtime.bigint(); // ns since arbitrary epoch
	const ms = BigInt(Date.now()); // epoch ms
	return ms * TICKS_PER_MS + (hr % HR_TICKS_PER_MS) / 100n;
}

/** Convert 100ns ticks to a Date object. */
export function ticksToDate(ticks: bigint): Date {
	return new Date(Number(ticks / TICKS_PER_MS));
}

/** Convert 100ns ticks to an ISO-8601 string. */
export function ticksToIso(ticks: bigint): string {
	return ticksToDate(ticks).toISOString();
}

/** Convert 100ns ticks to milliseconds (number). */
export function ticksToMs(ticks: bigint): number {
	return Number(ticks / TICKS_PER_MS);
}