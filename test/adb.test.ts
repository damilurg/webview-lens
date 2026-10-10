import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
    createAdbRunner,
    describeDevices,
    findAdb,
    forwardWebView,
    isKeyguardShowing,
    parseDevices,
    parseFocusedPackage,
    parsePackagesByPid,
    parseWebViewSockets,
    pickWebViewSocket,
    removeReversePort,
    reversePort,
} from '../src/node/adb.ts';
import { diagnose } from '../src/node/device.ts';
import { fromGitBashPath } from '../src/node/paths.ts';

const DEBUG_APP = 'com.example.app.debug';
const RELEASE_APP = 'com.example.app';

describe('describeDevices', () => {
    it('phone connected and allowed debugging: no hint', () => {
        assert.equal(describeDevices('List of devices attached\nabc123\tdevice\n'), null);
    });

    it('empty list: connect over USB and turn debugging on', () => {
        assert.match(describeDevices('List of devices attached\n\n') ?? '', /USB/);
    });

    it('unauthorized: confirm on the phone screen', () => {
        assert.match(
            describeDevices('List of devices attached\r\nabc123\tunauthorized\r\n') ?? '',
            /confirm/,
        );
    });

    it('another state (offline) is named as it is', () => {
        assert.match(describeDevices('List of devices attached\nabc\toffline\n') ?? '', /offline/);
    });

    it('multiple online devices without serial: asks to pass --serial', () => {
        const output = 'List of devices attached\ndev1\tdevice\ndev2\tdevice\n';

        assert.deepEqual(parseDevices(output), [
            { serial: 'dev1', state: 'device' },
            { serial: 'dev2', state: 'device' },
        ]);
        assert.match(describeDevices(output) ?? '', /--serial/);
        assert.equal(describeDevices(output, 'dev2'), null);
        assert.match(describeDevices(output, 'missing') ?? '', /missing/);
    });

    it('createAdbRunner prefixes device commands with -s <serial> except adb devices', () => {
        const seen: string[][] = [];
        const runner = createAdbRunner('dev2', (args) => {
            seen.push(args);

            return '';
        });

        runner(['devices']);
        runner(['shell', 'dumpsys', 'window']);

        assert.deepEqual(seen, [['devices'], ['-s', 'dev2', 'shell', 'dumpsys', 'window']]);
    });
});

describe('isKeyguardShowing', () => {
    it('locked', () => assert.equal(isKeyguardShowing('  isKeyguardShowing=true\n'), true));
    it('unlocked', () => assert.equal(isKeyguardShowing('  isKeyguardShowing=false\n'), false));
});

describe('fromGitBashPath', () => {
    it('C:/Program Files/Git/faq → /faq', () => {
        assert.equal(fromGitBashPath('C:/Program Files/Git/faq'), '/faq');
    });

    it('Git at the drive root, path with a query', () => {
        assert.equal(fromGitBashPath('D:/Git/event/12?id=3'), '/event/12?id=3');
    });

    it('a normal path is unchanged', () => {
        assert.equal(fromGitBashPath('/events'), '/events');
    });
});

describe('findAdb', () => {
    const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adb-home-'));
    const putAdb = (dir: string) => {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'adb.exe');

        fs.writeFileSync(file, '');

        return file;
    };

    it('unpacked platform-tools in Downloads', () => {
        const home = tempHome();
        const adb = putAdb(
            path.join(home, 'Downloads', 'platform-tools-latest-windows', 'platform-tools'),
        );

        assert.equal(findAdb({ env: { PATH: '' }, home, platform: 'win32' }).adb, adb);
    });

    it('ADB wins over the other places', () => {
        const home = tempHome();
        const own = putAdb(path.join(home, 'tools'));

        putAdb(path.join(home, 'Downloads', 'platform-tools'));

        assert.equal(findAdb({ env: { ADB: own, PATH: '' }, home, platform: 'win32' }).adb, own);
    });

    it('ADB points at a missing file: keeps looking', () => {
        const home = tempHome();
        const adb = putAdb(path.join(home, 'Downloads', 'platform-tools'));

        assert.equal(
            findAdb({
                env: { ADB: path.join(home, 'none', 'adb.exe'), PATH: '' },
                home,
                platform: 'win32',
            }).adb,
            adb,
        );
    });

    it('nowhere: undefined and the places looked at', () => {
        const home = tempHome();
        const { adb, checked } = findAdb({ env: { PATH: '' }, home, platform: 'win32' });

        assert.equal(adb, undefined);
        assert.ok(checked.some((place) => place.includes('Downloads')));
    });
});

describe('pickWebViewSocket', () => {
    const sockets = ['webview_devtools_remote_13510', 'webview_devtools_remote_17576'];
    const packages = new Map([
        [13510, DEBUG_APP],
        [17576, RELEASE_APP],
    ]);

    it('the app on screen wins over a newer process', () => {
        assert.equal(
            pickWebViewSocket(sockets, DEBUG_APP, packages),
            'webview_devtools_remote_13510',
        );
    });

    it('another app on screen: the newest process', () => {
        assert.equal(
            pickWebViewSocket(sockets, 'com.android.launcher', packages),
            'webview_devtools_remote_17576',
        );
    });

    it('no sockets: undefined', () => {
        assert.equal(pickWebViewSocket([], RELEASE_APP, packages), undefined);
    });
});

describe('adb output parsing', () => {
    it('focused package from mCurrentFocus', () => {
        assert.equal(
            parseFocusedPackage(
                `  mCurrentFocus=Window{ac6bd9b u0 ${DEBUG_APP}/com.example.WebActivity}`,
            ),
            DEBUG_APP,
        );
    });

    it('notification shade focused: the app from mFocusedApp', () => {
        const dumpsys = [
            '  mCurrentFocus=Window{7642bd3 u0 NotificationShade}',
            `  mFocusedApp=ActivityRecord{240901449 u0 ${DEBUG_APP}/.ui.Main t589}`,
        ].join('\n');

        assert.equal(parseFocusedPackage(dumpsys), DEBUG_APP);
    });

    it('nothing known: undefined', () => {
        assert.equal(
            parseFocusedPackage('  mCurrentFocus=Window{7642bd3 u0 NotificationShade}'),
            undefined,
        );
    });

    it('packages by pid from ps', () => {
        const map = parsePackagesByPid(
            `  PID NAME\r\n13510 ${DEBUG_APP}\r\n17576 ${RELEASE_APP}\r\n`,
        );

        assert.equal(map.get(13510), DEBUG_APP);
        assert.equal(map.get(17576), RELEASE_APP);
        assert.equal(map.size, 2);
    });

    it('WebView sockets, deduplicated', () => {
        const unix =
            '0: 00 @webview_devtools_remote_1\n1: 00 @webview_devtools_remote_1\n2: 00 @chrome_devtools_remote';

        assert.deepEqual(parseWebViewSockets(unix), ['webview_devtools_remote_1']);
    });
});

describe('forwardWebView and diagnose with a fake adb', () => {
    const fakeAdb = (outputs: Record<string, string>) => {
        const calls: string[] = [];

        return {
            calls,
            run: (args: string[]) => {
                const key = args.join(' ');

                calls.push(key);

                return outputs[key] ?? '';
            },
        };
    };

    it('forwards the port to the socket of the app on screen', () => {
        const adb = fakeAdb({
            'shell cat /proc/net/unix':
                '@webview_devtools_remote_10\n@webview_devtools_remote_20\n',
            'shell dumpsys window': `  mCurrentFocus=Window{1 u0 ${DEBUG_APP}/.Main}`,
            'shell ps -A -o PID,NAME': `PID NAME\n10 ${DEBUG_APP}\n20 ${RELEASE_APP}\n`,
        });

        assert.equal(forwardWebView(9223, adb.run), 'webview_devtools_remote_10');
        assert.ok(adb.calls.includes('forward tcp:9223 localabstract:webview_devtools_remote_10'));
    });

    it('no WebView: null and no forward', () => {
        const adb = fakeAdb({});

        assert.equal(forwardWebView(9223, adb.run), null);
        assert.ok(!adb.calls.some((call) => call.startsWith('forward')));
    });

    it('diagnose names a locked screen before looking for sockets', () => {
        const adb = fakeAdb({
            devices: 'List of devices attached\nabc\tdevice\n',
            'shell dumpsys window': 'isKeyguardShowing=true',
        });

        assert.match(diagnose(9223, adb.run), /locked/);
        assert.ok(!adb.calls.includes('shell cat /proc/net/unix'));
    });

    it('diagnose explains a missing debuggable WebView', () => {
        const adb = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n' });

        assert.match(diagnose(9223, adb.run), /setWebContentsDebuggingEnabled/);
    });

    it('reversePort and removeReversePort manage adb reverse tunnels', () => {
        const adb = fakeAdb({});

        reversePort(24678, 24678, adb.run);
        removeReversePort(24678, adb.run);

        assert.deepEqual(adb.calls, ['reverse tcp:24678 tcp:24678', 'reverse --remove tcp:24678']);
    });
});
