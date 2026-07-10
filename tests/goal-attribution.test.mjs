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
const touch = (p, timestamp, source = 'kick') => ({ ...p, timestamp, matchTime: timestamp / 1000, position: { x: timestamp, y: 0 }, source });
const engine = (options = {}) => new GoalAttributionEngine({ assistTimeWindowMs: 3000, maxGoalTouchAgeMs: 3000, samePlayerTouchThrottleMs: 100, ...options });

test('direct goal without assist', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });
    assert.equal(r.type, 'goal'); assert.equal(r.scorer.name, 'A'); assert.equal(r.assister, null); assert.equal(r.isOwnGoal, false);
});

test('simple assist', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000)); e.recordTouch(touch(P.B, 1500));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1700 });
    assert.equal(r.scorer.name, 'B'); assert.equal(r.assister.name, 'A');
});

test('dribble after pass keeps assist', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000)); e.recordTouch(touch(P.B, 1200)); e.recordTouch(touch(P.B, 1400)); e.recordTouch(touch(P.B, 1600));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1800 });
    assert.equal(r.scorer.name, 'B'); assert.equal(r.assister.name, 'A');
});

test('no self assist', () => {
    const e = engine(); e.recordTouch(touch(P.B, 1000)); e.recordTouch(touch(P.B, 1200));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1400 });
    assert.equal(r.scorer.name, 'B'); assert.equal(r.assister, null);
});

test('own goal after opponent shot', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000)); e.recordTouch(touch(P.D, 1300));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1500 });
    assert.equal(r.type, 'own_goal'); assert.equal(r.scorer.name, 'D'); assert.equal(r.assister, null); assert.equal(r.isOwnGoal, true);
});

test('defender touch blocks assist', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000)); e.recordTouch(touch(P.D, 1200)); e.recordTouch(touch(P.B, 1400));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1600 });
    assert.equal(r.scorer.name, 'B'); assert.equal(r.assister, null); assert.equal(r.assistReason, 'assist-blocked-by-opponent');
});

test('assist after many scorer touches', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000)); e.recordTouch(touch(P.B, 1200)); e.recordTouch(touch(P.B, 1350)); e.recordTouch(touch(P.B, 1500));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1700 });
    assert.equal(r.scorer.name, 'B'); assert.equal(r.assister.name, 'A');
});

test('expired assist window', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000)); e.recordTouch(touch(P.B, 5000));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 5200 });
    assert.equal(r.scorer.name, 'B'); assert.equal(r.assister, null); assert.equal(r.assistReason, 'assist-expired');
});

test('stale last touch makes unknown scorer', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 5000 });
    assert.equal(r.type, 'unknown'); assert.equal(r.scorer, null);
});

test('post bounce does not change scorer', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1800 });
    assert.equal(r.scorer.name, 'A');
});

test('proximity contact can decide goal', () => {
    const e = engine(); e.recordTouch(touch(P.D, 1000, 'proximity'));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });
    assert.equal(r.type, 'own_goal'); assert.equal(r.scorer.name, 'D');
});

test('deduplicates kick followed by proximity for same player', () => {
    const e = engine(); assert.equal(e.recordTouch(touch(P.A, 1000, 'kick')), true); assert.equal(e.recordTouch(touch(P.A, 1050, 'proximity')), false);
    assert.equal(e.getTouches().length, 1);
});

test('selects closest simultaneous contact deterministically', () => {
    const e = engine();
    const input = { ballPosition: { x: 0, y: 0 }, ballRadius: 10, timestamp: 1000, players: [
        { id: 2, team: RED, disc: { x: 12, y: 0 }, playerRadius: 5 },
        { id: 1, team: RED, disc: { x: 11, y: 0 }, playerRadius: 5 },
    ]};
    assert.equal(e.selectClosestContact(input).player.id, 1);
    assert.equal(e.selectClosestContact({ ...input, players: input.players.slice().reverse() }).player.id, 1);
});

test('player without auth is attributed but safe to pass onward', () => {
    const e = engine(); e.recordTouch(touch({ ...P.A, playerAuth: null, playerName: 'NoAuth' }, 1000));
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1100 });
    assert.equal(r.scorer.name, 'NoAuth'); assert.equal(r.scorer.auth, null);
});

test('team snapshot from touch is preserved after later changes', () => {
    const e = engine(); const player = { ...P.A }; e.recordTouch(touch(player, 1000)); player.playerTeam = BLUE;
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1100 });
    assert.equal(r.type, 'goal'); assert.equal(r.scorer.team, RED);
});

test('reset after goal clears previous play', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000)); e.resetPlay();
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });
    assert.equal(r.type, 'unknown');
});

test('reset match clears previous match', () => {
    const e = engine(); e.recordTouch(touch(P.A, 1000)); e.resetMatch();
    const r = e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });
    assert.equal(r.type, 'unknown');
});

test('tie contact prefers recent kicker rather than array order', () => {
    const e = engine();
    e.recordTouch(touch(P.B, 1000, 'kick'));
    const players = [
        { id: 1, team: RED, disc: { x: 10, y: 0 }, playerRadius: 5 },
        { id: 2, team: RED, disc: { x: 10, y: 0 }, playerRadius: 5 },
    ];
    const contact = e.selectClosestContact({ ballPosition: { x: 0, y: 0 }, ballRadius: 10, timestamp: 1100, players });
    assert.equal(contact.player.id, 2);
});
