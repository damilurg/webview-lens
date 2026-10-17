import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { findIwdp } from '../src/node/drivers/ios/iwdp.ts';
import {
    buildListDevicesPlist,
    decodeUsbmuxPackets,
    describeIosDevices,
    encodeUsbmuxPacket,
    parseListDevicesPlist,
    usbmuxAddress,
} from '../src/node/drivers/ios/usbmux.ts';

describe('usbmuxd binary framing & plist parsing', () => {
    it('encodes and decodes packets across fragmented and concatenated chunks', () => {
        const xml1 = buildListDevicesPlist();
        const xml2 = '<plist><dict><key>MessageType</key><string>Result</string></dict></plist>';
        const combined = Buffer.concat([encodeUsbmuxPacket(xml1, 1), encodeUsbmuxPacket(xml2, 2)]);

        // Split right in the middle of the first packet.
        const firstHalf = combined.subarray(0, 24);
        const secondHalf = combined.subarray(24);

        const step1 = decodeUsbmuxPackets(firstHalf);

        assert.equal(step1.packets.length, 0);
        assert.equal(step1.remainder.length, 24);

        const step2 = decodeUsbmuxPackets(Buffer.concat([step1.remainder, secondHalf]));

        assert.equal(step2.packets.length, 2);
        assert.equal(step2.remainder.length, 0);
        assert.equal(step2.packets[0]?.tag, 1);
        assert.equal(step2.packets[0]?.payload, xml1);
        assert.equal(step2.packets[1]?.tag, 2);
        assert.equal(step2.packets[1]?.payload, xml2);
    });

    it('parses USB and Network devices from a ListDevices XML plist response', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
            <key>DeviceList</key>
            <array>
                <dict>
                    <key>DeviceID</key><integer>7</integer>
                    <key>MessageType</key><string>Attached</string>
                    <key>Properties</key>
                    <dict>
                        <key>ConnectionType</key><string>USB</string>
                        <key>DeviceID</key><integer>7</integer>
                        <key>ProductID</key><integer>4776</integer>
                        <key>SerialNumber</key><string>00008110-ABCDEF123456</string>
                    </dict>
                </dict>
            </array>
        </dict>
        </plist>`;

        assert.deepEqual(parseListDevicesPlist(xml), [
            {
                deviceId: 7,
                udid: '00008110-ABCDEF123456',
                connectionType: 'USB',
                productId: 4776,
            },
        ]);
    });

    it('uses unix socket on macOS/Linux and TCP 127.0.0.1:27015 on Windows', () => {
        assert.deepEqual(usbmuxAddress('darwin'), { path: '/var/run/usbmuxd' });
        assert.deepEqual(usbmuxAddress('win32'), { host: '127.0.0.1', port: 27015 });
    });

    it('describes missing service, empty device list, multiple devices and specific UDID', () => {
        assert.match(
            describeIosDevices({ available: false, devices: [] }, undefined, 'win32') ?? '',
            /Apple Devices|iTunes/,
        );
        assert.match(
            describeIosDevices({ available: true, devices: [] }, undefined, 'darwin') ?? '',
            /Trust This Computer/,
        );
        assert.equal(
            describeIosDevices({
                available: true,
                devices: [{ deviceId: 1, udid: 'u1', connectionType: 'USB' }],
            }),
            null,
        );
        assert.match(
            describeIosDevices({
                available: true,
                devices: [
                    { deviceId: 1, udid: 'u1', connectionType: 'USB' },
                    { deviceId: 2, udid: 'u2', connectionType: 'USB' },
                ],
            }) ?? '',
            /--serial/,
        );
        assert.equal(
            describeIosDevices(
                {
                    available: true,
                    devices: [
                        { deviceId: 1, udid: 'u1', connectionType: 'USB' },
                        { deviceId: 2, udid: 'u2', connectionType: 'USB' },
                    ],
                },
                'u2',
            ),
            null,
        );
    });
});

describe('findIwdp', () => {
    it('prefers IWDP env variable and falls back to PATH / Downloads', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-iwdp-'));
        const binDir = path.join(home, 'Downloads', 'iwdp-win');

        fs.mkdirSync(binDir, { recursive: true });
        const exe = path.join(binDir, 'ios_webkit_debug_proxy.exe');

        fs.writeFileSync(exe, '');

        assert.equal(findIwdp({ env: { PATH: '' }, home, platform: 'win32' }).iwdp, exe);
        assert.equal(findIwdp({ env: { IWDP: exe, PATH: '' }, home, platform: 'win32' }).iwdp, exe);
    });
});
