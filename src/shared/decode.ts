// Decoders for data that crosses a trust boundary (protocol frames, JSON from pages, config files):
// each takes `unknown` and returns the typed value or `undefined`, so callers narrow instead of
// casting. Edge-safe, no dependencies.

import { isRecord } from './utils.ts';

/** A decoder: the typed value, or `undefined` when the input does not have that shape. */
export type Decoder<T> = (input: unknown) => T | undefined;

export const rec: Decoder<Record<string, unknown>> = (input) =>
    isRecord(input) ? input : undefined;

export const str: Decoder<string> = (input) => (typeof input === 'string' ? input : undefined);

/** A finite number (NaN and Infinity are not values a protocol or a config means). */
export const num: Decoder<number> = (input) =>
    typeof input === 'number' && Number.isFinite(input) ? input : undefined;

export const bool: Decoder<boolean> = (input) => (typeof input === 'boolean' ? input : undefined);

/** An array whose items all decode; `undefined` if the input is not an array or any item fails. */
export const list =
    <T>(item: Decoder<T>): Decoder<T[]> =>
    (input) => {
        if (!Array.isArray(input)) return undefined;

        const out: T[] = [];

        for (const entry of input) {
            const decoded = item(entry);

            if (decoded === undefined) return undefined;
            out.push(decoded);
        }

        return out;
    };

/** An array, keeping only the items that decode (for lists where one odd entry is not fatal). */
export const someOf =
    <T>(item: Decoder<T>): Decoder<T[]> =>
    (input) => {
        if (!Array.isArray(input)) return undefined;

        const out: T[] = [];

        for (const entry of input) {
            const decoded = item(entry);

            if (decoded !== undefined) out.push(decoded);
        }

        return out;
    };

/** An object whose values are all strings (HTTP headers). */
export const stringMap: Decoder<Record<string, string>> = (input) => {
    if (!isRecord(input)) return undefined;

    const out: Record<string, string> = {};

    for (const [key, value] of Object.entries(input)) {
        if (typeof value !== 'string') return undefined;
        out[key] = value;
    }

    return out;
};

/** One of the given string literals. */
export const oneOf =
    <const T extends string>(values: readonly T[]): Decoder<T> =>
    (input) =>
        values.find((value) => value === input);

/** `JSON.parse` that returns `undefined` for malformed input instead of throwing. */
export const parseJson = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
};
