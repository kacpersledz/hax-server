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
    ...options,
});
const submit = (e, entry, options = {}) => {
    if (entry.source === 'kick') return e.recordTouch(entry);
    return e.observeTick({
        timestamp: entry.timestamp,
        contact: { id: entry.playerId, playerAuth: entry.playerAuth, name: entry.playerName, team: entry.playerTeam },
        contactCandidateIds: options.candidateIds ?? [entry.playerId],
        ballPosition: options.ballPosition ?? { x: 0, y: 0 },
        ballVelocity: options.ballVelocity ?? null,
    });
};
const tick = (e, timestamp, player = null, ballVelocity = null, candidateIds, playerPosition = { x: 0, y: 0 }) => e.observeTick({
    timestamp,
    contact: player ? { id: player.playerId, playerAuth: player.playerAuth, name: player.playerName, team: player.playerTeam } : null,
    contactCandidateIds: candidateIds ?? (player ? [player.playerId] : []),
    contactCandidateStates: player ? [{ id: player.playerId, ...playerPosition }] : [],
    ballPosition: { x: 0, y: 0 },
    ballVelocity,
});

test('auth remains callback data only and is absent from debug surfaces and logs', () => {
    const e = new GoalAttributionEngine({ diagnostics: true });
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args);
    let result;
    try {
        submit(e, touch(P.A, 1000));
        result = e.resolveGoal({ scoringTeam: RED });
    } finally {
        console.log = originalLog;
    }
    assert.equal(result.scorer.auth, P.A.playerAuth, 'auth remains available to statsOnTeamGoal');
    assert.doesNotMatch(JSON.stringify([e.getDebugState(), e.getTouches(), logs]), /auth-a|playerAuth|"auth"/);
});

test('direct goal without assist', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, false);
    assert.equal(result.reason, 'last-touch-scoring-team');
});

test('simple assist uses the previous different scoring-team player', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
    submit(e, touch(P.B, 1500));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1700 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
});

test('confirmed continuous contact refreshes the same passer assist window after a long dribble', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
    let timestamp = 1016;
    for (let i = 0; i < 360; i++, timestamp += 16) tick(e, timestamp, P.A, { x: 0, y: 0 });
    const lastJustified = e.getDebugState().responsibleTouch.lastJustifiedTimestamp;
    assert.ok(lastJustified > 6000, 'the long continuous session refreshes justified contact time');
    submit(e, touch(P.B, timestamp + 1000));
    const result = e.resolveGoal({ scoringTeam: RED });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
});

test('an accepted redirection refreshes the current owner, but weak contacts and long gaps do not', () => {
    const redirected = engine();
    submit(redirected, touch(P.A, 1000));
    tick(redirected, 1016, null, { x: 0.5, y: 0 });
    tick(redirected, 3000, P.A, { x: 0.5, y: 0 }, [P.A.playerId], { x: 2, y: 0 });
    tick(redirected, 3016, P.A, { x: -0.5, y: 0 }, [P.A.playerId], { x: 0, y: 0 });
    assert.equal(redirected.getDebugState().responsibleTouch.responsibilityTimestamp, 1000);
    assert.equal(redirected.getDebugState().responsibleTouch.lastJustifiedTimestamp, 3016);
    submit(redirected, touch(P.B, 6000));
    let result = redirected.resolveGoal({ scoringTeam: RED });
    assert.equal(result.assister.name, 'A', 'accepted redirect extends the passer window');

    const weakContactDoesNotRefresh = engine();
    submit(weakContactDoesNotRefresh, touch(P.A, 1000));
    submit(weakContactDoesNotRefresh, touch(P.A, 6000, 'proximity'));
    submit(weakContactDoesNotRefresh, touch(P.B, 6200));
    result = weakContactDoesNotRefresh.resolveGoal({ scoringTeam: RED });
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-expired');

    const confirmedGapDoesNotRefresh = engine();
    submit(confirmedGapDoesNotRefresh, touch(P.A, 1000));
    for (let timestamp = 1016; timestamp <= 1312; timestamp += 16) tick(confirmedGapDoesNotRefresh, timestamp, P.A);
    const lastJustified = confirmedGapDoesNotRefresh.getDebugState().responsibleTouch.lastJustifiedTimestamp;
    assert.ok(lastJustified > 1000);
    submit(confirmedGapDoesNotRefresh, touch(P.B, lastJustified + 3001));
    result = confirmedGapDoesNotRefresh.resolveGoal({ scoringTeam: RED });
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-expired');
});

test('weak opponent contact breaks assist chains until a new justified passer contact', () => {
    const beforeTakeover = engine();
    submit(beforeTakeover, touch(P.A, 1000));
    submit(beforeTakeover, touch(P.D, 1100, 'proximity'));
    submit(beforeTakeover, touch(P.B, 1200));
    let result = beforeTakeover.resolveGoal({ scoringTeam: RED });
    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-blocked-by-opponent-contact');

    const afterTakeover = engine();
    submit(afterTakeover, touch(P.A, 1000));
    submit(afterTakeover, touch(P.B, 1100));
    submit(afterTakeover, touch(P.D, 1200, 'proximity'));
    result = afterTakeover.resolveGoal({ scoringTeam: RED });
    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-blocked-by-opponent-contact');

    const weakSameOwnerDoesNotRestore = engine();
    submit(weakSameOwnerDoesNotRestore, touch(P.A, 1000));
    submit(weakSameOwnerDoesNotRestore, touch(P.D, 1100, 'proximity'));
    submit(weakSameOwnerDoesNotRestore, touch(P.A, 1150, 'proximity'));
    submit(weakSameOwnerDoesNotRestore, touch(P.B, 1200));
    result = weakSameOwnerDoesNotRestore.resolveGoal({ scoringTeam: RED });
    assert.equal(result.assister, null);

    const justifiedPassAfterContact = engine();
    submit(justifiedPassAfterContact, touch(P.A, 1000));
    submit(justifiedPassAfterContact, touch(P.D, 1100, 'proximity'));
    submit(justifiedPassAfterContact, touch(P.A, 1150));
    submit(justifiedPassAfterContact, touch(P.B, 1200));
    result = justifiedPassAfterContact.resolveGoal({ scoringTeam: RED });
    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
});

test('weak fallback uses the latest single observed contact without changing responsibility', () => {
    const noOwner = engine();
    tick(noOwner, 1000, P.D);
    tick(noOwner, 1100, P.A);
    const result = noOwner.resolveGoal({ scoringTeam: RED });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.scorer.auth, P.A.playerAuth);
    assert.equal(result.assister, null);
    assert.equal(result.confidence, 'low');
    assert.equal(result.reason, 'fallback-weak-contact');
    assert.equal(result.candidateEvidence.reason, 'fallback-weak-contact');
    assert.equal(result.assistReason, 'no-assist-candidate');

    const opponentFallback = engine();
    tick(opponentFallback, 1000, P.D);
    const ownGoal = opponentFallback.resolveGoal({ scoringTeam: RED });
    assert.equal(ownGoal.type, 'own_goal');
    assert.equal(ownGoal.scorer.name, 'D');
    assert.equal(ownGoal.confidence, 'low');

    const ambiguous = engine();
    tick(ambiguous, 1000, P.D, null, [P.D.playerId, P.A.playerId]);
    assert.equal(ambiguous.getDebugState().weakCandidate, null);
    assert.equal(ambiguous.resolveGoal({ scoringTeam: RED }).type, 'unknown');

    const retainedAcrossBreak = engine();
    tick(retainedAcrossBreak, 1000, P.D);
    retainedAcrossBreak.breakContinuity('test-pause');
    tick(retainedAcrossBreak, 5000, null);
    assert.equal(retainedAcrossBreak.resolveGoal({ scoringTeam: RED }).scorer.name, 'D');
    retainedAcrossBreak.resetPlay();
    assert.equal(retainedAcrossBreak.resolveGoal({ scoringTeam: RED }).type, 'unknown');

    const ownerWins = engine();
    submit(ownerWins, touch(P.A, 1000));
    tick(ownerWins, 1100, P.D);
    const ownedGoal = ownerWins.resolveGoal({ scoringTeam: RED });
    assert.equal(ownedGoal.scorer.name, 'A');
    assert.equal(ownedGoal.confidence, 'high');
});

test('direction changes require minimum vector delta while large speed changes remain eligible', () => {
    const redirect = (beforeSpeed, afterSpeed, previousPosition, currentPosition) => {
        const e = engine();
        tick(e, 1000, P.A, { x: beforeSpeed, y: 0 }, [P.A.playerId], previousPosition);
        tick(e, 1016, P.A, { x: afterSpeed, y: 0 }, [P.A.playerId], currentPosition);
        return e;
    };

    const tinyTurn = redirect(0.11, -0.11, { x: 1, y: 0 }, { x: 0, y: 0 });
    assert.equal(tinyTurn.getDebugState().responsibleTouch, null);
    assert.equal(tinyTurn.getDebugState().lastEvidence.reason, 'direction-change-below-minimum-delta');
    assert.equal(tinyTurn.getDebugState().lastEvidence.deltaSpeedVector, 0.22);

    const belowThreshold = redirect(0.495, -0.495, { x: 2, y: 0 }, { x: 0, y: 0 });
    assert.equal(belowThreshold.getDebugState().responsibleTouch, null);
    assert.equal(belowThreshold.getDebugState().lastEvidence.reason, 'direction-change-below-minimum-delta');

    const atThreshold = redirect(0.5, -0.5, { x: 2, y: 0 }, { x: 0, y: 0 });
    assert.equal(atThreshold.getDebugState().responsibleTouch.playerId, P.A.playerId);
    assert.equal(atThreshold.resolveGoal({ scoringTeam: RED }).candidateEvidence.reason, 'velocity-direction-change');

    const largeDeltaNoTurn = redirect(1, 4, { x: 0, y: 0 }, { x: 2, y: 0 });
    assert.equal(largeDeltaNoTurn.getDebugState().responsibleTouch.playerId, P.A.playerId);
    assert.equal(largeDeltaNoTurn.resolveGoal({ scoringTeam: RED }).candidateEvidence.reason, 'velocity-change');
});

test('repeated scorer touches do not destroy an assist', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
    submit(e, touch(P.B, 1200));
    submit(e, touch(P.B, 1400, 'proximity'));
    submit(e, touch(P.B, 1600));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1800 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
    assert.equal(e.getTouches().length, 2);
});

test('a long scorer dribble preserves the assist from the takeover transition', () => {
    const e = engine({ assistTimeWindowMs: 3000 });
    submit(e, touch(P.A, 1000));
    submit(e, touch(P.B, 1500));
    submit(e, touch(P.B, 2200, 'proximity'));
    submit(e, touch(P.B, 3000, 'proximity'));
    submit(e, touch(P.B, 4000, 'proximity'));
    submit(e, touch(P.B, 4050, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 4100 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
});

test('does not award a self-assist', () => {
    const e = engine();
    submit(e, touch(P.B, 1000));
    submit(e, touch(P.B, 1200));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1400 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
});

test('attacker kick then defender proximity is the attacker goal, not an own goal', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    submit(e, touch(P.D, 1200, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1400 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, false);
    assert.equal(result.reason, 'last-touch-scoring-team');
    assert.equal(result.assistReason, 'no-assist-candidate');
});

test('an attacker kick in the same unresolved interval as defender proximity stays responsible', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    tick(e, 1016, P.D, { x: 5, y: 0 }, undefined, { x: 12, y: 0 });
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1100 });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.evidence.reason, 'velocity-ignored-kick-in-sampling-interval');
    assert.deepEqual(result.evidence.kickPlayerIds, [P.A.playerId]);
});

test('latest attacker before a weak defender proximity scores without an assist across the deflection', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
    submit(e, touch(P.B, 1200));
    submit(e, touch(P.D, 1400, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1600 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-blocked-by-opponent-contact');
    assert.equal(result.isOwnGoal, false);
});

test('a run of defender-only proximity deflections still preserves the recent attacker', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
    submit(e, touch(P.D, 1200, 'proximity'));
    submit(e, touch({ ...P.D, playerId: 5, playerName: 'E' }, 1300, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1500 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, false);
});

test('a recent defender kick is a defender own goal', () => {
    const e = engine();
    submit(e, touch(P.A, 900));
    submit(e, touch(P.D, 1800));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1900 });

    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, true);
    assert.equal(result.reason, 'opponent-kick-own-goal');
});

test('an old defender kick remains responsible after proximity and elapsed time', () => {
    const e = engine();
    submit(e, touch(P.D, 1000, 'kick'));
    submit(e, touch(P.D, 1800, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1900 });
    const defenderTouch = e.getDebugState().responsibleTouch;

    assert.equal(result.type, 'own_goal');
    assert.equal(result.isOwnGoal, true);
    assert.equal(defenderTouch.firstTouchTimestamp, 1000);
    assert.equal(defenderTouch.lastTouchTimestamp, 1000);
    assert.equal(e.getDebugState().contactSession.lastTouchTimestamp, 1800);
    assert.equal(defenderTouch.lastKickTimestamp, 1000);
});

test('an old defender kick remains an own goal when proximity follows', () => {
    const e = engine();
    submit(e, touch(P.A, 900, 'kick'));
    submit(e, touch(P.D, 1000, 'kick'));
    submit(e, touch(P.D, 1800, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1900 });

    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.equal(result.assister, null);
    assert.equal(result.isOwnGoal, true);
    assert.equal(result.reason, 'opponent-kick-own-goal');
});

test('one weak opponent proximity tick creates an assist boundary', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
    submit(e, touch(P.D, 1200, 'proximity'));
    submit(e, touch(P.B, 1400));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1600 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-blocked-by-opponent-contact');
});

test('an explicit kick after proximity creates a distinct takeover time', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'proximity'));
    submit(e, touch(P.A, 1050, 'kick'));
    const touches = e.getTouches();

    assert.equal(touches.length, 1);
    assert.equal(touches[0].source, 'kick');
    assert.equal(touches[0].timestamp, 1050);
    assert.equal(touches[0].firstTouchTimestamp, 1050);
    assert.equal(touches[0].lastTouchTimestamp, 1050);
    assert.equal(touches[0].lastKickTimestamp, 1050);
    assert.equal(touches[0].responsibilityTimestamp, 1050);
});

test('same-player later proximity does not slide the explicit takeover time', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'proximity'));
    submit(e, touch(P.A, 1050, 'kick'));
    submit(e, touch(P.A, 1100, 'proximity'));
    const touches = e.getTouches();

    assert.equal(touches.length, 1);
    assert.equal(touches[0].source, 'kick');
    assert.equal(touches[0].firstTouchTimestamp, 1050);
    assert.equal(touches[0].lastTouchTimestamp, 1050);
    assert.equal(touches[0].lastKickTimestamp, 1050);
    assert.equal(touches[0].timestamp, 1050);
    assert.equal(touches[0].responsibilityTimestamp, 1050);
});

test('repeated same-player proximity contacts do not pollute the logical sequence', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'proximity'));
    submit(e, touch(P.A, 1100, 'proximity'));
    submit(e, touch(P.A, 1200, 'proximity'));
    submit(e, touch(P.B, 1300, 'proximity'));
    submit(e, touch(P.B, 1400, 'proximity'));
    submit(e, touch(P.B, 1500, 'proximity'));
    const touches = e.getTouches();

    assert.equal(touches.length, 0, 'point contacts without verified evidence do not become owners');
});

test('a long flight preserves the last responsible scorer', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 5000 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.reason, 'last-touch-scoring-team');
});

test('match 343 long defensive kick remains the own-goal candidate at 2.108 seconds', () => {
    const e = engine();
    submit(e, touch(P.D, 1000, 'kick'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 3108 });
    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
});

test('match 345 long attacking kick remains scorer at 4.45 seconds', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 5450 });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
});

test('a post or crossbar bounce without a player touch preserves the scorer', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1800 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
});

test('a brief low-energy proximity bounce keeps the prior kicker', () => {
    const e = engine();
    tick(e, 1000, null, { x: 0, y: 0 });
    submit(e, touch(P.A, 1008, 'kick'));
    tick(e, 1016, P.D, { x: 5, y: 0 }); // The kick invalidates this interval.
    tick(e, 1032, P.D, { x: 4.5, y: 0 }); // A new, weak interval is not significant.
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1040 });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.assister, null);
});

test('a pronounced velocity redirection transfers responsibility to the defender', () => {
    const e = engine();
    tick(e, 1000, null, { x: 0, y: 0 });
    submit(e, touch(P.A, 1008, 'kick'));
    tick(e, 1016, P.D, { x: 5, y: 0 }, undefined, { x: 2, y: 0 }); // Kick's impulse is discarded.
    tick(e, 1032, P.D, { x: -3, y: 4 }, undefined, { x: 0, y: 1 }); // A distinct, continuous redirect qualifies.
    tick(e, 1048, null, { x: -3, y: 4 }); // Later observations must not erase the accepted candidate proof.
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1040 });
    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.match(result.reason, /velocity-direction-change/);
    assert.equal(result.confidence, 'medium');
    assert.equal(result.evidence.reason, 'no-contact-this-tick');
    assert.equal(result.candidateEvidence.reason, 'velocity-direction-change');
    assert.equal(result.candidateEvidence.deltaSpeedVector, Math.hypot(-8, 4));
});

test('sustained contact can qualify when physics samples are missing', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    for (let tickIndex = 0; tickIndex <= 20; tickIndex++) tick(e, 1100 + tickIndex * 16, P.D);
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1500 });
    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.match(result.reason, /sustained-contact/);
    assert.equal(result.responsibilityTimestamp, 1100);
    assert.ok(result.candidateEvidence.lastJustifiedTimestamp > result.responsibilityTimestamp,
        'the first sustained takeover uses the session start for ownership and the confirmed tick for justification');
});

test('sustained proximity by the current kicker changes evidence confidence without changing takeover time', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    submit(e, touch(P.D, 1100, 'kick'));
    for (let tickIndex = 0; tickIndex <= 20; tickIndex++) tick(e, 1200 + tickIndex * 16, P.D);
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1600 });
    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.match(result.reason, /sustained-contact/);
    assert.equal(result.confidence, 'medium');
    assert.equal(result.candidateEvidence.reason, 'sustained-contact');
    assert.equal(result.responsibilityTimestamp, 1100, 'same player contact is not a new takeover');
});

test('contact time stops at the last observed proximity sample', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    submit(e, touch(P.D, 1100, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 2000 });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
});

test('separated brief defender contacts do not combine into sustained contact', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    tick(e, 1016, P.D, { x: 0, y: 0 });
    tick(e, 1032, null, { x: 0, y: 0 });
    tick(e, 5000, P.D, { x: 0, y: 0 });
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 5100 });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.notEqual(e.getDebugState().contactSession.durationMs, 3900);
    assert.equal(result.candidateReason, 'explicit-kick');
});

test('long tick gaps break physical continuity but retain ball responsibility', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    tick(e, 1016, P.D, { x: 0, y: 0 });
    tick(e, 5016, P.D, { x: 0, y: 0 });
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 5100 });
    assert.equal(result.scorer.name, 'A');
    assert.equal(e.getDebugState().contactSession.durationMs, 0);
});

test('a delayed but individually continuous sample advances contact by one tick, not wall time', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    tick(e, 1016, P.D, null);
    tick(e, 1115, P.D, null);
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1120 });
    assert.equal(result.scorer.name, 'A');
    assert.equal(e.getDebugState().contactSession.durationMs, 1000 / 60);
});

test('multiple nearby players make a velocity impulse ambiguous', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    const twoPlayers = [P.D.playerId, 5];
    tick(e, 1016, P.D, { x: 0, y: 0 }, twoPlayers);
    tick(e, 1032, P.D, { x: 5, y: 0 }, twoPlayers);
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1040 });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.evidence.reason, 'ambiguous-multiple-contact-candidates');
});

test('ambiguous contact restarts the physical session instead of poisoning later unique ticks', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    tick(e, 1100, P.D, { x: 1, y: 0 }, [P.D.playerId, 5]);
    assert.equal(e.getDebugState().contactSession, null);

    for (let i = 0; i < 42; i++) tick(e, 1117 + i * 17, P.D, { x: 1, y: 0 });
    const result = e.resolveGoal({ scoringTeam: RED });
    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.equal(result.confidence, 'medium');
    assert.equal(result.candidateReason, 'sustained-contact');
    assert.equal(result.candidateEvidence.sessionRestartedAfterAmbiguity, true);
});

test('ambiguous ticks split sustained contact and do not create fallback or assist boundaries', () => {
    const split = engine();
    submit(split, touch(P.A, 1000, 'kick'));
    let timestamp = 1016;
    for (let i = 0; i <= 12; i++, timestamp += 17) tick(split, timestamp, P.D);
    assert.equal(split.getDebugState().contactSession.durationMs, 200);
    tick(split, timestamp, P.D, null, [P.D.playerId, 5]);
    timestamp += 17;
    for (let i = 0; i < 12; i++, timestamp += 17) tick(split, timestamp, P.D);
    assert.equal(split.getDebugState().responsibleTouch.playerId, P.A.playerId,
        '200 ms before and after ambiguity are not accumulated');
    for (let i = 0; i < 7; i++, timestamp += 17) tick(split, timestamp, P.D);
    assert.equal(split.getDebugState().responsibleTouch.playerId, P.D.playerId,
        'the new session may take over after its own 300 ms');

    const ambiguousOnly = engine();
    for (let i = 0; i < 30; i++) tick(ambiguousOnly, 1000 + i * 17, P.D, null, [P.D.playerId, 5]);
    assert.equal(ambiguousOnly.getDebugState().weakCandidate, null);
    assert.equal(ambiguousOnly.getDebugState().contactSession, null);
    assert.equal(ambiguousOnly.resolveGoal({ scoringTeam: RED }).type, 'unknown');

    const noSelectedCandidate = engine();
    tick(noSelectedCandidate, 1000, null, null, [P.D.playerId, 5]);
    assert.equal(noSelectedCandidate.getDebugState().lastEvidence.reason, 'ambiguous-multiple-contact-candidates');
    tick(noSelectedCandidate, 1016, P.D);
    assert.equal(noSelectedCandidate.getDebugState().lastEvidence.sessionRestartedAfterAmbiguity, true);

    const assistBoundary = engine();
    submit(assistBoundary, touch(P.A, 1000));
    submit(assistBoundary, touch(P.B, 1100));
    tick(assistBoundary, 1200, P.D, null, [P.D.playerId, 5]);
    const result = assistBoundary.resolveGoal({ scoringTeam: RED });
    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
});

test('ambiguous observations reject adjacent physics intervals but allow the next independent redirect', () => {
    const e = engine();
    submit(e, touch(P.A, 900, 'kick'));
    tick(e, 1000, P.D, { x: 0.5, y: 0 }, [P.D.playerId], { x: 0, y: 0 });
    tick(e, 1016, P.D, { x: -3, y: 0 }, [P.D.playerId, 5], { x: -2, y: 0 });
    tick(e, 1032, P.D, { x: -3, y: 0 }, [P.D.playerId], { x: 0, y: 0 });
    assert.equal(e.getDebugState().responsibleTouch.playerId, P.A.playerId,
        'the ambiguous-to-unique interval cannot transfer responsibility');
    assert.equal(e.getDebugState().lastEvidence.sessionRestartedAfterAmbiguity, true);
    tick(e, 1048, P.D, { x: 5, y: 0 }, [P.D.playerId], { x: 2, y: 0 });
    const result = e.resolveGoal({ scoringTeam: RED });
    assert.equal(result.scorer.name, 'D');
    assert.equal(result.candidateReason, 'velocity-direction-change');
});

test('a changed team creates a new possession snapshot while preserving human identity', () => {
    const changedOnKick = engine();
    submit(changedOnKick, touch(P.A, 1000, 'kick'));
    submit(changedOnKick, touch({ ...P.A, playerTeam: BLUE, playerName: 'A-blue' }, 1200, 'kick'));
    let result = changedOnKick.resolveGoal({ scoringTeam: RED });
    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'A-blue');
    assert.equal(result.scorer.team, BLUE);
    assert.equal(result.scorer.auth, P.A.playerAuth);
    assert.equal(result.responsibilityTimestamp, 1200);
    assert.equal(result.assister, null);

    const blueGoal = engine();
    submit(blueGoal, touch(P.A, 1000, 'kick'));
    submit(blueGoal, touch({ ...P.A, playerTeam: BLUE }, 1200, 'kick'));
    result = blueGoal.resolveGoal({ scoringTeam: BLUE });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.team, BLUE);
    assert.equal(result.assister, null, 'the same human cannot assist themself across a team change');

    const noNewContact = engine();
    submit(noNewContact, touch(P.A, 1000, 'kick'));
    result = noNewContact.resolveGoal({ scoringTeam: RED });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.team, RED, 'a team-change callback alone must not rewrite the historical owner');

    const weakChangedTeam = engine();
    submit(weakChangedTeam, touch(P.A, 1000, 'kick'));
    tick(weakChangedTeam, 1100, { ...P.A, playerTeam: BLUE });
    result = weakChangedTeam.resolveGoal({ scoringTeam: RED });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.team, RED, 'a weak contact after a team change cannot replace the owner');

    const proximityChangedTeam = engine();
    submit(proximityChangedTeam, touch(P.A, 1000, 'kick'));
    tick(proximityChangedTeam, 1016, P.A);
    assert.equal(proximityChangedTeam.breakPlayerContinuity(P.A.playerId, 'player-team-change'), true);
    assert.equal(proximityChangedTeam.getDebugState().responsibleTouch.playerTeam, RED);
    assert.equal(proximityChangedTeam.getDebugState().contactSession, null);
    let timestamp = 1032;
    for (let i = 0; i < 20; i++, timestamp += 17) {
        tick(proximityChangedTeam, timestamp, { ...P.A, playerTeam: BLUE });
        if (i === 17) assert.equal(proximityChangedTeam.getDebugState().responsibleTouch.playerTeam, RED,
            'sub-threshold new-team contact does not take over');
    }
    result = proximityChangedTeam.resolveGoal({ scoringTeam: RED });
    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.id, P.A.playerId);
    assert.equal(result.scorer.team, BLUE);
    assert.equal(result.scorer.auth, P.A.playerAuth);
    assert.equal(result.candidateReason, 'sustained-contact');

    const spectatorRoundTrip = engine();
    submit(spectatorRoundTrip, touch(P.A, 1000, 'kick'));
    for (let i = 0; i < 12; i++) tick(spectatorRoundTrip, 1016 + i * 17, P.A);
    assert.equal(spectatorRoundTrip.getDebugState().contactSession.durationMs, 11 * (1000 / 60));
    assert.equal(spectatorRoundTrip.breakPlayerContinuity(P.A.playerId, 'player-became-spectator'), true);
    assert.equal(spectatorRoundTrip.breakPlayerContinuity(P.A.playerId, 'player-returned-to-team'), false);
    for (let i = 0; i < 12; i++) tick(spectatorRoundTrip, 1216 + i * 17, P.A);
    assert.equal(spectatorRoundTrip.getDebugState().contactSession.durationMs, 11 * (1000 / 60),
        'a spectator round-trip resets contact time even when the player returns to the same team');
});

test('team-change continuity invalidation is player-specific and keeps unresolved kick guards', () => {
    const e = engine();
    tick(e, 1000, P.A, { x: 5, y: 0 }, [P.A.playerId], { x: 0, y: 0 });
    submit(e, touch(P.A, 1008, 'kick'));
    assert.equal(e.breakPlayerContinuity(P.A.playerId, 'player-team-change'), true);
    assert.deepEqual(e.getDebugState().pendingKickPlayerIds, [P.A.playerId]);
    tick(e, 1016, P.A, { x: -5, y: 0 }, [P.A.playerId], { x: -2, y: 0 });
    assert.equal(e.getDebugState().responsibleTouch.playerId, P.A.playerId);
    assert.equal(e.getDebugState().lastEvidence.reason, 'velocity-ignored-kick-in-sampling-interval');

    const unrelated = engine();
    tick(unrelated, 1000, P.A, null);
    assert.equal(unrelated.breakPlayerContinuity(P.D.playerId, 'unrelated-team-change'), false);
    tick(unrelated, 1016, P.A, null);
    assert.equal(unrelated.getDebugState().contactSession.durationMs, 1000 / 60);
});

test('a non-contact nearby player cannot inherit an impulse from a ball-boundary bounce', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    tick(e, 1016, null, { x: 0, y: 0 });
    tick(e, 1032, P.D, { x: 5, y: 0 });
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1040 });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.match(result.evidence.reason, /physics-interval-unavailable|contact-not-present/);
});

test('a wall-like velocity reversal beside a stationary player preserves the prior owner', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    tick(e, 1016, P.D, { x: 5, y: 0 }, undefined, { x: 12, y: 0 });
    tick(e, 1032, P.D, { x: -5, y: 0 }, undefined, { x: 12, y: 0 });
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1040 });
    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.evidence.reason, 'velocity-source-ambiguous');
});

test('missing player position samples cannot validate a velocity source', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    tick(e, 1016, P.D, { x: 5, y: 0 }, undefined, null);
    tick(e, 1032, P.D, { x: -5, y: 0 }, undefined, null);
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1040 });
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.evidence.reason, 'contact-not-present-at-both-samples');
});

test('switching proximity players ends the physical session before the first player returns', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    tick(e, 1016, P.D, null);
    tick(e, 1032, P.B, null);
    tick(e, 1048, P.D, null);
    tick(e, 1064, P.D, null);
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1070 });
    assert.equal(result.scorer.name, 'A');
    assert.equal(e.getDebugState().contactSession.durationMs, 1000 / 60);
});

test('an old casual touch does not keep an assist alive before a later kick takeover', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    tick(e, 1100, P.B);
    tick(e, 1116, null);
    submit(e, touch(P.B, 6000, 'kick'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 6100 });
    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-expired');
});

test('repeated same-player dribbles do not slide the original assist takeover', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    submit(e, touch(P.B, 1500, 'kick'));
    for (let timestamp = 1516; timestamp <= 5016; timestamp += 16) tick(e, timestamp, P.B);
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 5100 });
    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
});

test('reset after a goal clears attribution for the next play', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
    e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });
    e.resetPlay();
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1400 });

    assert.equal(result.type, 'unknown');
    assert.equal(e.getTouches().length, 0);
});

test('resetMatch also clears attribution', () => {
    const e = engine();
    submit(e, touch(P.A, 1000));
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

test('an effectively tied proximity contact remains deterministic without a kick cooldown', () => {
    const e = engine();
    submit(e, touch(P.B, 1000, 'kick'));
    const contact = e.selectClosestContact({
        ballPosition: { x: 0, y: 0 },
        ballRadius: 10,
        timestamp: 1100,
        players: [
            { id: 1, team: RED, disc: { x: 10, y: 0 }, playerRadius: 5 },
            { id: 2, team: RED, disc: { x: 10.005, y: 0 }, playerRadius: 5 },
        ],
    });

    assert.equal(contact.player.id, 1);
});

test('a player without auth can still be attributed safely', () => {
    const e = engine();
    submit(e, touch({ ...P.A, playerAuth: null, playerName: 'NoAuth' }, 1000));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1100 });

    assert.equal(result.scorer.name, 'NoAuth');
    assert.equal(result.scorer.auth, null);
});

test('team identity is snapshotted at touch time', () => {
    const e = engine();
    const player = { ...P.A };
    submit(e, touch(player, 1000));
    player.playerTeam = BLUE;
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1100 });

    assert.equal(result.type, 'goal');
    assert.equal(result.scorer.team, RED);
});

test('a single opponent proximity touch is a low-confidence own-goal fallback', () => {
    const e = engine();
    submit(e, touch(P.D, 1000, 'proximity'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1200 });

    assert.equal(result.type, 'own_goal');
    assert.equal(result.scorer.name, 'D');
    assert.equal(result.confidence, 'low');
    assert.equal(result.reason, 'fallback-weak-contact');
    assert.equal(result.isOwnGoal, true);
});

test('assist window is measured from passer touch to scorer touch', () => {
    const e = engine({ assistTimeWindowMs: 3000 });
    submit(e, touch(P.A, 1000));
    submit(e, touch(P.B, 3500));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 4300 });

    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
});

test('assist expires when passer to scorer touch exceeds the window', () => {
    const e = engine({ assistTimeWindowMs: 3000 });
    submit(e, touch(P.A, 1000));
    submit(e, touch(P.B, 4500));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 4600 });

    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-expired');
});

test('assist window includes its exact 3000 ms boundary', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    submit(e, touch(P.B, 4000, 'kick'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 4100 });
    assert.equal(result.assister.name, 'A');
    assert.equal(result.assistReason, 'assist-found');
});

test('a malformed negative assist interval is rejected', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    submit(e, touch(P.B, 900, 'kick'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1100 });
    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-negative-interval');
});

test('an opponent with significant responsibility blocks a subsequent assist', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    submit(e, touch(P.D, 1200, 'kick'));
    submit(e, touch(P.B, 1400, 'kick'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1500 });
    assert.equal(result.scorer.name, 'B');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-blocked-by-opponent');
});

test('reclaiming responsibility after an opponent takeover does not award an assist', () => {
    const e = engine();
    submit(e, touch(P.A, 1000, 'kick'));
    submit(e, touch(P.D, 1200, 'kick'));
    submit(e, touch(P.A, 1400, 'kick'));
    const result = e.resolveGoal({ scoringTeam: RED, timestamp: 1500 });
    assert.equal(result.scorer.name, 'A');
    assert.equal(result.assister, null);
    assert.equal(result.assistReason, 'assist-blocked-by-opponent');
});
