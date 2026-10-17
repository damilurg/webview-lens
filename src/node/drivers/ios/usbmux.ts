// Cross-platform zero-dependency usbmuxd client (macOS /var/run/usbmuxd, Windows 127.0.0.1:27015).
// Implements the v1 XML plist framing protocol used to discover connected iOS devices over USB.

import net from 'node:net';

const USBMUX_VERSION_PLIST = 1;
const USBMUX_MESSAGE_PLIST = 8;
const HEADER_BYTES = 16;

export interface UsbmuxPacket {
    version: number;
    message: number;
    tag: number;
    payload: string;
}

export interface UsbmuxDevice {
    deviceId: number;
    udid: string;
    connectionType: string;
    productId?: number;
}

export interface UsbmuxStatus {
    available: boolean;
    devices: UsbmuxDevice[];
    error?: string;
}

/** Platform-specific usbmuxd endpoint: Unix socket on macOS/Linux, TCP 27015 on Windows. */
export const usbmuxAddress = (
    platform: string = process.platform,
): { path: string } | { host: string; port: number } =>
    platform === 'win32' ? { host: '127.0.0.1', port: 27015 } : { path: '/var/run/usbmuxd' };

/** Frames an XML plist payload with the 16-byte little-endian usbmuxd header. */
export const encodeUsbmuxPacket = (xmlPayload: string, tag = 1): Buffer => {
    const body = Buffer.from(xmlPayload, 'utf8');
    const header = Buffer.alloc(HEADER_BYTES);

    header.writeUInt32LE(HEADER_BYTES + body.length, 0);
    header.writeUInt32LE(USBMUX_VERSION_PLIST, 4);
    header.writeUInt32LE(USBMUX_MESSAGE_PLIST, 8);
    header.writeUInt32LE(tag, 12);

    return Buffer.concat([header, body]);
};

/** Decodes zero or more complete usbmuxd packets from a buffer, returning any trailing fragment. */
export const decodeUsbmuxPackets = (
    buffer: Buffer,
): { packets: UsbmuxPacket[]; remainder: Buffer } => {
    const packets: UsbmuxPacket[] = [];
    let offset = 0;

    while (offset + HEADER_BYTES <= buffer.length) {
        const length = buffer.readUInt32LE(offset);

        if (length < HEADER_BYTES) {
            throw new Error(`Invalid usbmuxd packet length: ${length}`);
        }
        if (offset + length > buffer.length) break;

        packets.push({
            version: buffer.readUInt32LE(offset + 4),
            message: buffer.readUInt32LE(offset + 8),
            tag: buffer.readUInt32LE(offset + 12),
            payload: buffer.subarray(offset + HEADER_BYTES, offset + length).toString('utf8'),
        });
        offset += length;
    }

    return { packets, remainder: buffer.subarray(offset) };
};

export const buildListDevicesPlist = (): string =>
    [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>MessageType</key><string>ListDevices</string>',
        '  <key>ClientVersionString</key><string>webview-lens</string>',
        '  <key>ProgName</key><string>webview-lens</string>',
        '</dict>',
        '</plist>',
    ].join('\n');

const readPlistString = (block: string, key: string): string | undefined =>
    block.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];

const readPlistInt = (block: string, key: string): number | undefined => {
    const raw = block.match(new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`))?.[1];

    return raw !== undefined ? Number(raw) : undefined;
};

/** Parses the `<key>DeviceList</key><array>...</array>` section of a usbmuxd ListDevices reply. */
export const parseListDevicesPlist = (xml: string): UsbmuxDevice[] => {
    const listMatch = xml.match(/<key>DeviceList<\/key>\s*<array>([\s\S]*?)<\/array>/);

    if (!listMatch?.[1]) return [];

    const arrayBody = listMatch[1];
    const propsMatches = [
        ...arrayBody.matchAll(/<key>Properties<\/key>\s*<dict>([\s\S]*?)<\/dict>/g),
    ];
    const devices: UsbmuxDevice[] = [];

    for (const match of propsMatches) {
        const block = match[1] ?? '';
        const udid = readPlistString(block, 'SerialNumber');
        const deviceId = readPlistInt(block, 'DeviceID');
        const connectionType = readPlistString(block, 'ConnectionType') ?? 'USB';
        const productId = readPlistInt(block, 'ProductID');

        if (udid && deviceId !== undefined) {
            devices.push({
                deviceId,
                udid,
                connectionType,
                ...(productId !== undefined ? { productId } : {}),
            });
        }
    }

    return devices;
};

/** Queries usbmuxd for currently attached iOS devices. Never throws on missing service. */
export const listIosDevices = async ({
    platform = process.platform,
    timeoutMs = 1500,
}: {
    platform?: string;
    timeoutMs?: number;
} = {}): Promise<UsbmuxStatus> => {
    const address = usbmuxAddress(platform);

    return new Promise<UsbmuxStatus>((resolve) => {
        let settled = false;
        let buffer: Buffer = Buffer.alloc(0);
        const finish = (status: UsbmuxStatus) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(status);
        };

        const socket =
            'path' in address
                ? net.createConnection(address.path)
                : net.createConnection(address.port, address.host);

        const timer = setTimeout(() => {
            finish({ available: false, devices: [], error: 'Timed out connecting to usbmuxd' });
        }, timeoutMs);

        socket.on('error', (error: NodeJS.ErrnoException) => {
            finish({ available: false, devices: [], error: error.code ?? error.message });
        });

        socket.on('connect', () => {
            socket.write(encodeUsbmuxPacket(buildListDevicesPlist(), 1));
        });

        socket.on('data', (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            try {
                const { packets, remainder } = decodeUsbmuxPackets(buffer);

                buffer = remainder;
                const reply = packets[0];

                if (reply) {
                    finish({ available: true, devices: parseListDevicesPlist(reply.payload) });
                }
            } catch (error) {
                finish({
                    available: false,
                    devices: [],
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        });
    });
};

/** Human-readable diagnosis for iOS USB connectivity across macOS and Windows. */
export const describeIosDevices = (
    status: UsbmuxStatus,
    udid?: string,
    platform: string = process.platform,
): string | null => {
    if (!status.available) {
        if (platform === 'win32') {
            return 'Apple Mobile Device Service (usbmuxd on 127.0.0.1:27015) is not running: install Apple Devices or iTunes from the Microsoft Store';
        }

        return `usbmuxd is unavailable (${status.error ?? 'not running'}): reconnect your iPhone or check system usbmuxd`;
    }

    const usbDevices = status.devices.filter((d) => d.connectionType === 'USB');
    const devices = usbDevices.length > 0 ? usbDevices : status.devices;

    if (devices.length === 0) {
        return 'No iPhone found: connect it over USB, unlock it and tap "Trust This Computer"';
    }

    if (udid) {
        const match = devices.find((d) => d.udid === udid);

        if (!match) {
            return `iPhone "${udid}" not found (connected: ${devices.map((d) => d.udid).join(', ')})`;
        }

        return null;
    }

    if (devices.length > 1) {
        return `Multiple iPhones connected (${devices.map((d) => d.udid).join(', ')}): pass --serial <udid>`;
    }

    return null;
};
