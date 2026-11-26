export function createGoalAttributionEngine(options = {}) {
    const DEFAULTS = {
        assistTimeWindowMs: 3000,
        // Touches are retained until a play/match reset. A timeout is not
        // evidence that a ball in flight changed owner.
        proximityAfterKickSuppressMs: 250,
        contactTolerance: 0.5,
        tieDistanceTolerance: 0.01,
        significantContactMs: 300,
        significantSpeedChange: 2.5,
        significantTurnRadians: Math.PI / 4,
        diagnostics: false,
    };
    const config = { ...DEFAULTS, ...options };
    let currentTouch = null;
    let previousDifferentTouch = null;
    let responsibleTouch = null;
    let latestTouchByTeam = new Map();
    let lastKickPlayerId = null;
    let lastKickTimestamp = 0;

    const debug = (...args) => {
        if (config.diagnostics && typeof console !== 'undefined') console.log('[GoalAttribution]', ...args);
    };
    const samePlayer = (a, b) => a && b && a.playerId === b.playerId;
    const publicPlayer = touch => touch ? ({ id: touch.playerId, auth: touch.playerAuth || null, name: touch.playerName, team: touch.playerTeam }) : null;
    const velocity = value => value && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x, y: value.y } : null;
    const speed = value => value ? Math.hypot(value.x, value.y) : null;

    function normalizeTouch(touch) {
        return {
            playerId: touch.playerId, playerAuth: touch.playerAuth || null,
            playerName: touch.playerName, playerTeam: touch.playerTeam,
            timestamp: touch.timestamp, matchTime: touch.matchTime ?? null,
            position: touch.position ? { x: touch.position.x, y: touch.position.y } : null,
            source: touch.source === 'kick' ? 'kick' : 'proximity',
            ballVelocity: velocity(touch.ballVelocity),
            velocityBefore: velocity(touch.velocityBefore),
            velocityAfter: velocity(touch.velocityAfter),
            durationMs: Number.isFinite(touch.durationMs) ? touch.durationMs : 0,
            significant: false,
            significanceReason: 'awaiting-contact-evidence',
        };
    }
    function contactEvidence(touch) {
        if (touch.source === 'kick') return { significant: true, reason: 'explicit-kick' };
        if (touch.durationMs >= config.significantContactMs) return { significant: true, reason: 'sustained-contact' };
        const before = touch.velocityBefore, after = touch.velocityAfter;
        if (!before || !after) return { significant: false, reason: 'insufficient-physics-data' };
        const bs = speed(before), as = speed(after);
        const dot = before.x * after.x + before.y * after.y;
        const angle = bs > 0.1 && as > 0.1 ? Math.acos(Math.max(-1, Math.min(1, dot / (bs * as)))) : 0;
        if (Math.hypot(after.x - before.x, after.y - before.y) >= config.significantSpeedChange || angle >= config.significantTurnRadians) {
            return { significant: true, reason: angle >= config.significantTurnRadians ? 'velocity-direction-change' : 'velocity-change' };
        }
        return { significant: false, reason: 'minor-deflection' };
    }
    function recordTouch(input) {
        if (!input || input.playerTeam === 0 || input.playerId == null || input.timestamp == null) return false;
        const touch = normalizeTouch(input);
        if (touch.source === 'kick') { lastKickPlayerId = touch.playerId; lastKickTimestamp = touch.timestamp; }
        const evidence = contactEvidence(touch);
        touch.significant = evidence.significant;
        touch.significanceReason = evidence.reason;
        if (samePlayer(currentTouch, touch)) {
            touch.firstTouchTimestamp = currentTouch.firstTouchTimestamp;
            touch.lastTouchTimestamp = touch.timestamp;
            touch.lastKickTimestamp = touch.source === 'kick' ? touch.timestamp : currentTouch.lastKickTimestamp;
            touch.durationMs = Math.max(touch.durationMs, touch.timestamp - currentTouch.firstTouchTimestamp);
            const combined = contactEvidence(touch);
            touch.significant ||= currentTouch.significant || combined.significant;
            if (combined.significant) touch.significanceReason = combined.reason;
            else if (currentTouch.significant) touch.significanceReason = currentTouch.significanceReason;
            const priorSource = currentTouch.source;
            currentTouch = { ...currentTouch, ...touch, source: priorSource === 'kick' || touch.source === 'kick' ? 'kick' : 'proximity' };
            latestTouchByTeam.set(currentTouch.playerTeam, currentTouch);
            if (touch.significant) {
                if (!samePlayer(responsibleTouch, touch)) previousDifferentTouch = responsibleTouch;
                responsibleTouch = { ...currentTouch };
            }
        } else {
            const prior = currentTouch;
            if (prior) {
                prior.durationMs = Math.max(prior.durationMs || 0, prior.lastTouchTimestamp - prior.firstTouchTimestamp);
                const priorEvidence = contactEvidence(prior);
                prior.significant ||= priorEvidence.significant;
                prior.significanceReason = priorEvidence.reason;
                if (prior.significant && !samePlayer(responsibleTouch, prior)) {
                    previousDifferentTouch = responsibleTouch;
                    responsibleTouch = { ...prior };
                }
            }
            touch.firstTouchTimestamp = touch.timestamp;
            touch.lastTouchTimestamp = touch.timestamp;
            currentTouch = { ...touch, firstTouchTimestamp: touch.timestamp, lastTouchTimestamp: touch.timestamp,
                lastKickTimestamp: touch.source === 'kick' ? touch.timestamp : null };
            latestTouchByTeam.set(currentTouch.playerTeam, currentTouch);
            if (touch.significant) {
                if (!samePlayer(responsibleTouch, touch)) previousDifferentTouch = responsibleTouch;
                responsibleTouch = { ...currentTouch };
            }
        }
        const { playerAuth, ...diagnosticTouch } = touch;
        debug('touch', diagnosticTouch, { significant: touch.significant, reason: touch.significanceReason });
        return true;
    }
    function resolveAssist(scorer, scoringTeam, timestamp) {
        const candidate = previousDifferentTouch;
        if (!candidate) return { assister: null, reason: 'no-assist-candidate' };
        if (candidate.playerTeam !== scoringTeam) return { assister: null, reason: 'assist-blocked-by-opponent' };
        if (samePlayer(candidate, scorer)) return { assister: null, reason: 'no-assist-candidate' };
        if (scorer.firstTouchTimestamp - candidate.lastTouchTimestamp > config.assistTimeWindowMs) return { assister: null, reason: 'assist-expired' };
        return { assister: publicPlayer(candidate), reason: 'assist-found' };
    }
    function makeResult(type, scorer, scoringTeam, timestamp, reason, confidence = 'high') {
        if (!scorer) return { type: 'unknown', scorer: null, assister: null, isOwnGoal: false, confidence: 'low', reason: 'no-attribution-candidate', candidateReason: null, assistReason: null };
        const own = type === 'own_goal';
        const assist = !own && scorer.playerTeam === scoringTeam ? resolveAssist(scorer, scoringTeam, timestamp) : { assister: null, reason: own ? null : 'assist-blocked-by-opponent' };
        return { type: own ? 'own_goal' : 'goal', scorer: publicPlayer(scorer), assister: assist.assister, isOwnGoal: own, confidence,
            reason, candidateReason: scorer.significanceReason, assistReason: assist.reason };
    }
    function resolveGoal({ scoringTeam, timestamp }) {
        // A current sustained/proven physical contact may qualify at the goal
        // boundary, even if no subsequent tick ended its contact interval.
        if (currentTouch && !currentTouch.significant) {
            currentTouch.durationMs = Math.max(currentTouch.durationMs || 0,
                currentTouch.lastTouchTimestamp - currentTouch.firstTouchTimestamp);
            const evidence = contactEvidence(currentTouch);
            if (evidence.significant) {
                currentTouch.significant = true;
                currentTouch.significanceReason = evidence.reason;
                if (!samePlayer(responsibleTouch, currentTouch)) previousDifferentTouch = responsibleTouch;
                responsibleTouch = { ...currentTouch };
            }
        }
        let result;
        if (!responsibleTouch) result = makeResult('goal', null, scoringTeam, timestamp, 'no-attribution-candidate');
        else if (responsibleTouch.playerTeam === scoringTeam) result = makeResult('goal', responsibleTouch, scoringTeam, timestamp,
            'last-touch-scoring-team', responsibleTouch.source === 'kick' ? 'high' : 'medium');
        else if (responsibleTouch.source === 'kick') result = makeResult('own_goal', responsibleTouch, scoringTeam, timestamp, 'opponent-kick-own-goal');
        else result = makeResult('own_goal', responsibleTouch, scoringTeam, timestamp, `significant-opponent-contact:${responsibleTouch.significanceReason}`, 'medium');
        debug('goal', result, getDebugState());
        return result;
    }
    function resetPlay() {
        currentTouch = null; previousDifferentTouch = null; responsibleTouch = null;
        latestTouchByTeam = new Map(); lastKickPlayerId = null; lastKickTimestamp = 0;
    }
    function resetMatch() { resetPlay(); }
    function getTouches() { return [previousDifferentTouch, currentTouch].filter(Boolean).map(t => ({ ...t, position: t.position ? { ...t.position } : null })); }
    function selectClosestContact({ ballPosition, ballRadius, players, timestamp }) {
        if (!ballPosition || !Number.isFinite(ballRadius) || !Array.isArray(players)) return null;
        let best = null;
        for (const candidate of players) {
            if (!candidate || candidate.team === 0 || !candidate.disc || !Number.isFinite(candidate.playerRadius)) continue;
            const dx = candidate.disc.x - ballPosition.x, dy = candidate.disc.y - ballPosition.y;
            const distance = Math.hypot(dx, dy), limit = ballRadius + candidate.playerRadius + config.contactTolerance;
            if (distance > limit) continue;
            const key = { distance, kickTie: candidate.id === lastKickPlayerId && Math.abs(timestamp - lastKickTimestamp) <= config.proximityAfterKickSuppressMs ? 0 : 1, playerId: candidate.id };
            if (!best || key.distance < best.key.distance - config.tieDistanceTolerance ||
                (Math.abs(key.distance - best.key.distance) <= config.tieDistanceTolerance && (key.kickTie < best.key.kickTie || (key.kickTie === best.key.kickTie && key.playerId < best.key.playerId)))) best = { player: candidate, distance, key };
        }
        return best ? { player: best.player, distance: best.distance } : null;
    }
    function getDebugState() {
        const clean = touch => {
            if (!touch) return null;
            const { playerAuth, ...rest } = touch;
            return { ...rest, position: rest.position ? { ...rest.position } : null };
        };
        return { currentTouch: clean(currentTouch), previousDifferentTouch: clean(previousDifferentTouch), responsibleTouch: clean(responsibleTouch),
            latestTouchByTeam: Object.fromEntries([...latestTouchByTeam].map(([team, touch]) => [team, clean(touch)])),
            lastKickPlayerId, lastKickTimestamp, config: { ...config } };
    }
    return { resetMatch, resetPlay, recordTouch, resolveGoal, getTouches, getDebugState, selectClosestContact, config };
}

export class GoalAttributionEngine {
    constructor(options = {}) { this.engine = createGoalAttributionEngine(options); }
    resetMatch() { return this.engine.resetMatch(); }
    resetPlay() { return this.engine.resetPlay(); }
    recordTouch(touch) { return this.engine.recordTouch(touch); }
    resolveGoal(goal) { return this.engine.resolveGoal(goal); }
    getTouches() { return this.engine.getTouches(); }
    getDebugState() { return this.engine.getDebugState(); }
    selectClosestContact(input) { return this.engine.selectClosestContact(input); }
}
