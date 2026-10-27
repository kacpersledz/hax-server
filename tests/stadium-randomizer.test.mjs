import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomizeStadiumDefinition, getStadiumPhysics, KICK_MULTIPLIERS, KICK_STRENGTHS, BALL_DAMPING_VALUES } from '../stadiums/randomizer.mjs';
import { loadBuiltinStadiums } from '../haxball.mjs';

const builtins = await loadBuiltinStadiums();
const customSource = await readFile(new URL('../stadiums/rounded-fast.hbs', import.meta.url), 'utf8');
const customDefinition = JSON.parse(customSource);
const sourceDefinitions = [
    ...builtins.map(({ name, source }) => ({ name, source, definition: JSON.parse(source) })),
    { name: 'AAAAuto Arena', source: customSource, definition: customDefinition },
];

function randomFor(kickIndex, dampingIndex) {
    let call = 0;
    return () => call++ === 0
        ? (kickIndex + 0.5) / KICK_MULTIPLIERS.length
        : (dampingIndex + 0.5) / BALL_DAMPING_VALUES.length;
}

function removeRandomizedFields(randomized, original) {
    const normalized = JSON.parse(JSON.stringify(randomized));
    if (original.playerPhysics === undefined) {
        delete normalized.playerPhysics.kickStrength;
        if (Object.keys(normalized.playerPhysics).length === 0) delete normalized.playerPhysics;
    } else if (Object.hasOwn(original.playerPhysics, 'kickStrength')) {
        normalized.playerPhysics.kickStrength = original.playerPhysics.kickStrength;
    } else {
        delete normalized.playerPhysics.kickStrength;
    }

    if (original.ballPhysics === undefined) {
        delete normalized.ballPhysics;
    } else if (original.ballPhysics === 'disc0') {
        if (Object.hasOwn(original.discs[0], 'damping')) {
            normalized.discs[0].damping = original.discs[0].damping;
        } else {
            delete normalized.discs[0].damping;
        }
    } else if (Object.hasOwn(original.ballPhysics, 'damping')) {
        normalized.ballPhysics.damping = original.ballPhysics.damping;
    } else {
        delete normalized.ballPhysics.damping;
    }
    return normalized;
}

function makeRandomizer({ isGameRunning = false, randomValues = [], throwOnSet = false } = {}) {
    let running = isGameRunning;
    let randomIndex = 0;
    let randomizer;
    let damping = 0.99;
    let nextTimerId = 0;
    const timers = new Map();
    const calls = [];
    const room = {
        setCustomStadium(source) {
            calls.push({ type: 'custom', source });
            if (throwOnSet) throw new Error('setter failed');
        },
        setDefaultStadium(name) {
            calls.push({ type: 'default', name });
            if (throwOnSet) throw new Error('setter failed');
        },
        getDiscProperties() {
            return { damping };
        },
    };
    randomizer = createRandomizer({
        room,
        builtinStadiums: builtins,
        customStadiumSource: customSource,
        randomizeDefinition: randomizeStadiumDefinition,
        getPhysics: getStadiumPhysics,
        isGameRunning: () => running,
        random: () => randomValues[randomIndex++] ?? 0,
        confirmationTimeoutMs: 100,
        confirmationPollMs: 10,
        schedule(callback, delay) {
            const id = ++nextTimerId;
            timers.set(id, { callback, delay });
            return id;
        },
        cancelSchedule(id) { timers.delete(id); },
    });
    return {
        randomizer,
        calls,
        setRunning(value) { running = value; },
        setDamping(value) { damping = value; },
        confirm(name, value = damping) {
            damping = value;
            randomizer.onStadiumChange(name, null);
        },
        runTimeout() {
            const timer = [...timers.entries()].find(([, value]) => value.delay === 100);
            assert.ok(timer, 'pending operation should have a timeout');
            timers.delete(timer[0]);
            timer[1].callback();
        },
        runPoll() {
            const timer = [...timers.entries()].find(([, value]) => value.delay === 10);
            assert.ok(timer, 'pending operation should have a damping poll');
            timers.delete(timer[0]);
            timer[1].callback();
        },
    };
}

import { createStadiumRandomizer as createRandomizer } from '../stadiums/randomizer.mjs';

test('every supported stadium randomizes only kick strength and ball damping', () => {
    for (const { name, source, definition } of sourceDefinitions) {
        const snapshot = JSON.stringify(definition);
        const result = randomizeStadiumDefinition(source, randomFor(3, 1));

        assert.equal(result.stadium.name, name);
        assert.equal(result.kickMultiplier, 1.25);
        assert.equal(result.kickStrength, 6.25);
        assert.equal(result.damping, 0.9875);
        assert.deepEqual(getStadiumPhysics(result.stadium), {
            kickStrength: 6.25,
            kickMultiplier: 1.25,
            damping: 0.9875,
        });
        assert.deepEqual(removeRandomizedFields(result.stadium, definition), definition);
        assert.equal(JSON.stringify(definition), snapshot, `${name} source was mutated`);
    }
});

test('all discrete random parameters are selectable and stay within the requested values', () => {
    for (let kickIndex = 0; kickIndex < KICK_MULTIPLIERS.length; kickIndex++) {
        for (let dampingIndex = 0; dampingIndex < BALL_DAMPING_VALUES.length; dampingIndex++) {
            const result = randomizeStadiumDefinition(sourceDefinitions[0].source, randomFor(kickIndex, dampingIndex));
            assert.equal(result.kickMultiplier, KICK_MULTIPLIERS[kickIndex]);
            assert.equal(result.kickStrength, KICK_STRENGTHS[kickIndex]);
            assert.equal(result.damping, BALL_DAMPING_VALUES[dampingIndex]);
        }
    }
});

test('ball damping supports omitted ballPhysics, disc0, and an explicit ballPhysics object', () => {
    const definitions = [
        { name: 'Default ball', vertexes: [], segments: [], goals: [], discs: [] },
        { name: 'First disc is ball', ballPhysics: 'disc0', discs: [{ cGroup: ['ball'], radius: 10 }] },
        { name: 'Explicit ball', ballPhysics: { radius: 12, invMass: 2, bCoef: 0.4 }, discs: [] },
    ];

    for (const definition of definitions) {
        const result = randomizeStadiumDefinition(definition, randomFor(0, 2));
        assert.equal(getStadiumPhysics(result.stadium).damping, 0.99);
        assert.equal(result.damping, 0.99);
    }

    const disc0 = randomizeStadiumDefinition(definitions[1], randomFor(0, 0)).stadium;
    assert.equal(disc0.discs[0].damping, 0.985);
    assert.equal(disc0.discs[0].radius, 10);
    assert.deepEqual(disc0.discs[0].cGroup, ['ball']);

    const explicit = randomizeStadiumDefinition(definitions[2], randomFor(0, 1)).stadium;
    assert.equal(explicit.ballPhysics.damping, 0.9875);
    assert.equal(explicit.ballPhysics.radius, 12);
    assert.equal(explicit.ballPhysics.invMass, 2);
    assert.equal(explicit.ballPhysics.bCoef, 0.4);
});

test('randomization waits for asynchronous onStadiumChange confirmation and uses the original template each time', async () => {
    const harness = makeRandomizer({ randomValues: [0, 0, 0.99, 0.99] });
    harness.randomizer.onStadiumChange('Rounded', { id: 7, admin: true });

    let resolved = false;
    const firstResponse = harness.randomizer.handleCommand({ id: 7, admin: true }, '!r').then(value => {
        resolved = true;
        return value;
    });
    const first = JSON.parse(harness.calls[0].source);
    await Promise.resolve();
    assert.equal(resolved, false, 'success must not be announced before confirmation');
    assert.equal(harness.randomizer.getState().randomized, false);
    harness.confirm('Rounded', first.ballPhysics.damping);
    assert.match(await firstResponse, /1\.10x/);

    const secondResponse = harness.randomizer.handleCommand({ id: 7, admin: true }, '!r');
    const second = JSON.parse(harness.calls[1].source);
    harness.confirm('Rounded', second.ballPhysics.damping);
    assert.match(await secondResponse, /1\.30x/);
    assert.equal(first.playerPhysics.kickStrength, 5.5);
    assert.equal(first.ballPhysics.damping, 0.985);
    assert.equal(second.playerPhysics.kickStrength, 6.5);
    assert.equal(second.ballPhysics.damping, 0.99);
    const original = sourceDefinitions.find(item => item.name === 'Rounded').definition;
    assert.deepEqual(removeRandomizedFields(first, original), original);
    assert.deepEqual(removeRandomizedFields(second, original), original);
    assert.equal(harness.randomizer.getState().stadium, 'Rounded');
    assert.equal(harness.randomizer.getState().randomized, true);
});

test('an ignored setter times out without committing randomized state', async () => {
    const harness = makeRandomizer();
    const response = harness.randomizer.handleCommand({ admin: true }, '!r');
    assert.equal(harness.randomizer.getState().randomized, false);
    assert.equal(harness.randomizer.getState().pending, true);
    harness.randomizer.onStadiumChange('Small', null);
    assert.equal(harness.randomizer.getState().pending, true, 'a different stadium event cannot confirm the request');
    harness.runTimeout();
    assert.match(await response, /not confirmed/);
    assert.equal(harness.randomizer.getState().randomized, false);
    assert.equal(harness.randomizer.getState().pending, false);
    assert.equal(harness.randomizer.getState().unconfirmed, true);
});

test('live damping transition can confirm a same-name custom reload if no event is emitted', async () => {
    const harness = makeRandomizer({ randomValues: [0, 0] });
    const response = harness.randomizer.handleCommand({ admin: true }, '!r');
    harness.setDamping(0.985);
    harness.runPoll();
    assert.match(await response, /confirmed by live ball damping/);
    assert.equal(harness.randomizer.getState().randomized, true);
});

test('manual selection cancels a pending operation and late programmatic events do not alter its base', async () => {
    const harness = makeRandomizer({ randomValues: [0, 0, 0.5, 0.5] });
    const response = harness.randomizer.handleCommand({ admin: true }, '!randomize');
    assert.equal(harness.randomizer.getState().randomized, false);
    harness.randomizer.onStadiumChange('Small', { id: 8 });
    assert.match(await response, /canceled/);
    assert.equal(harness.randomizer.getState().stadium, 'Small');
    assert.equal(harness.randomizer.getState().randomized, false);

    const next = harness.randomizer.handleCommand({ admin: true }, '!r');
    const definition = JSON.parse(harness.calls.at(-1).source);
    assert.equal(definition.name, 'Small');
    harness.randomizer.onStadiumChange('AAAAuto Arena', null);
    assert.equal(harness.randomizer.getState().stadium, 'Small');
    assert.equal(harness.randomizer.getState().pending, true, 'a stale event for another stadium must not resolve the new request');
    harness.confirm('Small', definition.ballPhysics.damping);
    assert.match(await next, /randomized/);
});

test('a cancelled same-target request cannot be completed by an indistinguishable stale event', async () => {
    const harness = makeRandomizer({ randomValues: [0, 0, 0, 0] });
    const canceled = harness.randomizer.handleCommand({ admin: true }, '!r');
    harness.randomizer.onStadiumChange('AAAAuto Arena', { id: 8 });
    assert.match(await canceled, /canceled/);

    const blocked = await harness.randomizer.handleCommand({ admin: true }, '!r');
    assert.match(blocked, /earlier request.*late event/);
    assert.equal(harness.calls.length, 1);

    harness.randomizer.onStadiumChange('AAAAuto Arena', null);
    const retry = harness.randomizer.handleCommand({ admin: true }, '!r');
    const definition = JSON.parse(harness.calls.at(-1).source);
    harness.confirm('AAAAuto Arena', definition.discs[0].damping);
    assert.match(await retry, /randomized/);
});

test('a match starting cancels the pending request without stopping or restarting the game', async () => {
    const harness = makeRandomizer();
    const response = harness.randomizer.handleCommand({ admin: true }, '!r');
    harness.setRunning(true);
    harness.randomizer.onGameStart();
    assert.match(await response, /Match started before the stadium change was confirmed/);
    assert.equal(harness.randomizer.getState().randomized, false);
    assert.equal(harness.randomizer.getState().pending, false);
    assert.match(harness.randomizer.handleCommand({ admin: true }, '!r'), /Stop the match/);
    assert.equal(harness.calls.length, 1);
});

test('concurrent mutation commands cannot invoke overlapping setters', async () => {
    const harness = makeRandomizer();
    const first = harness.randomizer.handleCommand({ admin: true }, '!r');
    assert.match(harness.randomizer.handleCommand({ admin: true }, '!r reset'), /already awaiting confirmation/);
    assert.equal(harness.calls.length, 1);
    const definition = JSON.parse(harness.calls[0].source);
    harness.confirm('AAAAuto Arena', definition.discs[0].damping);
    await first;
    assert.equal(harness.calls.length, 1);
});

test('reset commits original physics only after stadium confirmation', async () => {
    const builtin = makeRandomizer({ randomValues: [0, 0] });
    builtin.randomizer.onStadiumChange('Rounded', { id: 7 });
    const apply = builtin.randomizer.handleCommand({ admin: true }, '!r');
    const applied = JSON.parse(builtin.calls.at(-1).source);
    builtin.confirm('Rounded', applied.ballPhysics.damping);
    await apply;

    const reset = builtin.randomizer.handleCommand({ admin: true }, '!r reset');
    assert.deepEqual(builtin.calls.at(-1), { type: 'default', name: 'Rounded' });
    assert.equal(builtin.randomizer.getState().randomized, true, 'reset waits for its confirmation');
    builtin.confirm('Rounded', getStadiumPhysics(sourceDefinitions.find(item => item.name === 'Rounded').source).damping);
    assert.match(await reset, /original physics restored/);
    assert.equal(builtin.randomizer.getState().randomized, false);

    const custom = makeRandomizer({ randomValues: [0, 0] });
    const customApply = custom.randomizer.handleCommand({ admin: true }, '!r');
    const customApplied = JSON.parse(custom.calls.at(-1).source);
    custom.confirm('AAAAuto Arena', customApplied.discs[0].damping);
    await customApply;
    const customReset = custom.randomizer.handleCommand({ admin: true }, '!r reset');
    assert.deepEqual(custom.calls.at(-1), { type: 'custom', source: customSource });
    custom.confirm('AAAAuto Arena', getStadiumPhysics(customSource).damping);
    assert.match(await customReset, /original physics restored/);
    assert.equal(custom.randomizer.getState().randomized, false);
});

test('setter exceptions report failure and preserve the last confirmed state', async () => {
    const harness = makeRandomizer({ throwOnSet: true });
    const response = harness.randomizer.handleCommand({ admin: true }, '!r');
    assert.match(await response, /Could not randomize AAAAuto Arena: setter failed/);
    assert.equal(harness.randomizer.getState().randomized, false);
    assert.equal(harness.randomizer.getState().pending, false);
});

test('only a real HaxBall admin can change physics; auth alone does not grant access', async () => {
    const harness = makeRandomizer({ randomValues: [0, 0] });
    const unauthenticatedAdmin = { id: 1, auth: null, admin: true };
    const authenticatedPlayer = { id: 2, auth: 'valid-auth', admin: false };

    assert.match(harness.randomizer.handleCommand(authenticatedPlayer, '!r'), /Only admins/);
    assert.match(harness.randomizer.handleCommand(authenticatedPlayer, '!r reset'), /Only admins/);
    assert.equal(harness.calls.length, 0);
    const response = harness.randomizer.handleCommand(unauthenticatedAdmin, '!r');
    const applied = JSON.parse(harness.calls[0].source);
    harness.confirm('AAAAuto Arena', applied.discs[0].damping);
    assert.match(await response, /randomized/);
});

test('randomize and reset are rejected while running or paused, but info remains available', () => {
    for (const matchState of ['running', 'paused']) {
        const harness = makeRandomizer({ isGameRunning: true, randomValues: [0, 0] });
        assert.match(harness.randomizer.handleCommand({ admin: true }, '!r'), /Stop the match/);
        assert.match(harness.randomizer.handleCommand({ admin: true }, '!r reset'), /Stop the match/);
        assert.match(harness.randomizer.handleCommand({ admin: false }, '!r info'), /AAAAuto Arena/);
        assert.equal(harness.calls.length, 0, `${matchState} match must not be changed`);
    }
});

test('aliases are exact and !r does not conflict with !rank', async () => {
    const harness = makeRandomizer();
    assert.equal(harness.randomizer.handleCommand({ admin: true }, '!rank'), null);
    assert.equal(harness.randomizer.handleCommand({ admin: true }, '!ranks'), null);
    assert.equal(harness.randomizer.handleCommand({ admin: true }, '!randomizer'), null);
    assert.equal(harness.randomizer.handleCommand({ admin: true }, '!r unexpected'), null);
    assert.match(harness.randomizer.handleCommand({ admin: false }, '!r info'), /AAAAuto Arena/);
    const apply = harness.randomizer.handleCommand({ admin: true }, '!r');
    const applied = JSON.parse(harness.calls.at(-1).source);
    harness.confirm('AAAAuto Arena', applied.discs[0].damping);
    assert.match(await apply, /randomized/);
    const reset = harness.randomizer.handleCommand({ admin: true }, '!randomize reset');
    harness.confirm('AAAAuto Arena', getStadiumPhysics(customSource).damping);
    assert.match(await reset, /original physics restored/);
});

test('unsupported custom stadiums get a clear error and never use another template', () => {
    const harness = makeRandomizer();
    harness.randomizer.onStadiumChange('Community Tournament Map', { id: 3, admin: true });

    assert.match(harness.randomizer.handleCommand({ admin: true }, '!r'), /unsupported custom stadium: Community Tournament Map/);
    assert.match(harness.randomizer.handleCommand({ admin: true }, '!r reset'), /unsupported custom stadium/);
    const info = harness.randomizer.handleCommand({ admin: false }, '!r info');
    assert.match(info, /Community Tournament Map/);
    assert.match(info, /Kick: unknown/);
    assert.match(info, /Damping: 0\.99/);
    assert.equal(harness.calls.length, 0);
});
