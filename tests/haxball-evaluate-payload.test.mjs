import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createGoalAttributionEngine } from '../stats/goal-attribution.mjs';

const source = readFileSync(new URL('../haxball.mjs', import.meta.url), 'utf8');

test('haxball room script passes one payload object to page.evaluate', () => {
    assert.match(source, /page\.evaluate\(\(\{\s*config,\s*goalAttributionFactorySource,\s*stadiumSource\s*\}\)\s*=>/s);
    assert.match(source, /window\.HBInit\(config\)/);
    assert.match(source, /\},\s*\{\s*config:\s*roomConfig,\s*goalAttributionFactorySource,\s*stadiumSource,\s*\}\s*\);/s);
    assert.doesNotMatch(source, /page\.evaluate\(\(config,\s*goalAttributionFactorySource\)\s*=>/);
    assert.doesNotMatch(source, /\},\s*roomConfig,\s*goalAttributionFactorySource\s*\);/);
});

const stadiumUrl = new URL('../stadiums/rounded-fast.hbs', import.meta.url);
const stadiumSource = readFileSync(stadiumUrl, 'utf8');
const initializationSource = source.slice(
    source.indexOf('async function initializeRoom('),
    source.indexOf('export async function start('),
).replaceAll('import.meta.url', JSON.stringify(new URL('../haxball.mjs', import.meta.url).href));

function initializeWith(page, readStadium = readFile, window = {}) {
    const context = vm.createContext({
        state: { page },
        updateState() {},
        console,
        URL,
        readFile: readStadium,
        createGoalAttributionEngine,
        window,
    });
    return vm.runInContext(`${initializationSource}\ninitializeRoom('test-token')`, context);
}

test('AAAAuto Arena file retains the supplied dimensions and faster kick physics', () => {
    const stadium = JSON.parse(stadiumSource);
    assert.equal(stadium.name, 'AAAAuto Arena');
    assert.equal(stadium.width, 420);
    assert.equal(stadium.height, 200);
    assert.deepEqual(stadium.playerPhysics, { kickStrength: 6.5 });
    assert.equal(stadium.ballPhysics, 'disc0');
    assert.equal(stadium.vertexes.length, 28);
    assert.equal(stadium.segments.length, 18);
});

test('initialization loads the module-relative stadium in Node and selects it before game handlers', async () => {
    const calls = [];
    const room = {
        setCustomStadium(contents) {
            assert.equal(contents, stadiumSource);
            assert.equal(this.onGameStart, undefined);
            calls.push('stadium');
        },
        setDefaultStadium() { assert.fail('Initialization must select the custom stadium'); },
        setScoreLimit(limit) { calls.push(['score', limit]); },
        setTimeLimit(limit) { calls.push(['time', limit]); },
    };
    const page = {
        async exposeFunction() {},
        async evaluate(callback, payload) {
            assert.deepEqual(Object.keys(payload).sort(), ['config', 'goalAttributionFactorySource', 'stadiumSource']);
            assert.equal(payload.stadiumSource, stadiumSource);
            callback(payload);
        },
    };
    await initializeWith(page, async (url, encoding) => {
        assert.equal(url.href, stadiumUrl.href);
        assert.equal(encoding, 'utf8');
        return readFile(url, encoding);
    }, {
        HBInit(config) {
            assert.equal(config.token, 'test-token');
            return room;
        },
    });
    assert.deepEqual(calls, ['stadium', ['score', 0], ['time', 3]]);
    assert.equal(typeof room.onGameStart, 'function');
    assert.equal(typeof room.onTeamGoal, 'function');
});

test('stadium read failure reports the map and file and prevents room initialization', async () => {
    const cause = new Error('ENOENT: no such file or directory');
    await assert.rejects(initializeWith({
        async exposeFunction() {},
        async evaluate() { assert.fail('Room must not initialize without its stadium'); },
    }, async () => { throw cause; }), error => {
        assert.match(error.message, /Failed to load AAAAuto Arena stadium \(stadiums\/rounded-fast\.hbs\): ENOENT/);
        assert.equal(error.cause, cause);
        return true;
    });
});
