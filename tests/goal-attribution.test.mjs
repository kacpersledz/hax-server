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

test('a long scorer dribble preserves the assist from the takeover transition', () => {
    const e = engine({ assistTimeWindowMs: 3000 });
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.B, 1500));
    e.recordTouch(touch(P.B, 2200, 'proximity'));
    e.recordTouch(touch(P.B, 3000, 'proximity'));
    e.recordTouch(touch(P.B, 4000, 'proximity'));
    e.recordTouch(touch(P.B, 4050, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 4100 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
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
    assert.equal(result.reason, 'last-touch-scoring-team');
    assert.equal(result.assistReason, 'no-assist-candidate');
});

test('latest attacker before a defender proximity scores without an assist across the deflection', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.B, 1200));
    e.recordTouch(touch(P.D, 1400, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1600 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
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

test('a recent defender kick is a defender own goal', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 900));
    e.recordTouch(touch(P.D, 1800));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1900 });

    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, true);
    assert.equal(result.reason, 'opponent-kick-own-goal');
});

test('an old defender kick remains responsible after proximity and elapsed time', () => {
    const e = engine();
    e.recordTouch(touch(P.D, 1000, 'kick'));
    e.recordTouch(touch(P.D, 1800, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1900 });
    const [defenderTouch] = e.getTouches();

    assert.equal(result.type, 'own_goal');
    assert.equal(result.isOwnGoal, true);
    assert.equal(defenderTouch.firstTouchTimestamp, 1000);
    assert.equal(defenderTouch.lastTouchTimestamp, 1800);
    assert.equal(defenderTouch.lastKickTimestamp, 1000);
});

test('an old defender kick remains an own goal when proximity follows', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 900, 'kick'));
    e.recordTouch(touch(P.D, 1000, 'kick'));
    e.recordTouch(touch(P.D, 1800, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1900 });

    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, true);
    assert.equal(result.reason, 'opponent-kick-own-goal');
});

test('an insignificant opponent proximity does not create an assist boundary', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    e.recordTouch(touch(P.D, 1200, 'proximity'));
    e.recordTouch(touch(P.B, 1400));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1600 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
});

test('proximity followed by a kick upgrades the current logical touch to kick', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'proximity'));
    e.recordTouch(touch(P.A, 1050, 'kick'));
    const touches = e.getTouches();

    assert.equal(touches.length, 1);
    assert.equal(touches[0].source, 'kick');
    assert.equal(touches[0].timestamp, 1050);
    assert.equal(touches[0].firstTouchTimestamp, 1000);
    assert.equal(touches[0].lastTouchTimestamp, 1050);
    assert.equal(touches[0].lastKickTimestamp, 1050);
});

test('same-player proximity, kick, and proximity keep independent logical timing', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'proximity'));
    e.recordTouch(touch(P.A, 1050, 'kick'));
    e.recordTouch(touch(P.A, 1100, 'proximity'));
    const touches = e.getTouches();

    assert.equal(touches.length, 1);
    assert.equal(touches[0].source, 'kick');
    assert.equal(touches[0].firstTouchTimestamp, 1000);
    assert.equal(touches[0].lastTouchTimestamp, 1100);
    assert.equal(touches[0].lastKickTimestamp, 1050);
    assert.equal(touches[0].timestamp, 1100);
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

    assert.equal(touches.length, 1);
    assert.deepEqual(touches.map(entry => entry.playerName), ['B']);
    assert.equal(touches[0].timestamp, 1500);
});

test('a long flight preserves the last responsible scorer', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 5000 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.reason, 'last-touch-scoring-team');
});

test('match 343 long defensive kick remains the own-goal candidate at 2.108 seconds', () => {
    const e = engine();
    e.recordTouch(touch(P.D, 1000, 'kick'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 3108 });
    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
});

test('match 345 long attacking kick remains scorer at 4.45 seconds', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'kick'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 5450 });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
});

test('a post or crossbar bounce without a player touch preserves the scorer', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1800 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
});

test('a brief low-energy proximity bounce keeps the prior kicker', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'kick'));
    e.recordTouch({ ...touch(P.D, 1100, 'proximity'), velocityBefore: { x: 5, y: 0 }, velocityAfter: { x: 4.5, y: 0 } });
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.assister, null);
});

test('a pronounced velocity redirection transfers responsibility to the defender', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'kick'));
    e.recordTouch({ ...touch(P.D, 1100, 'proximity'), velocityBefore: { x: 5, y: 0 }, velocityAfter: { x: -3, y: 4 } });
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });
    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.match(result.reason, /velocity-direction-change/);
    assert.equal(result.confidence, 'medium');
});

test('sustained contact can qualify when physics samples are missing', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'kick'));
    e.recordTouch(touch(P.D, 1100, 'proximity'));
    e.recordTouch(touch(P.D, 1300, 'proximity'));
    e.recordTouch(touch(P.D, 1450, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1500 });
    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.match(result.reason, /sustained-contact/);
});

test('contact time stops at the last observed proximity sample', () => {
    const e = engine();
    e.recordTouch(touch(P.A, 1000, 'kick'));
    e.recordTouch(touch(P.D, 1100, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 2000 });
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
