import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalAttributionEngine } from '../stats/goal-attribution.mjs';

const RED = 1;
const BLUE = 2;
const P = {
    A: { playerId: 1, playerAuth: 'auth-a', playerName: 'A', playerTeam: RED },
    B: { playerId: 2, playerAuth: 'auth-b', playerName: 'B', playerTeam: RED },
    D: { playerId: 4, playerAuth: 'auth-d', playerName: 'D', playerTeam: BLUE },
};
const touch = (player, timestamp, source = 'kick') => ({
    ...player,
    timestamp,
    matchTime: timestamp / 1000,
    position: { x: timestamp, y: 0 },
    source,
});
const engine = (options = {}) => new GoalAttributionEngine({
    assistTimeWindowMs: 3000,
    maxGoalTouchAgeMs: 3000,
    ...options,
});

test('direct goal without assist', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, false);
    assert.equal(result.reason, 'last-touch-scoring-team');
});

test('simple assist uses the previous different scoring-team player', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.B, 1500));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1700 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
});

test('repeated scorer touches do not destroy an assist', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.B, 1200));
    e.recordTouch(touch(P.B, 1400, 'proximity'));
    e.recordTouch(touch(P.B, 1600));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1800 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
    assert.equal(e.getTouches().length, 2);
});

test('does not award a self-assist', () => {
    const e = engine();
    e.recordTouch(touch(P.B, 1000));
    e.recordTouch(touch(P.B, 1200));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1400 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
});

test('attacker kick then defender proximity is the attacker goal, not an own goal', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'kick'));
    e.recordTouch(touch(P.D, 1200, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1400 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, false);
    assert.equal(result.reason, 'opponent-proximity-deflection');
    assert.equal(result.assistReason, 'assist-blocked-by-opponent');
});

test('latest attacker before a defender proximity scores without an assist across the deflection', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.B, 1200));
    e.recordTouch(touch(P.D, 1400, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1600 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, false);
});

test('a run of defender-only proximity deflections still preserves the recent attacker', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.D, 1200, 'proximity'));
    e.recordTouch(touch({ ...P.D, playerId: 5, playerName: 'E' }, 1300, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1500 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, false);
});

test('attacker then defender kick is a defender own goal', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.D, 1200));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1400 });

    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, true);
    assert.equal(result.reason, 'opponent-kick-own-goal');
});

test('an opponent touch blocks an assist', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.D, 1200, 'proximity'));
    e.recordTouch(touch(P.B, 1400));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1600 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-blocked-by-opponent');
});

test('proximity followed by a kick upgrades the current logical touch to kick', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'proximity'));
    e.recordTouch(touch(P.A, 1050, 'kick'));
    const touches = e.getTouches();

    assert.equal(touches.length, 1);
    assert.equal(touches[0].source, 'kick');
    assert.equal(touches[0].timestamp, 1050);
});

test('a proximity contact after a kick does not downgrade the current touch', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'kick'));
    e.recordTouch(touch(P.A, 1050, 'proximity'));
    const touches = e.getTouches();

    assert.equal(touches.length, 1);
    assert.equal(touches[0].source, 'kick');
    assert.equal(touches[0].timestamp, 1050);
});

test('repeated same-player proximity contacts do not pollute the logical sequence', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'proximity'));
    e.recordTouch(touch(P.A, 1100, 'proximity'));
    e.recordTouch(touch(P.A, 1200, 'proximity'));
    e.recordTouch(touch(P.B, 1300, 'proximity'));
    e.recordTouch(touch(P.B, 1400, 'proximity'));
    e.recordTouch(touch(P.B, 1500, 'proximity'));
    const touches = e.getTouches();

    assert.equal(touches.length, 2);
    assert.deepEqual(touches.map(entry => entry.playerName), ['A', 'B']);
    assert.equal(touches[1].timestamp, 1500);
});

test('a stale touch produces an unknown scorer', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 5000 });

    assert.equal(result.type, 'unknown');
    assert.equal(result.scorer, null);
    assert.equal(result.reason, 'no-recent-scoring-touch');
});

test('a post or crossbar bounce without a player touch preserves the scorer', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1800 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
});

test('reset after a goal clears attribution for the next play', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });
    e.resetPlay();
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1400 });

    assert.equal(result.type, 'unknown');
    assert.equal(e.getTouches().length, 0);
});

test('resetMatch also clears attribution', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    e.resetMatch();

    assert.equal(e.resolveGoal({ scoringTeam: RED, timestamp: 1200 }).type, 'unknown');
});

test('selects the closest simultaneous proximity contact deterministically', () => {
    const e = engine();
    const input = {
        ballPosition: { x: 0, y: 0 },
        ballRadius: 10,
        timestamp: 1000,
        players: [
            { id: 2, team: RED, disc: { x: 12, y: 0 }, playerRadius: 5 },
            { id: 1, team: RED, disc: { x: 11, y: 0 }, playerRadius: 5 },
        ],
    };

    assert.equal(e.selectClosestContact(input).player.id, 1);
    assert.equal(e.selectClosestContact({ ...input, players: input.players.slice().reverse() }).player.id, 1);
});

test('an effectively tied proximity contact prefers the recent kicker', () => {
    const e = engine();
    e.recordTouch(touch(P.B, 1000, 'kick'));
    const contact = e.selectClosestContact({
        ballPosition: { x: 0, y: 0 },
        ballRadius: 10,
        timestamp: 1100,
        players: [
            { id: 1, team: RED, disc: { x: 10, y: 0 }, playerRadius: 5 },
            { id: 2, team: RED, disc: { x: 10.005, y: 0 }, playerRadius: 5 },
        ],
    });

    assert.equal(contact.player.id, 2);
});

test('a player without auth can still be attributed safely', () => {
    const e = engine();
    e.recordTouch(touch({ ...P.A, playerAuth: null, playerName: 'NoAuth' }, 1000));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1100 });

    assert.equal(result.scorer.name, 'NoAuth');
    assert.equal(result.scorer.auth, null);
});

test('team identity is snapshotted at touch time', () => {
    const e = engine();
    const player = { ...P.A };
    e.recordTouch(touch(player, 1000));
    player.playerTeam = BLUE;
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1100 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.team, RED);
});

test('an opponent proximity touch without a recent scoring-team touch stays unknown', () => {
    const e = engine();
    e.recordTouch(touch(P.D, 1000, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });

    assert.equal(result.type, 'unknown');
    assert.equal(result.scorer, null);
    assert.equal(result.isOwnGoal, false);
});

test('assist window is measured from passer touch to scorer touch', () => {
    const e = engine({ assistTimeWindowMs: 3000 });
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.B, 3500));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 4300 });

    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
});

test('assist expires when passer to scorer touch exceeds the window', () => {
    const e = engine({ assistTimeWindowMs: 3000 });
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.B, 4500));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 4600 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-expired');
});
