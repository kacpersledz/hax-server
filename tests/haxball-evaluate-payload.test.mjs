import test from 'node:test';
import { createDiagnostics } from '../diagnostics/buffer.mjs';
import { createCompetition } from '../competition/controller.mjs';
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
    assert.match(source, /\},\s*\{\s*config:\s*roomConfig,\s*goalAttributionFactorySource,\s*stadiumSource,\s*builtinStadiums,\s*randomizerFactorySource,\s*randomizeDefinitionSource,\s*getPhysicsSource,\s*competitionFactorySource,\s*diagnosticsFactorySource,\s*\}\s*\);/s);
    assert.doesNotMatch(source, /page\.evaluate\(\(config,\s*goalAttributionFactorySource\)\s*=>/);
    assert.doesNotMatch(source, /\},\s*roomConfig,\s*goalAttributionFactorySource\s*\);/);
});

const stadiumUrl = new URL('../stadiums/rounded-fast.hbs', import.meta.url);
const stadiumSource = readFileSync(stadiumUrl, 'utf8');
const initializationSource = source.slice(
    source.indexOf('async function initializeRoom('),
    source.indexOf('export async function start('),
).replaceAll('import.meta.url', JSON.stringify(new URL('../haxball.mjs', import.meta.url).href));

function initializeWith(page, readStadium = readFile, window = {}, dateNow = Date.now) {
    const ClockDate = class extends Date { static now() { return dateNow(); } };
    const context = vm.createContext({
        state: { page },
        updateState() {},
        console,
        Date: ClockDate,
        URL,
        setTimeout,
        clearTimeout,
        readFile: readStadium,
        loadBuiltinStadiums,
        createGoalAttributionEngine,
        createDiagnostics,
        createCompetition,
        createStadiumRandomizer,
        randomizeStadiumDefinition,
        getStadiumPhysics,
        window,
    });
    return vm.runInContext(`${initializationSource}\ninitializeRoom('test-token')`, context);
}

async function createGoalAttributionRoom() {
    let now = 1000;
    const players = [
        { id: 1, name: 'Attacker', team: 1, auth: 'private-auth-a' },
        { id: 4, name: 'Defender', team: 2, auth: 'private-auth-d' },
        { id: 5, name: 'Defender 2', team: 2, auth: 'private-auth-e' },
    ];
    const discs = new Map(players.map(player => [player.id, { x: 100, y: 100, xspeed: 0, yspeed: 0, radius: 15 }]));
    const ball = { x: 0, y: 0, xspeed: 0, yspeed: 0, radius: 10 };
    const goals = [], reports = [];
    const room = {
        setCustomStadium() {}, setScoreLimit() {}, setTimeLimit() {},
        sendAnnouncement() {}, setPlayerAdmin() {}, getPlayerList() { return players; },
        getScores() { return { red: 0, blue: 0, time: (now - 1000) / 1000 }; },
        getBallPosition() { return { x: ball.x, y: ball.y }; },
        getDiscProperties() { return ball; },
        getPlayerDiscProperties(id) { return discs.get(id) ?? null; },
    };
    const window = {
        HBInit: () => room,
        saveDiagnosticReport(report) { reports.push(report); return reports.length; },
        statsOnTeamGoal(team, scorer, assister) { goals.push({ team, scorer, assister }); },
    };
    await initializeWith({ async exposeFunction() {}, async evaluate(fn, payload) { fn(payload); } }, readFile, window, () => now);
    for (const player of players) room.onPlayerJoin(player);
    room.onGameStart(null);
    return {
        room, players, goals, reports,
        setTime(value) { now = value; },
        setBall({ x = 0, y = 0, xspeed = 0, yspeed = 0 } = {}) { Object.assign(ball, { x, y, xspeed, yspeed }); },
        setDisc(id, { x, y, xspeed = 0, yspeed = 0 } = {}) { Object.assign(discs.get(id), { x, y, xspeed, yspeed }); },
    };
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
    let ballDamping = 0.99;
    const roomPlayers = [];
    const room = {
        setCustomStadium(contents) {
            if (calls.length === 0) {
                assert.equal(contents, stadiumSource);
                assert.equal(this.onGameStart, undefined);
                assert.equal(typeof this.onStadiumChange, 'function', 'initial setter is observed');
                calls.push('stadium');
            } else {
                calls.push({ type: 'custom', source: contents });
            }
        },
        setDefaultStadium(name) { calls.push({ type: 'default', name }); },
        setScoreLimit(limit) { calls.push(['score', limit]); },
        setTimeLimit(limit) { calls.push(['time', limit]); },
        sendAnnouncement(message, target) { announcements.push({ message, target }); },
        getPlayerList() { return roomPlayers; },
        getDiscProperties() { return { damping: ballDamping }; },
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
                'builtinStadiums', 'competitionFactorySource', 'config', 'diagnosticsFactorySource', 'getPhysicsSource', 'goalAttributionFactorySource',
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
    assert.equal(typeof room.onPlayerChat, 'function');
    room.onStadiumChange('AAAAuto Arena', null);

    assert.equal(room.onPlayerChat({ id: 7, admin: false }, '!r info'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(announcements.map(item => item.message).join('\n'), /AAAAuto Arena/);
    assert.equal(room.onPlayerChat({ id: 7, admin: false }, '!rank'), false);
    assert.equal(statsCommands.length, 0, 'ordinary stats commands still require player auth');

    const firstPlayer = { id: 7, name: 'Test player', auth: 'valid-auth', admin: true };
    roomPlayers.push(firstPlayer);
    room.onPlayerJoin(firstPlayer);
    assert.match(announcements.filter(item => item.target === 7).map(item => item.message).join(' '), /!comp start.*!comp mode single.*!comp mode rematch/);
    const greetingCount = announcements.length;
    const secondPlayer = { id: 8, name: 'Second', auth: 'second-auth' };
    roomPlayers.push(secondPlayer);
    room.onPlayerJoin(secondPlayer);
    assert.equal(announcements.length, greetingCount, 'later joins do not repeat the greeting');
    roomPlayers.length = 0;
    assert.equal(room.onPlayerChat({ id: 7, admin: true }, '!rank'), false);
    assert.deepEqual(statsCommands, [{ auth: 'valid-auth', message: '!rank' }]);

    room.onStadiumChange('Rounded', { id: 7, admin: true });
    assert.equal(room.onPlayerChat({ id: 7, admin: true }, '!r'), false);
    const applied = JSON.parse(calls.find(call => call.type === 'custom').source);
    assert.equal(applied.name, 'Rounded');
    assert.ok([5.5, 5.75, 6, 6.25, 6.5, 6.75, 7].includes(applied.playerPhysics.kickStrength));
    assert.ok([0.985, 0.9875, 0.99].includes(applied.ballPhysics.damping));
    assert.doesNotMatch(announcements.map(item => item.message).join('\n'), /randomized/);
    ballDamping = applied.ballPhysics.damping;
    room.onStadiumChange('Rounded', null);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(announcements.map(item => item.message).join('\n'), /randomized/);

    assert.equal(room.onPlayerChat({ id: 7, admin: true }, '!r reset'), false);
    assert.deepEqual(calls.at(-1), { type: 'default', name: 'Rounded' });
    ballDamping = getStadiumPhysics((await loadBuiltinStadiums()).find(item => item.name === 'Rounded').source).damping;
    room.onStadiumChange('Rounded', null);
    await new Promise(resolve => setImmediate(resolve));

    room.onGameStart(null);
    assert.equal(room.onPlayerChat({ id: 7, admin: false }, '!r info'), false);
    const beforeActiveReset = calls.length;
    assert.equal(room.onPlayerChat({ id: 7, admin: true }, '!r reset'), false);
    assert.equal(calls.length, beforeActiveReset, 'a running match must not change stadium');
    await new Promise(resolve => setImmediate(resolve));
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

test('diagnostics are private, rate limited, and autosave the state before reset', async () => {
    const announcements = [], reports = [];
    const player = { id: 1, name: 'Player', team: 1 };
    const room = {
        setCustomStadium() {}, setScoreLimit() {}, setTimeLimit() {},
        sendAnnouncement(message, target) { announcements.push({ message, target }); },
        getPlayerList() { return [player]; }, getScores() { return { red: 1, blue: 0, time: 5 }; },
        getBallPosition() { return { x: 0, y: 0 }; },
        getDiscProperties() { return { x: 0, y: 0, radius: 10, xspeed: 1, yspeed: 2 }; },
        getPlayerDiscProperties() { return { x: 0, y: 0, radius: 15, xspeed: 0, yspeed: 0 }; },
    };
    let fail = false;
    const window = { HBInit: () => room, saveDiagnosticReport(report) {
        if (fail) throw new Error('disk failure');
        reports.push(report); return reports.length;
    } };
    await initializeWith({ async exposeFunction() {}, async evaluate(fn, payload) { fn(payload); } }, readFile, window);
    room.onGameStart(null);
    room.onPlayerBallKick(player);
    room.onPositionsReset();
    room.onGameTick();
    // Opponent scoring after an attacker contact creates an unknown result, with contact still present.
    room.onTeamGoal(2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].trigger, 'auto');
    assert.equal(reports[0].context.algorithm.currentTouch.playerId, 1);
    assert.equal(reports[0].attributionDecisions[0].attribution.type, 'unknown');
    assert.ok(reports[0].events.some(e => e.type === 'contact' && e.source === 'kick'));
    assert.ok(reports[0].events.some(e => e.type === 'contact' && e.source === 'proximity'));
    assert.equal(reports[0].snapshots.length, 1);
    assert.doesNotMatch(JSON.stringify(reports[0]), /playerAuth|"auth"/);
    const before = announcements.length;
    assert.equal(room.onPlayerChat(player, '!save test'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reports.length, 2);
    assert.equal(reports[1].trigger, 'manual');
    assert.equal(reports[1].context.algorithm.currentTouch, null);
    assert.deepEqual(announcements.slice(before), [{ message: 'Zapisano diagnostykę #2', target: 1 }]);
    assert.equal(room.onPlayerChat(player, '!save again'), false);
    assert.match(announcements.at(-1).message, /Odczekaj/);
    fail = true;
    assert.equal(room.onPlayerChat({ id: 2, name: 'Other' }, '!save error'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(announcements.at(-1).target, 2);
    assert.match(announcements.at(-1).message, /Nie udało/);
});

test('room callbacks separate tick contacts, discard kick-interval impulses, and preserve decision diagnostics', async () => {
    const harness = await createGoalAttributionRoom();
    const [attacker, defender] = harness.players;

    // Establish the pre-kick physics endpoint with no contact.
    harness.setTime(1000);
    harness.room.onGameTick();
    harness.setTime(1008);
    harness.room.onPlayerBallKick(attacker);
    harness.setDisc(defender.id, { x: 12, y: 0 });
    harness.setBall({ xspeed: 5, yspeed: 0 });
    harness.setTime(1016);
    harness.room.onGameTick();
    harness.setTime(1100);
    harness.room.onTeamGoal(1);

    assert.equal(harness.goals.length, 1);
    assert.equal(harness.goals[0].scorer.name, 'Attacker');
    assert.equal(harness.goals[0].assister, null);
    assert.equal(harness.goals[0].scorer.auth, 'private-auth-a');

    // Goal history must retain the pre-reset candidate/evidence, while the
    // subsequent manual report remains private and contains no auth values.
    assert.equal(harness.room.onPlayerChat(attacker, '!save post-goal'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.reports.length, 1);
    const report = harness.reports[0];
    const decision = report.attributionDecisions.at(-1).attribution;
    assert.equal(decision.scorer.name, 'Attacker');
    assert.equal(decision.candidateReason, 'explicit-kick');
    assert.equal(decision.evidence.reason, 'velocity-ignored-kick-in-sampling-interval');
    assert.equal(report.context.algorithm.responsibleTouch, null, 'current state was cleared after goal');
    assert.doesNotMatch(JSON.stringify(report), /private-auth|playerAuth|"auth"/);
});

test('a later independent redirected-contact interval is not hidden by a kick cooldown', async () => {
    const harness = await createGoalAttributionRoom();
    const [attacker, defender] = harness.players;
    harness.setTime(1000);
    harness.room.onGameTick();
    harness.setTime(1008);
    harness.room.onPlayerBallKick(attacker);
    harness.setDisc(defender.id, { x: 12, y: 0 });
    harness.setBall({ xspeed: 5, yspeed: 0 });
    harness.setTime(1016);
    harness.room.onGameTick(); // Kick interval is rejected.
    harness.setDisc(defender.id, { x: 10, y: 1 });
    harness.setBall({ xspeed: -3, yspeed: 4 });
    harness.setTime(1032);
    harness.room.onGameTick(); // New continuous interval supports a redirect.
    harness.setTime(1040);
    harness.room.onTeamGoal(1);

    assert.equal(harness.goals[0].scorer.name, 'Defender');
    assert.equal(harness.goals[0].scorer.team, 2);
});

test('room tick callbacks end a proximity session at a no-contact sample without losing the scorer', async () => {
    const harness = await createGoalAttributionRoom();
    const [attacker, defender] = harness.players;
    harness.setTime(1000);
    harness.room.onGameTick();
    harness.setTime(1008);
    harness.room.onPlayerBallKick(attacker);
    harness.setDisc(defender.id, { x: 12, y: 0 });
    harness.setTime(1016);
    harness.room.onGameTick();
    harness.setDisc(defender.id, { x: 100, y: 100 });
    harness.setTime(1032);
    harness.room.onGameTick(); // Explicit no-contact tick closes the first session.
    harness.setDisc(defender.id, { x: 12, y: 0 });
    harness.setTime(5000);
    harness.room.onGameTick(); // A later brief contact starts a new session.
    harness.setTime(5100);
    harness.room.onTeamGoal(1);

    assert.equal(harness.goals[0].scorer.name, 'Attacker');
    assert.equal(harness.goals[0].scorer.team, 1);
    assert.equal(harness.room.onPlayerChat(attacker, '!save after-gap'), false);
    await new Promise(resolve => setImmediate(resolve));
    const decision = harness.reports.at(-1).attributionDecisions.at(-1).attribution;
    assert.equal(decision.candidateReason, 'explicit-kick');
    assert.equal(harness.reports.at(-1).context.algorithm.responsibleTouch, null);
});

test('pause and unpause callbacks invalidate physics continuity without clearing responsibility', async () => {
    const harness = await createGoalAttributionRoom();
    const [attacker, defender] = harness.players;
    harness.setTime(1000);
    harness.room.onGameTick();
    harness.setTime(1008);
    harness.room.onPlayerBallKick(attacker);
    harness.setDisc(defender.id, { x: 12, y: 0 });
    harness.setBall({ xspeed: 5, yspeed: 0 });
    harness.setTime(1016);
    harness.room.onGameTick();
    harness.room.onGamePause();
    harness.room.onGameUnpause();
    harness.setDisc(defender.id, { x: 10, y: 1 });
    harness.setBall({ xspeed: -3, yspeed: 4 });
    harness.setTime(1032);
    harness.room.onGameTick();
    harness.setTime(1040);
    harness.room.onTeamGoal(1);

    assert.equal(harness.goals[0].scorer.name, 'Attacker');
    assert.equal(harness.reports.length, 0);
    assert.equal(harness.room.onPlayerChat(attacker, '!save pause-boundary'), false);
    await new Promise(resolve => setImmediate(resolve));
    const report = harness.reports[0];
    const decision = report.attributionDecisions.at(-1).attribution;
    assert.equal(decision.candidateEvidence.reason, 'explicit-kick');
    assert.ok(report.events.some(event => event.type === 'gamePause'));
    assert.ok(report.events.some(event => event.type === 'gameUnpause'));
});

test('multiple room contacts make physical attribution ambiguous instead of transferring on proximity alone', async () => {
    const harness = await createGoalAttributionRoom();
    const [attacker, defender, defender2] = harness.players;
    harness.setTime(1000);
    harness.room.onGameTick();
    harness.setTime(1008);
    harness.room.onPlayerBallKick(attacker);
    harness.setDisc(defender.id, { x: 12, y: 0 });
    harness.setDisc(defender2.id, { x: 13, y: 0 });
    harness.setTime(1016);
    harness.room.onGameTick();
    harness.setBall({ xspeed: 5, yspeed: 0 });
    harness.setTime(1032);
    harness.room.onGameTick();
    harness.setTime(1040);
    harness.room.onTeamGoal(1);
    assert.equal(harness.goals[0].scorer.name, 'Attacker');
});
