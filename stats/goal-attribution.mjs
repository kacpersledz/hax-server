export function createGoalAttributionEngine(options = {}) {
    const DEFAULTS = {
        assistTimeWindowMs: 3000,
        maxGoalTouchAgeMs: 3000,
        ownGoalKickMaxAgeMs: 750,
        proximityAfterKickSuppressMs: 250,
        contactTolerance: 0.5,
        tieDistanceTolerance: 0.01,
        diagnostics: false,
    };
    const config = { ...DEFAULTS, ...options };

    // This is deliberately a pair, rather than a chronological event log. It
    // represents the current ball owner and the player who touched it before
    // that owner. Consecutive contacts from one player enrich currentTouch but
    // never create a new attribution candidate. The tiny team index is only
    // used to recover the attacker through a run of proximity deflections.
    let currentTouch = null;
    let previousDifferentTouch = null;
    let latestTouchByTeam = new Map();
    let lastKickPlayerId = null;
    let lastKickTimestamp = 0;

    const debug = (...args) => {
        if (config.diagnostics && typeof console !== 'undefined') {
            console.log('[GoalAttribution]', ...args);
        }
    };

    const samePlayer = (a, b) => a && b && a.playerId === b.playerId;
    const isRecent = (touch, timestamp) => touch && timestamp - touch.lastTouchTimestamp >= 0 &&
        timestamp - touch.lastTouchTimestamp <= config.maxGoalTouchAgeMs;
    const hasRecentKick = (touch, timestamp) => touch && touch.lastKickTimestamp != null &&
        timestamp - touch.lastKickTimestamp >= 0 && timestamp - touch.lastKickTimestamp <= config.ownGoalKickMaxAgeMs;
    const publicPlayer = (touch) => touch ? ({
        id: touch.playerId,
        auth: touch.playerAuth || null,
        name: touch.playerName,
        team: touch.playerTeam,
    }) : null;

    const normalizeTouch = (touch) => ({
        playerId: touch.playerId,
        playerAuth: touch.playerAuth || null,
        playerName: touch.playerName,
        playerTeam: touch.playerTeam,
        timestamp: touch.timestamp,
        matchTime: touch.matchTime ?? null,
        position: touch.position ? { x: touch.position.x, y: touch.position.y } : null,
        source: touch.source === 'kick' ? 'kick' : 'proximity',
    });

    function createLogicalTouch(touch) {
        return {
            ...touch,
            // `timestamp` remains a diagnostic compatibility alias for the
            // latest physical contact. Goal recency must use the explicit
            // field so it cannot be confused with the kick or takeover time.
            firstTouchTimestamp: touch.timestamp,
            lastTouchTimestamp: touch.timestamp,
            lastKickTimestamp: touch.source === 'kick' ? touch.timestamp : null,
        };
    }

    function mergeCurrentTouch(touch) {
        // A kick is stronger evidence than proximity and must never be
        // downgraded by a later proximity sample from the same player. Its
        // time is tracked independently so that kick evidence cannot be
        // refreshed by subsequent proximity contacts.
        currentTouch = {
            ...currentTouch,
            ...touch,
            firstTouchTimestamp: currentTouch.firstTouchTimestamp,
            lastTouchTimestamp: touch.timestamp,
            lastKickTimestamp: touch.source === 'kick' ? touch.timestamp : currentTouch.lastKickTimestamp,
            source: currentTouch.source === 'kick' || touch.source === 'kick' ? 'kick' : 'proximity',
        };
        latestTouchByTeam.set(currentTouch.playerTeam, currentTouch);
        debug('touch-updated', currentTouch);
    }

    function recordTouch(touch) {
        if (!touch || touch.playerTeam === 0 || touch.playerId == null || touch.timestamp == null) return false;

        const normalized = normalizeTouch(touch);
        if (normalized.source === 'kick') {
            lastKickPlayerId = normalized.playerId;
            lastKickTimestamp = normalized.timestamp;
        }

        if (samePlayer(currentTouch, normalized)) {
            mergeCurrentTouch(normalized);
            return true;
        }

        previousDifferentTouch = currentTouch;
        currentTouch = createLogicalTouch(normalized);
        latestTouchByTeam.set(currentTouch.playerTeam, currentTouch);
        debug('touch', currentTouch, 'previous', previousDifferentTouch);
        return true;
    }

    function resolveAssist(scorerTouch, scoringTeam) {
        const candidate = previousDifferentTouch;
        if (!candidate) return { assister: null, reason: 'no-assist-candidate' };
        if (candidate.playerTeam !== scoringTeam) return { assister: null, reason: 'assist-blocked-by-opponent' };
        if (samePlayer(candidate, scorerTouch)) return { assister: null, reason: 'no-assist-candidate' };

        if (scorerTouch.firstTouchTimestamp - candidate.lastTouchTimestamp > config.assistTimeWindowMs) {
            return { assister: null, reason: 'assist-expired' };
        }
        return { assister: publicPlayer(candidate), reason: 'assist-found' };
    }

    function unknownGoal() {
        return {
            type: 'unknown',
            scorer: null,
            assister: null,
            isOwnGoal: false,
            confidence: 'low',
            reason: 'no-recent-scoring-touch',
            assistReason: null,
        };
    }

    function resolveGoal({ scoringTeam, timestamp }) {
        if (!isRecent(currentTouch, timestamp)) {
            const result = unknownGoal();
            debug('goal', result, getTouches());
            return result;
        }

        if (currentTouch.playerTeam === scoringTeam) {
            const assist = resolveAssist(currentTouch, scoringTeam);
            const result = {
                type: 'goal',
                scorer: publicPlayer(currentTouch),
                assister: assist.assister,
                isOwnGoal: false,
                confidence: 'high',
                reason: 'last-touch-scoring-team',
                assistReason: assist.reason,
            };
            debug('goal', result, getTouches());
            return result;
        }

        if (hasRecentKick(currentTouch, timestamp)) {
            const result = {
                type: 'own_goal',
                scorer: publicPlayer(currentTouch),
                assister: null,
                isOwnGoal: true,
                confidence: 'high',
                reason: 'opponent-kick-own-goal',
                assistReason: null,
            };
            debug('goal', result, getTouches());
            return result;
        }

        // Proximity alone is not enough evidence for an own goal. Recover the
        // latest recent scoring-team touch, while keeping the defender contact
        // as an assist boundary.
        const scoringTouch = latestTouchByTeam.get(scoringTeam);
        if (scoringTouch && isRecent(scoringTouch, timestamp)) {
            const result = {
                type: 'goal',
                scorer: publicPlayer(scoringTouch),
                assister: null,
                isOwnGoal: false,
                confidence: 'medium',
                reason: 'opponent-proximity-deflection',
                assistReason: 'assist-blocked-by-opponent',
            };
            debug('goal', result, getTouches());
            return result;
        }

        const result = unknownGoal();
        debug('goal', result, getTouches());
        return result;
    }

    function resetPlay() {
        currentTouch = null;
        previousDifferentTouch = null;
        latestTouchByTeam = new Map();
        lastKickPlayerId = null;
        lastKickTimestamp = 0;
    }

    function resetMatch() { resetPlay(); }

    function getTouches() {
        return [previousDifferentTouch, currentTouch]
            .filter(Boolean)
            .map(touch => ({ ...touch, position: touch.position ? { ...touch.position } : null }));
    }

    function selectClosestContact({ ballPosition, ballRadius, players, timestamp }) {
        if (!ballPosition || !Number.isFinite(ballRadius) || !Array.isArray(players)) return null;
        let best = null;
        for (const candidate of players) {
            if (!candidate || candidate.team === 0 || !candidate.disc || !Number.isFinite(candidate.playerRadius)) continue;
            const dx = candidate.disc.x - ballPosition.x;
            const dy = candidate.disc.y - ballPosition.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const limit = ballRadius + candidate.playerRadius + config.contactTolerance;
            if (distance > limit) continue;
            const key = {
                distance,
                kickTie: candidate.id === lastKickPlayerId && Math.abs(timestamp - lastKickTimestamp) <= config.proximityAfterKickSuppressMs ? 0 : 1,
                playerId: candidate.id,
            };
            if (!best || key.distance < best.key.distance - config.tieDistanceTolerance ||
                (Math.abs(key.distance - best.key.distance) <= config.tieDistanceTolerance && (key.kickTie < best.key.kickTie || (key.kickTie === best.key.kickTie && key.playerId < best.key.playerId)))) {
                best = { player: candidate, distance, key };
            }
        }
        return best ? { player: best.player, distance: best.distance } : null;
    }

    return { resetMatch, resetPlay, recordTouch, resolveGoal, getTouches, selectClosestContact, config };
}

export class GoalAttributionEngine {
    constructor(options = {}) { this.engine = createGoalAttributionEngine(options); }
    resetMatch() { return this.engine.resetMatch(); }
    resetPlay() { return this.engine.resetPlay(); }
    recordTouch(touch) { return this.engine.recordTouch(touch); }
    resolveGoal(goal) { return this.engine.resolveGoal(goal); }
    getTouches() { return this.engine.getTouches(); }
    selectClosestContact(input) { return this.engine.selectClosestContact(input); }
}
