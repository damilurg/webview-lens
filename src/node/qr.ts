// Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level L, Versions 1–6)
// with UTF-8 half-block terminal rendering for instant iPhone CA profile scanning.

interface VersionSpec {
    version: number;
    size: number;
    dataCodewords: number;
    ecPerBlock: number;
    blocks: number;
    alignment: readonly number[];
}

const VERSIONS: readonly VersionSpec[] = [
    { version: 1, size: 21, dataCodewords: 19, ecPerBlock: 7, blocks: 1, alignment: [] },
    { version: 2, size: 25, dataCodewords: 34, ecPerBlock: 10, blocks: 1, alignment: [6, 18] },
    { version: 3, size: 29, dataCodewords: 55, ecPerBlock: 15, blocks: 1, alignment: [6, 22] },
    { version: 4, size: 33, dataCodewords: 80, ecPerBlock: 20, blocks: 1, alignment: [6, 26] },
    { version: 5, size: 37, dataCodewords: 108, ecPerBlock: 26, blocks: 1, alignment: [6, 30] },
    { version: 6, size: 41, dataCodewords: 136, ecPerBlock: 18, blocks: 2, alignment: [6, 34] },
];

export interface QrMatrix {
    readonly version: number;
    readonly size: number;
    /** Optimal ISO/IEC 18004 §7.8 data mask pattern (0..7) chosen by penalty minimization. */
    readonly mask: number;
    get(row: number, col: number): boolean;
}

// GF(256) multiplication tables with primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1).
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
    let x = 1;

    for (let i = 0; i < 255; i += 1) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) {
        GF_EXP[i] = GF_EXP[i - 255]!;
    }
})();

const gfMul = (a: number, b: number): number => {
    if (a === 0 || b === 0) return 0;

    return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
};

const rsGeneratorPoly = (degree: number): Uint8Array => {
    let poly = new Uint8Array([1]);

    for (let i = 0; i < degree; i += 1) {
        const next = new Uint8Array(poly.length + 1);
        const factor = GF_EXP[i]!;

        for (let j = 0; j < poly.length; j += 1) {
            next[j] = next[j]! ^ poly[j]!;
            next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, factor);
        }
        poly = next;
    }

    return poly;
};

const rsComputeEc = (data: Uint8Array, ecLen: number): Uint8Array => {
    const gen = rsGeneratorPoly(ecLen);
    const rem = new Uint8Array(ecLen);

    for (const byte of data) {
        const factor = byte ^ rem[0]!;

        rem.copyWithin(0, 1);
        rem[ecLen - 1] = 0;
        for (let i = 0; i < ecLen; i += 1) {
            rem[i] = rem[i]! ^ gfMul(gen[i + 1]!, factor);
        }
    }

    return rem;
};

const pickVersion = (byteLen: number): VersionSpec => {
    // Byte mode overhead: 4-bit mode + 8-bit length (versions 1–9) = 12 bits; +4-bit terminator = 2 bytes.
    const required = byteLen + 2;
    const match = VERSIONS.find((spec) => spec.dataCodewords >= required);

    if (!match) {
        throw new Error(`QR payload is too long (${byteLen} bytes, max 134 bytes)`);
    }

    return match;
};

const buildDataCodewords = (bytes: Uint8Array, spec: VersionSpec): Uint8Array => {
    const bits: number[] = [];
    const pushBits = (value: number, count: number) => {
        for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
    };

    // Mode indicator: 0100 (Byte mode)
    pushBits(0b0100, 4);
    pushBits(bytes.length, 8);
    for (const b of bytes) pushBits(b, 8);

    const maxBits = spec.dataCodewords * 8;
    const terminator = Math.min(4, maxBits - bits.length);

    pushBits(0, terminator);
    while (bits.length % 8 !== 0) bits.push(0);

    const out = new Uint8Array(spec.dataCodewords);
    const dataByteCount = bits.length / 8;

    for (let i = 0; i < dataByteCount; i += 1) {
        let byte = 0;

        for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i * 8 + b]!;
        out[i] = byte;
    }

    const padBytes = [0xec, 0x11];

    for (let i = dataByteCount; i < spec.dataCodewords; i += 1) {
        out[i] = padBytes[(i - dataByteCount) % 2]!;
    }

    return out;
};

const interleaveCodewords = (data: Uint8Array, spec: VersionSpec): Uint8Array => {
    const blockDataLen = spec.dataCodewords / spec.blocks;
    const dataBlocks: Uint8Array[] = [];
    const ecBlocks: Uint8Array[] = [];

    for (let b = 0; b < spec.blocks; b += 1) {
        const slice = data.subarray(b * blockDataLen, (b + 1) * blockDataLen);

        dataBlocks.push(slice);
        ecBlocks.push(rsComputeEc(slice, spec.ecPerBlock));
    }

    const total: number[] = [];

    for (let i = 0; i < blockDataLen; i += 1) {
        for (const block of dataBlocks) total.push(block[i]!);
    }
    for (let i = 0; i < spec.ecPerBlock; i += 1) {
        for (const block of ecBlocks) total.push(block[i]!);
    }

    return new Uint8Array(total);
};

const computeFormatBits = (mask: number): number => {
    // ECC Level L = 01
    const data = (0b01 << 3) | (mask & 0b111);
    let rem = data << 10;

    for (let i = 14; i >= 10; i -= 1) {
        if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
    }

    return ((data << 10) | rem) ^ 0x5412;
};

const placeFunctionPatterns = (size: number, alignment: readonly number[]) => {
    const modules = new Uint8Array(size * size);
    const reserved = new Uint8Array(size * size);

    const setFunc = (r: number, c: number, dark: boolean) => {
        if (r < 0 || c < 0 || r >= size || c >= size) return;
        modules[r * size + c] = dark ? 1 : 0;
        reserved[r * size + c] = 1;
    };

    const drawFinder = (top: number, left: number) => {
        for (let dr = -1; dr <= 7; dr += 1) {
            for (let dc = -1; dc <= 7; dc += 1) {
                const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
                const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
                const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;

                setFunc(top + dr, left + dc, inside && (border || core));
            }
        }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (let i = 8; i < size - 8; i += 1) {
        setFunc(6, i, i % 2 === 0);
        setFunc(i, 6, i % 2 === 0);
    }

    // Dark module always at (4*version + 9, 8) = (size - 8, 8).
    setFunc(size - 8, 8, true);

    // Reserve format info areas.
    for (let i = 0; i <= 8; i += 1) {
        if (i !== 6) {
            reserved[8 * size + i] = 1;
            reserved[i * size + 8] = 1;
        }
    }
    for (let i = 0; i < 8; i += 1) {
        reserved[8 * size + (size - 1 - i)] = 1;
        reserved[(size - 1 - i) * size + 8] = 1;
    }

    // Alignment patterns (versions >= 2).
    for (const r of alignment) {
        for (const c of alignment) {
            if (reserved[r * size + c] === 1) continue;
            for (let dr = -2; dr <= 2; dr += 1) {
                for (let dc = -2; dc <= 2; dc += 1) {
                    const dist = Math.max(Math.abs(dr), Math.abs(dc));

                    setFunc(r + dr, c + dc, dist === 2 || dist === 0);
                }
            }
        }
    }

    return { modules, reserved };
};

const writeFormatBits = (modules: Uint8Array, size: number, mask: number) => {
    const bits = computeFormatBits(mask);
    const bit = (i: number) => (bits >> i) & 1;

    for (let i = 0; i <= 5; i += 1) modules[8 * size + i] = bit(14 - i);
    modules[8 * size + 7] = bit(8);
    modules[8 * size + 8] = bit(7);
    modules[7 * size + 8] = bit(6);
    for (let i = 0; i <= 5; i += 1) modules[(5 - i) * size + 8] = bit(5 - i);

    for (let i = 0; i < 8; i += 1) modules[8 * size + (size - 1 - i)] = bit(i);
    for (let i = 0; i < 7; i += 1) modules[(size - 7 + i) * size + 8] = bit(14 - i);
};

/** ISO/IEC 18004 §7.8.2: all 8 standard data mask predicates. */
const MASK_PREDICATES: readonly ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const FINDER_PAT_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const FINDER_PAT_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

const matchesPattern = (
    get: (idx: number) => number,
    start: number,
    pattern: readonly number[],
): boolean => {
    for (let i = 0; i < pattern.length; i += 1) {
        if (get(start + i) !== pattern[i]) return false;
    }

    return true;
};

/** ISO/IEC 18004 §7.8.3: computes total mask penalty score (N1 + N2 + N3 + N4). */
export const evaluateQrPenalty = (matrix: Pick<QrMatrix, 'size' | 'get'>): number => {
    const { size } = matrix;
    let penalty = 0;
    let darkCount = 0;

    // Rule N1 (adjacent runs >= 5) and Rule N3 (finder-like 1:1:3:1:1 + 4 light) on rows & cols.
    for (let i = 0; i < size; i += 1) {
        let rowRun = 1;
        let colRun = 1;
        let prevRow = matrix.get(i, 0) ? 1 : 0;
        let prevCol = matrix.get(0, i) ? 1 : 0;

        if (prevRow === 1) darkCount += 1;

        for (let j = 1; j < size; j += 1) {
            const curRow = matrix.get(i, j) ? 1 : 0;
            const curCol = matrix.get(j, i) ? 1 : 0;

            if (curRow === 1) darkCount += 1;

            if (curRow === prevRow) {
                rowRun += 1;
                if (rowRun === 5) penalty += 3;
                if (rowRun > 5) penalty += 1;
            }
            if (curRow !== prevRow) {
                prevRow = curRow;
                rowRun = 1;
            }

            if (curCol === prevCol) {
                colRun += 1;
                if (colRun === 5) penalty += 3;
                if (colRun > 5) penalty += 1;
            }
            if (curCol !== prevCol) {
                prevCol = curCol;
                colRun = 1;
            }
        }

        const rowAt = (k: number) => (matrix.get(i, k) ? 1 : 0);
        const colAt = (k: number) => (matrix.get(k, i) ? 1 : 0);

        for (let k = 0; k <= size - 11; k += 1) {
            if (matchesPattern(rowAt, k, FINDER_PAT_A) || matchesPattern(rowAt, k, FINDER_PAT_B)) {
                penalty += 40;
            }
            if (matchesPattern(colAt, k, FINDER_PAT_A) || matchesPattern(colAt, k, FINDER_PAT_B)) {
                penalty += 40;
            }
        }
    }

    // Rule N2: 2x2 same-color blocks.
    for (let r = 0; r < size - 1; r += 1) {
        for (let c = 0; c < size - 1; c += 1) {
            const v = matrix.get(r, c);

            if (
                v === matrix.get(r, c + 1) &&
                v === matrix.get(r + 1, c) &&
                v === matrix.get(r + 1, c + 1)
            ) {
                penalty += 3;
            }
        }
    }

    // Rule N4: balance of dark modules relative to 50%.
    const ratioPct = (darkCount * 100) / (size * size);
    const deviation = Math.floor(Math.abs(ratioPct - 50) / 5);

    return penalty + deviation * 10;
};

/** Encodes a UTF-8 string into an ISO/IEC 18004 QR boolean matrix (ECC Level L, optimal mask 0..7). */
export const encodeQrMatrix = (text: string): QrMatrix => {
    const bytes = Buffer.from(text, 'utf8');
    const spec = pickVersion(bytes.length);
    const codewords = interleaveCodewords(buildDataCodewords(bytes, spec), spec);
    const { size } = spec;
    const { modules: baseModules, reserved } = placeFunctionPatterns(size, spec.alignment);

    let bitIndex = 0;
    const totalBits = codewords.length * 8;
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;

        for (let step = 0; step < size; step += 1) {
            const row = upward ? size - 1 - step : step;

            for (let dx = 0; dx < 2; dx += 1) {
                const col = right - dx;
                const idx = row * size + col;

                if (reserved[idx] === 1) continue;

                let dark = 0;

                if (bitIndex < totalBits) {
                    dark = (codewords[bitIndex >> 3]! >> (7 - (bitIndex & 7))) & 1;
                    bitIndex += 1;
                }
                baseModules[idx] = dark;
            }
        }
        upward = !upward;
    }

    let bestMask = 0;
    let bestScore = Infinity;
    let bestModules = baseModules;

    for (let mask = 0; mask < MASK_PREDICATES.length; mask += 1) {
        const predicate = MASK_PREDICATES[mask]!;
        const candidate = new Uint8Array(baseModules);

        for (let r = 0; r < size; r += 1) {
            for (let c = 0; c < size; c += 1) {
                const idx = r * size + c;

                if (reserved[idx] === 1) continue;
                if (predicate(r, c)) candidate[idx] = candidate[idx]! ^ 1;
            }
        }
        writeFormatBits(candidate, size, mask);

        const score = evaluateQrPenalty({
            size,
            get: (r, c) => candidate[r * size + c] === 1,
        });

        if (score < bestScore) {
            bestScore = score;
            bestMask = mask;
            bestModules = candidate;
        }
    }

    return {
        version: spec.version,
        size,
        mask: bestMask,
        get: (row, col) => bestModules[row * size + col] === 1,
    };
};

const halfBlock = (topDark: boolean, bottomDark: boolean): string => {
    if (topDark && bottomDark) return ' ';
    if (topDark) return '▄';
    if (bottomDark) return '▀';

    return '█';
};

/**
 * Renders a QR code using UTF-8 half-block characters (`█`, `▀`, `▄`, ` `) with a 2-module quiet
 * zone, inverted for standard dark terminals (light background, dark modules).
 */
export const renderQrTerminal = (text: string, quietZone = 2): string => {
    const matrix = encodeQrMatrix(text);
    const total = matrix.size + quietZone * 2;
    const isDark = (r: number, c: number): boolean => {
        const mr = r - quietZone;
        const mc = c - quietZone;

        if (mr < 0 || mc < 0 || mr >= matrix.size || mc >= matrix.size) return false;

        return matrix.get(mr, mc);
    };

    const lines: string[] = [];

    for (let r = 0; r < total; r += 2) {
        let line = '';

        for (let c = 0; c < total; c += 1) {
            const topDark = isDark(r, c);
            const bottomDark = r + 1 < total ? isDark(r + 1, c) : false;

            line += halfBlock(topDark, bottomDark);
        }
        lines.push(line);
    }

    return lines.join('\n');
};
