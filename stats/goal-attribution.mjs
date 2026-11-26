export function createGoalAttributionEngine(options = {}) {
    const DEFAULTS = {
        assistTimeWindowMs: 3000,
        maxTickGapMs: 100,
        tickDurationMs: 1000 / 60,
        contactTolerance: 0.5,
        tieDistanceTolerance: 0.01,
        significantContactMs: 300,
        significantSpeedChange: 2.5,
        significantTurnRadians: Math.PI / 4,
        minDirectionalDelta: 1.0,
        diagnostics: false,
    };
    const config = { ...DEFAULTS, ...options };
    let responsibleTouch = null;
    let previousDifferentTouch = null;
    let contactSession = null;
    let lastObservation = null;
    let pendingKicks = [];
    let lastEvidence = { reason: 'no-physics-observation', accepted: false };
    let responsibleEvidence = null;
    let weakCandidate = null;
    let observationSequence = 0;
    let lastOpponentContactSequenceByTeam = new Map();
    let latestTouchByTeam = new Map();
    let lastKickPlayerId = null;
    let lastKickTimestamp = 0;

    const debug = (...args) => {
        if (config.diagnostics && typeof console !== 'undefined') console.log('[GoalAttribution]', ...args);
    };
    const samePlayer = (a, b) => !!a && !!b && a.playerId === b.playerId;
    const sameOwner = (a, b) => samePlayer(a, b) && a.playerTeam === b.playerTeam;
    const velocity = value => value && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x, y: value.y } : null;
    const publicPlayer = touch => touch ? ({ id: touch.playerId, auth: touch.playerAuth || null, name: touch.playerName, team: touch.playerTeam }) : null;
    const diagnosticPlayer = player => {
        if (!player) return null;
        const { auth, playerAuth, ...safe } = player;
        return safe;
    };
    const withoutAuth = touch => {
        if (!touch) return null;
        const { auth, playerAuth, ...safe } = touch;
        return { ...safe, position: safe.position ? { ...safe.position } : null };
    };
    function noteWeakCandidate(touch, sequence, candidateIds = [touch.playerId]) {
        weakCandidate = {
            ...touch,
            lastEvidenceReason: 'fallback-weak-contact',
            confidence: 'low',
            candidateEvidence: {
                reason: 'fallback-weak-contact', accepted: false, playerId: touch.playerId,
                contactTimestamp: touch.timestamp, observationSequence: sequence,
                candidateIds: [...candidateIds],
            },
        };
    }
    function noteAssistBoundary(contact, sequence, timestamp) {
        const scoringTeam = contact.playerTeam === 1 ? 2 : contact.playerTeam === 2 ? 1 : null;
        if (scoringTeam == null) return;
        lastOpponentContactSequenceByTeam.set(scoringTeam, { sequence, timestamp, playerId: contact.playerId });
    }
    const normalizeTouch = input => ({
        playerId: input.playerId,
        playerAuth: input.playerAuth || null,
        playerName: input.playerName,
        playerTeam: input.playerTeam,
        matchTime: input.matchTime ?? null,
        position: input.position ? { x: input.position.x, y: input.position.y } : null,
        timestamp: input.timestamp,
        firstTouchTimestamp: input.timestamp,
        lastTouchTimestamp: input.timestamp,
        lastKickTimestamp: input.source === 'kick' ? input.timestamp : null,
        source: input.source === 'kick' ? 'kick' : 'proximity',
    });
    function assignResponsibility(touch, takeoverTimestamp, reason, evidenceConfidence = 'medium', evidenceDetails = null) {
        const justifiedTimestamp = Number.isFinite(evidenceDetails?.lastJustifiedTimestamp)
            ? evidenceDetails.lastJustifiedTimestamp
            : Number.isFinite(touch.lastJustifiedTimestamp) ? touch.lastJustifiedTimestamp : takeoverTimestamp;
        const justifiedSequence = Number.isFinite(evidenceDetails?.observationSequence)
            ? evidenceDetails.observationSequence : observationSequence;
        const acceptedEvidence = evidenceDetails || { reason, accepted: true, playerId: touch.playerId, takeoverTimestamp };
        const previous = responsibleTouch;
        if (sameOwner(previous, touch)) {
            // Keep the original takeover timestamp, but refresh the assist
            // window whenever this player makes a newly justified contact.
            previous.lastJustifiedTimestamp = justifiedTimestamp;
            previous.lastJustifiedSequence = justifiedSequence;
            previous.timestamp = justifiedTimestamp;
            previous.lastTouchTimestamp = justifiedTimestamp;
            if (reason === 'explicit-kick') {
                previous.lastKickTimestamp = takeoverTimestamp;
            }
            previous.lastEvidenceReason = reason;
            previous.source = touch.source;
            previous.confidence = evidenceConfidence;
            responsibleEvidence = { ...acceptedEvidence };
            latestTouchByTeam.set(previous.playerTeam, previous);
            lastEvidence = { ...lastEvidence, accepted: true, reason, playerId: previous.playerId,
                takeoverTimestamp: previous.responsibilityTimestamp, lastJustifiedTimestamp: justifiedTimestamp };
            return;
        }
        previousDifferentTouch = previous ? { ...previous } : null;
        responsibleTouch = {
            ...touch,
            responsibilityTimestamp: takeoverTimestamp,
            lastJustifiedTimestamp: justifiedTimestamp,
            lastJustifiedSequence: justifiedSequence,
            lastEvidenceReason: reason,
            confidence: evidenceConfidence,
        };
        latestTouchByTeam.set(responsibleTouch.playerTeam, responsibleTouch);
        responsibleEvidence = { ...acceptedEvidence };
        lastEvidence = { ...lastEvidence, accepted: true, reason, playerId: responsibleTouch.playerId, takeoverTimestamp };
    }
    function recordTouch(input) {
        if (!input || input.playerTeam === 0 || input.playerId == null || !Number.isFinite(input.timestamp)) return false;
        const sequence = ++observationSequence;
        const touch = normalizeTouch(input);
        if (touch.source === 'kick') {
            lastKickPlayerId = touch.playerId;
            lastKickTimestamp = touch.timestamp;
            pendingKicks.push({ playerId: touch.playerId, timestamp: touch.timestamp, team: touch.playerTeam });
            // A kick is an instantaneous attribution event, not evidence that a
            // proximity session before/after it was continuous.
            contactSession = null;
            noteAssistBoundary(touch, sequence, touch.timestamp);
            assignResponsibility(touch, touch.timestamp, 'explicit-kick', 'high', {
                reason: 'explicit-kick', accepted: true, playerId: touch.playerId,
                takeoverTimestamp: touch.timestamp, kickTimestamp: touch.timestamp,
                lastJustifiedTimestamp: touch.timestamp, observationSequence: sequence,
            });
        } else {
            // Compatibility path for callers which still submit a point contact.
            // It cannot establish duration or a trustworthy velocity interval.
            noteWeakCandidate(touch, sequence);
            noteAssistBoundary(touch, sequence, touch.timestamp);
            lastEvidence = { reason: 'proximity-event-without-continuity', accepted: false, playerId: touch.playerId,
                data: 'duration-and-interval-evidence-required' };
        }
        const { playerAuth, ...safeTouch } = touch;
        debug('touch', safeTouch, lastEvidence);
        return true;
    }
    function contactEvidence(touch, reason, timestamp, durationMs = 0) {
        return {
            ...touch,
            responsibilityTimestamp: timestamp,
            lastJustifiedTimestamp: timestamp,
            source: 'proximity',
            lastEvidenceReason: reason,
            confidence: 'medium',
            durationMs,
        };
    }
    function observeTick({ timestamp, contact = null, contactCandidateIds, contactCandidateStates,
        ballVelocity: rawVelocity, ballPosition } = {}) {
        if (!Number.isFinite(timestamp)) {
            breakContinuity('invalid-tick-timestamp');
            return false;
        }
        const sequence = ++observationSequence;
        const currentVelocity = velocity(rawVelocity);
        const normalizedContact = contact && contact.team !== 0
            ? normalizeTouch({
                playerId: contact.playerId ?? contact.id,
                playerAuth: contact.playerAuth,
                playerName: contact.playerName ?? contact.name,
                playerTeam: contact.playerTeam ?? contact.team,
                timestamp,
                matchTime: contact.matchTime ?? null,
                position: ballPosition ?? contact.position ?? null,
                source: 'proximity',
            }) : null;
        const candidateIds = Array.isArray(contactCandidateIds)
            ? [...new Set(contactCandidateIds.filter(id => id != null))].sort((a, b) => a - b)
            : normalizedContact ? [normalizedContact.playerId] : [];
        const unambiguousContact = !!normalizedContact && candidateIds.length === 1 &&
            candidateIds[0] === normalizedContact.playerId;
        const ambiguousObservation = candidateIds.length > 1 ||
            (!!normalizedContact && !unambiguousContact) || (!normalizedContact && candidateIds.length > 0);
        if (unambiguousContact) {
            noteWeakCandidate(normalizedContact, sequence, candidateIds);
            noteAssistBoundary(normalizedContact, sequence, timestamp);
        }
        const candidateStates = Array.isArray(contactCandidateStates) ? contactCandidateStates :
            contact?.disc ? [{ id: contact.id ?? contact.playerId, x: contact.disc.x, y: contact.disc.y }] : [];
        const gap = lastObservation ? timestamp - lastObservation.timestamp : null;
        const continuousTick = !!lastObservation && gap >= 0 && gap <= config.maxTickGapMs;
        const sameContinuousPlayer = !!contactSession && continuousTick && normalizedContact &&
            contactSession.playerId === normalizedContact.playerId &&
            contactSession.playerTeam === normalizedContact.playerTeam &&
            lastObservation.contactPlayerId === normalizedContact.playerId &&
            lastObservation.contactPlayerTeam === normalizedContact.playerTeam;
        const kicksInInterval = pendingKicks;
        pendingKicks = [];

        if (ambiguousObservation) {
            const interruptedSession = contactSession;
            contactSession = null;
            lastEvidence = {
                reason: 'ambiguous-multiple-contact-candidates', accepted: false,
                playerId: normalizedContact?.playerId ?? null, candidateIds,
                durationMs: 0, sessionReset: !!interruptedSession,
                previousSessionDurationMs: interruptedSession?.durationMs ?? 0,
                kickPlayerIds: kicksInInterval.map(kick => kick.playerId),
            };
        } else if (!normalizedContact) {
            contactSession = null;
            lastEvidence = {
                reason: kicksInInterval.length ? 'no-contact-after-kick' : 'no-contact-this-tick',
                accepted: false, gapMs: gap, kickPlayerIds: kicksInInterval.map(kick => kick.playerId),
            };
        } else {
            const restartedAfterAmbiguity = lastObservation?.ambiguousContact === true;
            if (!sameContinuousPlayer) {
                contactSession = {
                    ...normalizedContact,
                    startTimestamp: timestamp,
                    lastTimestamp: timestamp,
                    durationMs: 0,
                    ambiguous: false,
                    tickCount: 1,
                    restartedAfterAmbiguity,
                };
            } else {
                contactSession.lastTimestamp = timestamp;
                contactSession.lastTouchTimestamp = timestamp;
                contactSession.tickCount++;
                contactSession.durationMs = (contactSession.tickCount - 1) * config.tickDurationMs;
            }

            const physicsPairValid = sameContinuousPlayer && lastObservation.ballVelocity && currentVelocity &&
                lastObservation.ballPosition && ballPosition && lastObservation.tickCandidateIds.length === 1 &&
                lastObservation.tickCandidateIds[0] === normalizedContact.playerId && candidateIds.length === 1 &&
                candidateIds[0] === normalizedContact.playerId && lastObservation.candidateStates.length === 1 &&
                lastObservation.candidateStates[0].id === normalizedContact.playerId && candidateStates.length === 1 &&
                candidateStates[0].id === normalizedContact.playerId && Number.isFinite(candidateStates[0].x) &&
                Number.isFinite(candidateStates[0].y) && Number.isFinite(lastObservation.candidateStates[0].x) &&
                Number.isFinite(lastObservation.candidateStates[0].y);
            if (kicksInInterval.length) {
                lastEvidence = {
                    reason: 'velocity-ignored-kick-in-sampling-interval', accepted: false,
                    kickPlayerIds: kicksInInterval.map(kick => kick.playerId), intervalGapMs: gap,
                    contactPlayerId: normalizedContact.playerId,
                    sessionRestartedAfterAmbiguity: contactSession.restartedAfterAmbiguity,
                };
            } else if (contactSession.durationMs >= config.significantContactMs && !contactSession.ambiguous) {
                const acceptedEvidence = { reason: 'sustained-contact', accepted: true, playerId: normalizedContact.playerId,
                    durationMs: contactSession.durationMs, sessionTicks: contactSession.tickCount, intervalGapMs: gap,
                    sessionRestartedAfterAmbiguity: contactSession.restartedAfterAmbiguity,
                    lastJustifiedTimestamp: timestamp, observationSequence: sequence };
                const evidence = contactEvidence(normalizedContact, acceptedEvidence.reason, timestamp, contactSession.durationMs);
                assignResponsibility(evidence, contactSession.startTimestamp, acceptedEvidence.reason, 'medium', acceptedEvidence);
                lastEvidence = acceptedEvidence;
            } else if (contactSession.ambiguous) {
                lastEvidence = { reason: 'ambiguous-multiple-contact-candidates', accepted: false,
                    playerId: normalizedContact.playerId, candidateIds, durationMs: contactSession.durationMs };
            } else if (!physicsPairValid) {
                lastEvidence = {
                    reason: !continuousTick ? 'physics-interval-unavailable-or-gap' : 'contact-not-present-at-both-samples',
                    accepted: false, playerId: normalizedContact.playerId,
                    durationMs: contactSession.durationMs, intervalGapMs: gap,
                    sessionRestartedAfterAmbiguity: contactSession.restartedAfterAmbiguity,
                };
            } else {
                const before = lastObservation.ballVelocity;
                const after = currentVelocity;
                const beforeSpeed = Math.hypot(before.x, before.y);
                const afterSpeed = Math.hypot(after.x, after.y);
                const dot = before.x * after.x + before.y * after.y;
                const angleRadians = beforeSpeed > 0.1 && afterSpeed > 0.1
                    ? Math.acos(Math.max(-1, Math.min(1, dot / (beforeSpeed * afterSpeed)))) : 0;
                const delta = Math.hypot(after.x - before.x, after.y - before.y);
                const largeDirectionChange = angleRadians >= config.significantTurnRadians;
                const strongDelta = delta >= config.significantSpeedChange;
                const strongDirectionChange = largeDirectionChange && delta >= config.minDirectionalDelta;
                const strong = strongDelta || strongDirectionChange;
                if (strong) {
                    const playerDx = candidateStates[0].x - lastObservation.candidateStates[0].x;
                    const playerDy = candidateStates[0].y - lastObservation.candidateStates[0].y;
                    const playerMotion = Math.hypot(playerDx, playerDy);
                    const impulseX = after.x - before.x, impulseY = after.y - before.y;
                    const sourceAlignment = playerMotion > 0.1
                        ? (impulseX * playerDx + impulseY * playerDy) / (delta * playerMotion) : -1;
                    if (sourceAlignment < 0.5) {
                        lastEvidence = { reason: 'velocity-source-ambiguous', accepted: false,
                            playerId: normalizedContact.playerId, deltaSpeedVector: delta, angleRadians,
                            playerMotion, sourceAlignment, intervalGapMs: gap, contactCandidateIds: candidateIds,
                            minDirectionalDelta: config.minDirectionalDelta };
                    } else {
                        const reason = largeDirectionChange && delta >= config.minDirectionalDelta
                            ? 'velocity-direction-change' : 'velocity-change';
                        const acceptedEvidence = { reason, accepted: true, playerId: normalizedContact.playerId,
                            deltaSpeedVector: delta, angleRadians, playerMotion, sourceAlignment,
                            intervalGapMs: gap, contactCandidateIds: candidateIds,
                            minDirectionalDelta: config.minDirectionalDelta,
                            lastJustifiedTimestamp: timestamp, observationSequence: sequence };
                        const evidence = contactEvidence(normalizedContact, reason, timestamp, contactSession.durationMs);
                        assignResponsibility(evidence, timestamp, reason, 'medium', acceptedEvidence);
                        lastEvidence = acceptedEvidence;
                    }
                } else {
                    const reason = largeDirectionChange && delta < config.minDirectionalDelta
                        ? 'direction-change-below-minimum-delta' : 'velocity-change-below-threshold';
                    lastEvidence = { reason, accepted: false,
                        playerId: normalizedContact.playerId, deltaSpeedVector: delta, angleRadians, intervalGapMs: gap,
                        contactCandidateIds: candidateIds, minDirectionalDelta: config.minDirectionalDelta,
                        significantSpeedChange: config.significantSpeedChange };
                }
            }
        }
        lastObservation = {
            timestamp, ballVelocity: currentVelocity,
            ballPosition: ballPosition && Number.isFinite(ballPosition.x) && Number.isFinite(ballPosition.y)
                ? { x: ballPosition.x, y: ballPosition.y } : null,
            contactPlayerId: normalizedContact?.playerId ?? null,
            contactPlayerTeam: normalizedContact?.playerTeam ?? null,
            ambiguousContact: ambiguousObservation,
            tickCandidateIds: candidateIds,
            candidateStates: candidateStates.map(candidate => ({ ...candidate })),
        };
        return true;
    }
    function resolveAssist(scorer) {
        const candidate = previousDifferentTouch;
        if (!candidate) return { assister: null, reason: 'no-assist-candidate' };
        if (candidate.playerTeam !== scorer.playerTeam) return { assister: null, reason: 'assist-blocked-by-opponent' };
        if (samePlayer(candidate, scorer)) return { assister: null, reason: 'no-assist-candidate' };
        const opponentBoundary = lastOpponentContactSequenceByTeam.get(scorer.playerTeam);
        if (opponentBoundary && opponentBoundary.sequence > (candidate.lastJustifiedSequence ?? -Infinity)) {
            return { assister: null, reason: 'assist-blocked-by-opponent-contact' };
        }
        const elapsed = scorer.responsibilityTimestamp - candidate.lastJustifiedTimestamp;
        if (elapsed < 0) return { assister: null, reason: 'assist-negative-interval' };
        if (elapsed > config.assistTimeWindowMs) return { assister: null, reason: 'assist-expired' };
        return { assister: publicPlayer(candidate), reason: 'assist-found' };
    }
    function makeResult(type, scorer, scoringTeam, reason, confidence = 'high') {
        if (!scorer) return { type: 'unknown', scorer: null, assister: null, isOwnGoal: false,
            confidence: 'low', reason: 'no-attribution-candidate', candidateReason: null,
            evidence: { ...lastEvidence }, candidateEvidence: null, assistReason: null };
        const own = type === 'own_goal';
        const assist = !own && scorer.playerTeam === scoringTeam ? resolveAssist(scorer) : { assister: null, reason: own ? null : 'assist-blocked-by-opponent' };
        return { type: own ? 'own_goal' : 'goal', scorer: publicPlayer(scorer), assister: assist.assister,
            isOwnGoal: own, confidence, reason, candidateReason: scorer.lastEvidenceReason,
            responsibilityTimestamp: scorer.responsibilityTimestamp, evidence: { ...lastEvidence },
            candidateEvidence: responsibleEvidence ? { ...responsibleEvidence } : null, assistReason: assist.reason };
    }
    function makeWeakFallbackResult(scoringTeam) {
        const own = weakCandidate.playerTeam !== scoringTeam;
        return {
            type: own ? 'own_goal' : 'goal', scorer: publicPlayer(weakCandidate), assister: null,
            isOwnGoal: own, confidence: 'low', reason: 'fallback-weak-contact',
            candidateReason: 'fallback-weak-contact', responsibilityTimestamp: null,
            evidence: { ...lastEvidence }, candidateEvidence: { ...weakCandidate.candidateEvidence },
            assistReason: 'no-assist-candidate',
        };
    }
    function resolveGoal({ scoringTeam }) {
        let result;
        if (!responsibleTouch && weakCandidate) result = makeWeakFallbackResult(scoringTeam);
        else if (!responsibleTouch) result = makeResult('goal', null, scoringTeam, 'no-attribution-candidate', 'low');
        else if (responsibleTouch.playerTeam === scoringTeam) result = makeResult('goal', responsibleTouch, scoringTeam,
            'last-touch-scoring-team', responsibleTouch.source === 'kick' ? 'high' : responsibleTouch.confidence || 'medium');
        else if (responsibleTouch.source === 'kick') result = makeResult('own_goal', responsibleTouch, scoringTeam, 'opponent-kick-own-goal', 'high');
        else result = makeResult('own_goal', responsibleTouch, scoringTeam,
            `significant-opponent-contact:${responsibleTouch.lastEvidenceReason}`, 'medium');
        debug('goal', { ...result, scorer: diagnosticPlayer(result.scorer), assister: diagnosticPlayer(result.assister) }, getDebugState());
        return result;
    }
    function resetPlay() {
        responsibleTouch = null;
        previousDifferentTouch = null;
        contactSession = null;
        lastObservation = null;
        pendingKicks = [];
        lastEvidence = { reason: 'play-reset', accepted: false };
        responsibleEvidence = null;
        weakCandidate = null;
        observationSequence = 0;
        lastOpponentContactSequenceByTeam = new Map();
        latestTouchByTeam = new Map();
        lastKickPlayerId = null;
        lastKickTimestamp = 0;
    }
    function breakContinuity(reason = 'observation-continuity-broken') {
        contactSession = null;
        lastObservation = null;
        pendingKicks = [];
        lastEvidence = { reason, accepted: false };
    }
    function breakPlayerContinuity(playerId, reason = 'player-continuity-broken') {
        if (playerId == null) return false;
        const sessionInvolvesPlayer = contactSession?.playerId === playerId;
        const observationInvolvesPlayer = !!lastObservation && (
            lastObservation.contactPlayerId === playerId ||
            lastObservation.tickCandidateIds.includes(playerId) ||
            lastObservation.candidateStates.some(candidate => candidate.id === playerId)
        );
        if (!sessionInvolvesPlayer && !observationInvolvesPlayer) return false;
        contactSession = null;
        lastObservation = null;
        // Keep pending kicks so the next sampled interval still rejects their
        // velocity impulse, even if the team-change callback arrives in between.
        lastEvidence = { reason, accepted: false, playerId };
        return true;
    }
    function resetMatch() { resetPlay(); }
    function getTouches() {
        return [previousDifferentTouch, responsibleTouch].filter(Boolean).map(withoutAuth);
    }
    function selectClosestContact({ ballPosition, ballRadius, players, timestamp }) {
        if (!ballPosition || !Number.isFinite(ballPosition.x) || !Number.isFinite(ballPosition.y) ||
            !Number.isFinite(ballRadius) || !Array.isArray(players)) return null;
        let best = null;
        const candidates = [];
        for (const candidate of players) {
            if (!candidate || candidate.team === 0 || !candidate.disc || !Number.isFinite(candidate.disc.x) ||
                !Number.isFinite(candidate.disc.y) || !Number.isFinite(candidate.playerRadius)) continue;
            const dx = candidate.disc.x - ballPosition.x;
            const dy = candidate.disc.y - ballPosition.y;
            const distance = Math.hypot(dx, dy);
            const limit = ballRadius + candidate.playerRadius + config.contactTolerance;
            if (distance > limit) continue;
            candidates.push({ id: candidate.id, x: candidate.disc.x, y: candidate.disc.y });
            const key = { distance, playerId: candidate.id };
            if (!best || key.distance < best.key.distance - config.tieDistanceTolerance ||
                (Math.abs(key.distance - best.key.distance) <= config.tieDistanceTolerance && key.playerId < best.key.playerId)) {
                best = { player: candidate, distance, key };
            }
        }
        if (!best) return null;
        candidates.sort((a, b) => a.id - b.id);
        return { player: best.player, distance: best.distance,
            candidateIds: candidates.map(candidate => candidate.id), candidateStates: candidates };
    }
    function getDebugState() {
        return {
            currentTouch: withoutAuth(contactSession),
            previousDifferentTouch: withoutAuth(previousDifferentTouch),
            responsibleTouch: withoutAuth(responsibleTouch),
            weakCandidate: withoutAuth(weakCandidate),
            assistBoundaries: Object.fromEntries(lastOpponentContactSequenceByTeam),
            latestTouchByTeam: Object.fromEntries([...latestTouchByTeam].map(([team, touch]) => [team, withoutAuth(touch)])),
            contactSession: withoutAuth(contactSession),
            lastObservation: lastObservation ? { ...lastObservation,
                ballPosition: lastObservation.ballPosition ? { ...lastObservation.ballPosition } : null,
                ballVelocity: lastObservation.ballVelocity ? { ...lastObservation.ballVelocity } : null,
                candidateStates: lastObservation.candidateStates.map(candidate => ({ ...candidate })) } : null,
            pendingKickPlayerIds: pendingKicks.map(kick => kick.playerId),
            lastEvidence: { ...lastEvidence }, responsibleEvidence: responsibleEvidence ? { ...responsibleEvidence } : null,
            lastKickPlayerId, lastKickTimestamp, config: { ...config },
        };
    }
    return { resetMatch, resetPlay, breakContinuity, breakPlayerContinuity, recordTouch, observeTick,
        resolveGoal, getTouches, getDebugState, selectClosestContact, config };
}

export class GoalAttributionEngine {
    constructor(options = {}) { this.engine = createGoalAttributionEngine(options); }
    resetMatch() { return this.engine.resetMatch(); }
    resetPlay() { return this.engine.resetPlay(); }
    breakContinuity(reason) { return this.engine.breakContinuity(reason); }
    breakPlayerContinuity(playerId, reason) { return this.engine.breakPlayerContinuity(playerId, reason); }
    recordTouch(touch) { return this.engine.recordTouch(touch); }
    observeTick(input) { return this.engine.observeTick(input); }
    resolveGoal(goal) { return this.engine.resolveGoal(goal); }
    getTouches() { return this.engine.getTouches(); }
    getDebugState() { return this.engine.getDebugState(); }
    selectClosestContact(input) { return this.engine.selectClosestContact(input); }
}
