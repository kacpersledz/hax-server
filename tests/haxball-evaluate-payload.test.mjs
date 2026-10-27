import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createGoalAttributionEngine } from '../stats/goal-attribution.mjs';
import { loadBuiltinStadiums } from '../haxball.mjs';
import {
    BUILTIN_STADIUMS,
    createStadiumRandomizer,
    getStadiumPhysics,
    randomizeStadiumDefinition,
} from '../stadiums/randomizer.mjs';

const source = readFileSync(new URL('../haxball.mjs', import.meta.url), 'utf8');

test('haxball room script passes one payload object to page.evaluate', () => {
    assert.match(source, /page\.evaluate\(\(\{\s*config,\s*goalAttributionFactorySource,\s*stadiumSource,\s*builtinStadiums,\s*randomizerFactorySource,\s*randomizeDefinitionSource,\s*getPhysicsSource,/s);
    assert.match(source, /window\.HBInit\(config\)/);
    assert.match(source, /\},\s*\{\s*config:\s*roomConfig,\s*goalAttributionFactorySource,\s*stadiumSource,\s*builtinStadiums,\s*randomizerFactorySource,\s*randomizeDefinitionSource,\s*getPhysicsSource,\s*\}\s*\);/s);
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
        loadBuiltinStadiums,
        createGoalAttributionEngine,
        createStadiumRandomizer,
        randomizeStadiumDefinition,
        getStadiumPhysics,
        window,
    });
    return vm.runInContext(`${initializationSource}\ninitializeRoom('test-token')`, context);
}

test('all ten bundled built-in stadiums load and match their HaxBall source blobs', async () => {
    const stadiums = await loadBuiltinStadiums();
    assert.equal(stadiums.length, 10);
    assert.deepEqual(stadiums.map(stadium => stadium.name), BUILTIN_STADIUMS.map(stadium => stadium.name));
    for (const stadium of stadiums) {
        assert.equal(JSON.parse(stadium.source).name, stadium.name);
    }
});

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
    const announcements = [];
    const statsCommands = [];
    const room = {
        setCustomStadium(contents) {
            if (calls.length === 0) {
                assert.equal(contents, stadiumSource);
                assert.equal(this.onGameStart, undefined);
                calls.push('stadium');
            } else {
                calls.push({ type: 'custom', source: contents });
            }
        },
        setDefaultStadium(name) { calls.push({ type: 'default', name }); },
        setScoreLimit(limit) { calls.push(['score', limit]); },
        setTimeLimit(limit) { calls.push(['time', limit]); },
        sendAnnouncement(message, target) { announcements.push({ message, target }); },
        getPlayerList() { return []; },
    };
    const testWindow = {
        HBInit(config) {
            assert.equal(config.token, 'test-token');
            return room;
        },
        statsOnPlayerChat(auth, message) {
            statsCommands.push({ auth, message });
            return null;
        },
    };
    const page = {
        async exposeFunction() {},
        async evaluate(callback, payload) {
            assert.deepEqual(Object.keys(payload).sort(), [
                'builtinStadiums', 'config', 'getPhysicsSource', 'goalAttributionFactorySource',
                'randomizeDefinitionSource', 'randomizerFactorySource', 'stadiumSource',
            ]);
            assert.equal(payload.stadiumSource, stadiumSource);
            assert.equal(payload.builtinStadiums.length, 10);
            callback(payload);
        },
    };
    await initializeWith(page, async (url, encoding) => {
        assert.equal(url.href, stadiumUrl.href);
        assert.equal(encoding, 'utf8');
        return readFile(url, encoding);
    }, testWindow);
    assert.deepEqual(calls, ['stadium', ['score', 0], ['time', 3]]);
    assert.equal(typeof room.onGameStart, 'function');
    assert.equal(typeof room.onTeamGoal, 'function');
    assert.equal(typeof room.onStadiumChange, 'function');

    assert.equal(room.onPlayerChat({ id: 7, admin: false }, '!r info'), false);
    assert.match(announcements.map(item => item.message).join('\n'), /AAAAuto Arena/);
    assert.equal(room.onPlayerChat({ id: 7, admin: false }, '!rank'), false);
    assert.equal(statsCommands.length, 0, 'ordinary stats commands still require player auth');

    room.onPlayerJoin({ id: 7, name: 'Test player', auth: 'valid-auth', admin: true });
    assert.equal(room.onPlayerChat({ id: 7, admin: true }, '!rank'), false);
    assert.deepEqual(statsCommands, [{ auth: 'valid-auth', message: '!rank' }]);

    room.onStadiumChange('Rounded', { id: 7, admin: true });
    assert.equal(room.onPlayerChat({ id: 7, admin: true }, '!r'), false);
    const applied = JSON.parse(calls.find(call => call.type === 'custom').source);
    assert.equal(applied.name, 'Rounded');
    assert.ok([5.5, 5.75, 6, 6.25, 6.5].includes(applied.playerPhysics.kickStrength));
    assert.ok([0.985, 0.9875, 0.99].includes(applied.ballPhysics.damping));

    assert.equal(room.onPlayerChat({ id: 7, admin: true }, '!r reset'), false);
    assert.deepEqual(calls.at(-1), { type: 'default', name: 'Rounded' });

    room.onGameStart(null);
    assert.equal(room.onPlayerChat({ id: 7, admin: false }, '!r info'), false);
    const beforeActiveReset = calls.length;
    assert.equal(room.onPlayerChat({ id: 7, admin: true }, '!r reset'), false);
    assert.equal(calls.length, beforeActiveReset, 'a running match must not change stadium');
    assert.match(announcements.at(-2).message, /Stop the match/);
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
