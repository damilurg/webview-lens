// Registry and auto-selection of DeviceDrivers across platforms (Android, iOS).

import { createAndroidDriver } from './android.ts';
import { createIosDriver } from './ios/index.ts';
import type { DeviceDriver, PlatformSelection } from './types.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('drivers');

/** Default ordered driver list for this build of webview-lens. */
export const createDefaultDrivers = (): DeviceDriver[] => [
    createAndroidDriver(),
    createIosDriver(),
];

/**
 * Resolves a platform selection (`auto`, `android`, `ios`) against the registered drivers.
 * Under `auto`, picks the first driver with a connected usable device, falling back to the first
 * registered driver so waiting/diagnostics still give actionable instructions.
 */
export const resolveDriver = async (
    selection: PlatformSelection = 'auto',
    drivers: readonly DeviceDriver[] = createDefaultDrivers(),
): Promise<DeviceDriver> => {
    if (drivers.length === 0) {
        throw new Error('No device drivers registered');
    }

    if (selection !== 'auto') {
        const match = drivers.find((driver) => driver.platform === selection);

        if (!match) {
            const available = drivers.map((d) => d.platform).join(', ');

            throw new Error(
                `Platform "${selection}" is not available yet (registered: ${available})`,
            );
        }

        return match;
    }

    for (const driver of drivers) {
        if (await driver.isAvailable()) {
            log.info(`platform auto → ${driver.platform}`);

            return driver;
        }
    }
    log.info(`platform auto: no device yet, using ${drivers[0]!.platform}`);

    return drivers[0]!;
};
