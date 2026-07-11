export function createGoalAttributionEngine(options = {}) {
    const DEFAULTS = {
        assistTimeWindowMs: 3000,
        maxGoalTouchAgeMs: 3000,
        samePlayerTouchThrottleMs: 700,
        proximityAfterKickSuppressMs: 250,
        maxTouches: 30,
        contactTolerance: 0.5,
        tieDistanceTolerance: 0.01,
        diagnostics: false,
    };
    const config = { ...DEFAULTS, ...options };
    let touches = [];
    let lastKickPlayerId = null;
    let lastKickTimestamp = 0;

    const debug = (...args) => {
        if (config.diagnostics && typeof console !== 'undefined') {
            console.log('[GoalAttribution]', ...args);
        }
    };

    const samePlayer = (a, b) => a && b && a.playerId === b.playerId;
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
        source: touch.source || 'proximity',
    });

    function mergeLastTouch(touch) {
        const last = touches[touches.length - 1];
        touches[touches.length - 1] = { ...last, ...touch };
        debug('touch-updated', touches[touches.length - 1]);
    }

    function shouldRecord(touch) {
        const last = touches[touches.length - 1];
        if (!last) return { action: 'append' };
        if (!samePlayer(last, touch)) return { action: 'append' };

        const elapsed = touch.timestamp - last.timestamp;
        if (touch.source === 'proximity' && last.source === 'kick' && elapsed <= config.proximityAfterKickSuppressMs) {
            return { action: 'ignore' };
        }
        if (touch.source === 'kick' && last.source === 'proximity') {
            return { action: 'replace-last' };
        }
        if (elapsed >= config.samePlayerTouchThrottleMs) {
            return { action: 'append' };
        }
        return { action: 'ignore' };
    }

    function recordTouch(touch) {
        if (!touch || touch.playerTeam === 0 || touch.playerId == null || touch.timestamp == null) return false;
        const normalized = normalizeTouch(touch);
        if (normalized.source === 'kick') {
            lastKickPlayerId = normalized.playerId;
            lastKickTimestamp = normalized.timestamp;
        }
        const decision = shouldRecord(normalized);
        if (decision.action === 'ignore') return false;
        if (decision.action === 'replace-last') {
            mergeLastTouch(normalized);
            return true;
        }
        touches.push(normalized);
        if (touches.length > config.maxTouches) touches = touches.slice(-config.maxTouches);
        debug('touch', normalized);
        return true;
    }

    function findAssist(scorerTouch, scorerIndex, scoringTeam) {
        let blockedByOpponent = false;
        for (let i = scorerIndex - 1; i >= 0; i--) {
            const touch = touches[i];
            if (samePlayer(touch, scorerTouch)) continue;
            if (touch.playerTeam !== scoringTeam) {
                blockedByOpponent = true;
                break;
            }
            const passToScorerTime = scorerTouch.timestamp - touch.timestamp;
            if (passToScorerTime > config.assistTimeWindowMs) {
                return { assister: null, reason: 'assist-expired' };
            }
            return { assister: publicPlayer(touch), reason: 'assist-found' };
        }
        return { assister: null, reason: blockedByOpponent ? 'assist-blocked-by-opponent' : 'no-assist-candidate' };
    }

    function resolveGoal({ scoringTeam, timestamp }) {
        const goalTimestamp = timestamp;
        const lastIndex = touches.length - 1;
        const lastTouch = touches[lastIndex];
        if (!lastTouch || goalTimestamp - lastTouch.timestamp > config.maxGoalTouchAgeMs) {
            const result = { type: 'unknown', scorer: null, assister: null, isOwnGoal: false, confidence: 'low', reason: 'no-recent-touch', assistReason: null };
            debug('goal', result, touches.slice(-6));
            return result;
        }

        if (lastTouch.playerTeam !== scoringTeam) {
            const result = { type: 'own_goal', scorer: publicPlayer(lastTouch), assister: null, isOwnGoal: true, confidence: 'high', reason: 'last-touch-opponent', assistReason: null };
            debug('goal', result, touches.slice(-6));
            return result;
        }

        const assist = findAssist(lastTouch, lastIndex, scoringTeam);
        const result = { type: 'goal', scorer: publicPlayer(lastTouch), assister: assist.assister, isOwnGoal: false, confidence: 'high', reason: 'last-touch-scoring-team', assistReason: assist.reason };
        debug('goal', result, touches.slice(-6));
        return result;
    }

    function resetPlay() { touches = []; lastKickPlayerId = null; lastKickTimestamp = 0; }
    function resetMatch() { resetPlay(); }
    function getTouches() { return touches.map(t => ({ ...t, position: t.position ? { ...t.position } : null })); }

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
