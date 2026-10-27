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

function makeRandomizer({ isGameRunning = false, randomValues = [] } = {}) {
    let running = isGameRunning;
    let randomIndex = 0;
    let randomizer;
    const calls = [];
    const room = {
        setCustomStadium(source) {
            calls.push({ type: 'custom', source });
            const name = JSON.parse(source).name;
            randomizer.onStadiumChange(name, null);
        },
        setDefaultStadium(name) {
            calls.push({ type: 'default', name });
            randomizer.onStadiumChange(name, null);
        },
        getDiscProperties() {
            return { damping: 0.99 };
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
    });
    return {
        randomizer,
        calls,
        setRunning(value) { running = value; },
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

test('repeated randomization always starts from the selected original template', () => {
    const harness = makeRandomizer({ randomValues: [0, 0, 0.99, 0.99] });
    harness.randomizer.onStadiumChange('Rounded', { id: 7, admin: true });

    const firstResponse = harness.randomizer.handleCommand({ id: 7, admin: true }, '!r');
    const first = JSON.parse(harness.calls[0].source);
    const secondResponse = harness.randomizer.handleCommand({ id: 7, admin: true }, '!r');
    const second = JSON.parse(harness.calls[1].source);

    assert.match(firstResponse, /1\.10x/);
    assert.match(secondResponse, /1\.30x/);
    assert.equal(first.playerPhysics.kickStrength, 5.5);
    assert.equal(first.ballPhysics.damping, 0.985);
    assert.equal(second.playerPhysics.kickStrength, 6.5);
    assert.equal(second.ballPhysics.damping, 0.99);
    assert.deepEqual(removeRandomizedFields(first, sourceDefinitions.find(item => item.name === 'Rounded').definition), sourceDefinitions.find(item => item.name === 'Rounded').definition);
    assert.deepEqual(removeRandomizedFields(second, sourceDefinitions.find(item => item.name === 'Rounded').definition), sourceDefinitions.find(item => item.name === 'Rounded').definition);
    assert.equal(harness.randomizer.getState().stadium, 'Rounded');
    assert.equal(harness.randomizer.getState().randomized, true);
});

test('manual selection clears randomized state while programmatic changes preserve the base stadium', () => {
    const harness = makeRandomizer({ randomValues: [0, 0, 0.5, 0.5] });
    harness.randomizer.onStadiumChange('Rounded', { id: 7 });
    harness.randomizer.handleCommand({ admin: true }, '!randomize');

    harness.randomizer.onStadiumChange('Rounded', null);
    assert.equal(harness.randomizer.getState().stadium, 'Rounded');
    assert.equal(harness.randomizer.getState().randomized, true);

    harness.randomizer.onStadiumChange('Small', { id: 8 });
    assert.equal(harness.randomizer.getState().stadium, 'Small');
    assert.equal(harness.randomizer.getState().randomized, false);
    assert.deepEqual(harness.randomizer.getState().physics, {
        kickStrength: 5,
        kickMultiplier: 1,
        damping: 0.99,
    });

    harness.randomizer.handleCommand({ admin: true }, '!r');
    assert.equal(JSON.parse(harness.calls.at(-1).source).name, 'Small');
});

test('reset restores built-ins through setDefaultStadium and AAAAuto Arena from its original file', () => {
    const builtin = makeRandomizer({ randomValues: [0, 0] });
    builtin.randomizer.onStadiumChange('Rounded', { id: 7 });
    builtin.randomizer.handleCommand({ admin: true }, '!r');
    assert.match(builtin.randomizer.handleCommand({ admin: true }, '!r reset'), /original physics restored/);
    assert.deepEqual(builtin.calls.at(-1), { type: 'default', name: 'Rounded' });
    assert.equal(builtin.randomizer.getState().randomized, false);
    assert.deepEqual(builtin.randomizer.getState().physics, { kickStrength: 5, kickMultiplier: 1, damping: 0.99 });

    const custom = makeRandomizer({ randomValues: [0, 0] });
    custom.randomizer.handleCommand({ admin: true }, '!r');
    assert.match(custom.randomizer.handleCommand({ admin: true }, '!r reset'), /original physics restored/);
    assert.deepEqual(custom.calls.at(-1), { type: 'custom', source: customSource });
    assert.equal(custom.randomizer.getState().randomized, false);
    assert.deepEqual(custom.randomizer.getState().physics, { kickStrength: 6.5, kickMultiplier: 1.3, damping: 0.99 });
});

test('only a real HaxBall admin can change physics; auth alone does not grant access', () => {
    const harness = makeRandomizer({ randomValues: [0, 0] });
    const unauthenticatedAdmin = { id: 1, auth: null, admin: true };
    const authenticatedPlayer = { id: 2, auth: 'valid-auth', admin: false };

    assert.match(harness.randomizer.handleCommand(authenticatedPlayer, '!r'), /Only admins/);
    assert.match(harness.randomizer.handleCommand(authenticatedPlayer, '!r reset'), /Only admins/);
    assert.equal(harness.calls.length, 0);
    assert.match(harness.randomizer.handleCommand(unauthenticatedAdmin, '!r'), /randomized/);
    assert.equal(harness.calls.length, 1);
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

test('aliases are exact and !r does not conflict with !rank', () => {
    const harness = makeRandomizer();
    assert.equal(harness.randomizer.handleCommand({ admin: true }, '!rank'), null);
    assert.equal(harness.randomizer.handleCommand({ admin: true }, '!ranks'), null);
    assert.equal(harness.randomizer.handleCommand({ admin: true }, '!randomizer'), null);
    assert.equal(harness.randomizer.handleCommand({ admin: true }, '!r unexpected'), null);
    assert.match(harness.randomizer.handleCommand({ admin: false }, '!r info'), /AAAAuto Arena/);
    assert.match(harness.randomizer.handleCommand({ admin: true }, '!r'), /randomized/);
    assert.match(harness.randomizer.handleCommand({ admin: true }, '!randomize reset'), /original physics restored/);
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
