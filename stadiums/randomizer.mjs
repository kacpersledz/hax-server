export const BUILTIN_STADIUMS = [
    { name: 'Classic', file: 'classic.hbs', sourceSha: '9e0aa039fc395fb02c4669f9aa00feaacef2e350' },
    { name: 'Rounded', file: 'rounded.hbs', sourceSha: '938e8796ffbd72e39d5271d03113ef785095baf7' },
    { name: 'Easy', file: 'easy.hbs', sourceSha: '39726b460f5e396886b47e3bbc7091a25c536421' },
    { name: 'Small', file: 'small.hbs', sourceSha: '94d51dac3c011a72bb2f48d85d72159fecfb260c' },
    { name: 'Hockey', file: 'hockey.hbs', sourceSha: '9c82f471f1f6cc551a2ef118c822652fd1cd9df4' },
    { name: 'Big', file: 'big.hbs', sourceSha: '89861213f2de3888d13c138587eb0aff178b4025' },
    { name: 'Big Rounded', file: 'big_rounded.hbs', sourceSha: '7f1e73a245f31e9200dbd5bc1ae27f3387ab4ce9' },
    { name: 'Big Easy', file: 'big_easy.hbs', sourceSha: 'e53c389576c844456a0027a8487c9b98790c4ec0' },
    { name: 'Big Hockey', file: 'big_hockey.hbs', sourceSha: 'a9b07188a1607cbff7f38d6adf5f0bb8d57aec3b' },
    { name: 'Huge', file: 'huge.hbs', sourceSha: 'fb73cfe906faeb5327330c28b8559bf77d456f7d' },
];

export const KICK_MULTIPLIERS = [1.10, 1.15, 1.20, 1.25, 1.30];
export const KICK_STRENGTHS = KICK_MULTIPLIERS.map(multiplier => multiplier * 5);
export const BALL_DAMPING_VALUES = [0.985, 0.9875, 0.990];

export function getStadiumPhysics(definition) {
    function resolveDamping(object, stadium, fallback = 0.99) {
        if (Number.isFinite(object?.damping)) return object.damping;
        const trait = object?.trait && stadium.traits?.[object.trait];
        return Number.isFinite(trait?.damping) ? trait.damping : fallback;
    }

    const stadium = typeof definition === 'string' ? JSON.parse(definition) : definition;
    if (!stadium || typeof stadium !== 'object' || Array.isArray(stadium)) {
        throw new TypeError('Stadium definition must be a JSON object.');
    }

    const kickStrength = Number.isFinite(stadium.playerPhysics?.kickStrength)
        ? stadium.playerPhysics.kickStrength
        : 5;

    let damping = 0.99;
    if (stadium.ballPhysics === 'disc0') {
        if (!stadium.discs?.[0]) {
            throw new Error('Stadium uses ballPhysics "disc0" but has no first disc.');
        }
        damping = resolveDamping(stadium.discs[0], stadium);
    } else if (stadium.ballPhysics !== undefined) {
        if (!stadium.ballPhysics || typeof stadium.ballPhysics !== 'object' || Array.isArray(stadium.ballPhysics)) {
            throw new Error('Unsupported ballPhysics representation.');
        }
        damping = resolveDamping(stadium.ballPhysics, stadium);
    }

    return { kickStrength, kickMultiplier: kickStrength / 5, damping };
}

export function randomizeStadiumDefinition(definition, random = Math.random) {
    const kickMultipliers = [1.10, 1.15, 1.20, 1.25, 1.30];
    const ballDampingValues = [0.985, 0.9875, 0.990];

    function pickDiscreteValue(values) {
        const sample = random();
        if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
            throw new RangeError('Random source must return a number in [0, 1).');
        }
        return values[Math.floor(sample * values.length)];
    }

    function parseDefinition(value) {
        const stadium = typeof value === 'string' ? JSON.parse(value) : value;
        if (!stadium || typeof stadium !== 'object' || Array.isArray(stadium)) {
            throw new TypeError('Stadium definition must be a JSON object.');
        }
        return JSON.parse(JSON.stringify(stadium));
    }

    const stadium = parseDefinition(definition);
    const kickMultiplier = pickDiscreteValue(kickMultipliers);
    const kickStrength = kickMultiplier * 5;
    const damping = pickDiscreteValue(ballDampingValues);

    if (stadium.playerPhysics === undefined) {
        stadium.playerPhysics = {};
    } else if (!stadium.playerPhysics || typeof stadium.playerPhysics !== 'object' || Array.isArray(stadium.playerPhysics)) {
        throw new Error('Unsupported playerPhysics representation.');
    }
    stadium.playerPhysics = { ...stadium.playerPhysics, kickStrength };

    if (stadium.ballPhysics === undefined) {
        // A partial ballPhysics object inherits HaxBall's other default ball properties.
        stadium.ballPhysics = { damping };
    } else if (stadium.ballPhysics === 'disc0') {
        if (!Array.isArray(stadium.discs) || !stadium.discs[0]) {
            throw new Error('Stadium uses ballPhysics "disc0" but has no first disc.');
        }
        stadium.discs[0] = { ...stadium.discs[0], damping };
    } else if (stadium.ballPhysics && typeof stadium.ballPhysics === 'object' && !Array.isArray(stadium.ballPhysics)) {
        stadium.ballPhysics = { ...stadium.ballPhysics, damping };
    } else {
        throw new Error('Unsupported ballPhysics representation.');
    }

    return { stadium, kickMultiplier, kickStrength, damping };
}

/**
 * Room-side command and stadium state handler. Kept self-contained so it can be
 * serialized into the browser context that owns the HaxBall room.
 */
export function createStadiumRandomizer({
    room,
    builtinStadiums,
    customStadiumSource,
    randomizeDefinition,
    getPhysics,
    isGameRunning,
    random = Math.random,
    confirmationTimeoutMs = 5000,
    confirmationPollMs = 25,
    schedule = setTimeout,
    cancelSchedule = clearTimeout,
}) {
    const builtins = new Map(builtinStadiums.map(stadium => [stadium.name, stadium.source]));
    const customName = 'AAAAuto Arena';
    let selected = { name: customName, source: customStadiumSource, type: 'custom' };
    let randomizedPhysics = null;
    let physicsStatus = 'unknown';
    let stadiumIdentityKnown = false;
    let pending = null;
    let unconfirmedReason = 'Initial stadium selection has not been confirmed.';
    // Events carry no operation id. Remember cancelled targets so an
    // indistinguishable late event cannot satisfy a later identical request.
    const abandonedTargets = new Set();
    const abandonedNames = new Set();

    function readBallDamping() {
        const damping = room.getDiscProperties?.(0)?.damping;
        return Number.isFinite(damping) ? damping : null;
    }

    function sameDamping(left, right) {
        return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 1e-9;
    }

    function targetKey(name, damping) {
        return `${name}\u0000${damping}`;
    }

    function clearAbandonedTargets(name) {
        for (const key of abandonedTargets) {
            if (key.startsWith(`${name}\u0000`)) abandonedTargets.delete(key);
        }
        abandonedNames.delete(name);
    }

    function clearTimers(operation) {
        if (operation.timeout !== null) cancelSchedule(operation.timeout);
        if (operation.poll !== null) cancelSchedule(operation.poll);
        operation.timeout = null;
        operation.poll = null;
    }

    function finish(operation, message, { confirmed = false, uncertain = false } = {}) {
        if (pending !== operation) return;
        clearTimers(operation);
        pending = null;
        if (confirmed) {
            randomizedPhysics = operation.kind === 'randomize' ? operation.physics : null;
            physicsStatus = operation.kind === 'randomize' ? 'randomized' : 'original';
            if (operation.identityAffecting) stadiumIdentityKnown = true;
            unconfirmedReason = null;
            abandonedTargets.delete(operation.key);
        } else if (uncertain) {
            randomizedPhysics = null;
            physicsStatus = 'unknown';
            if (operation.identityAffecting) stadiumIdentityKnown = false;
            unconfirmedReason = 'A stadium setter may have taken effect without a matching confirmation.';
            abandonedTargets.add(operation.key);
            abandonedNames.add(operation.expectedName);
        } else {
            // A synchronous setter exception still leaves the room-side state
            // uncertain: Headless API setters provide no resulting state value.
            randomizedPhysics = null;
            physicsStatus = 'unknown';
            if (operation.identityAffecting) stadiumIdentityKnown = false;
            unconfirmedReason = 'The stadium setter failed; physics state is unconfirmed.';
        }
        operation.resolve(message);
    }

    function checkConfirmation(operation) {
        if (pending !== operation) return;
        const damping = readBallDamping();
        const dampingMatches = sameDamping(damping, operation.physics.damping);
        const dampingChangedToTarget = dampingMatches
            && Number.isFinite(operation.beforeDamping)
            && !sameDamping(operation.beforeDamping, operation.physics.damping);

        // A matching event confirms the selected stadium. When a damping
        // getter is available, also wait until it reflects the requested value.
        if (operation.eventSeen && (damping === null || dampingMatches)) {
            finish(operation, operation.successMessage('event'), { confirmed: true });
            return;
        }

        // Some Headless API versions may not emit onStadiumChange when a
        // custom stadium is reloaded under the same name. A real transition in
        // the ball's live damping is useful evidence; an already-equal value
        // is not, because it cannot distinguish an ignored request.
        if (dampingChangedToTarget) {
            finish(operation, operation.successMessage('damping'), { confirmed: true });
        }
    }

    function pollConfirmation(operation) {
        if (pending !== operation) return;
        checkConfirmation(operation);
        if (pending === operation) {
            operation.poll = schedule(() => pollConfirmation(operation), confirmationPollMs);
        }
    }

    function cancelPending(message, { uncertain = false } = {}) {
        if (!pending) return;
        const operation = pending;
        finish(operation, message, { uncertain });
    }

    function resolveSelectedPhysics() {
        if (physicsStatus === 'randomized' && randomizedPhysics) return randomizedPhysics;
        if (physicsStatus === 'original' && selected.source) return getPhysics(selected.source);
        return {
            kickStrength: null,
            kickMultiplier: null,
            damping: readBallDamping(),
        };
    }

    function formatInfo() {
        const physics = resolveSelectedPhysics();
        const kick = physics.kickMultiplier === null
            ? 'unknown'
            : `${physics.kickMultiplier.toFixed(2)}x`;
        const damping = physics.damping === null ? 'unknown' : String(physics.damping);
        const status = physicsStatus === 'unknown' ? 'unknown / unconfirmed' : physicsStatus;
        const stadiumLabel = stadiumIdentityKnown ? selected.name : `${selected.name} (last selected; current stadium unknown)`;
        const confirmation = pending
            ? '\n⏳ Waiting for stadium confirmation.'
            : !stadiumIdentityKnown || unconfirmedReason
                ? `\n⚠️ ${unconfirmedReason || 'Stadium identity or physics are unconfirmed. Manually select a supported stadium to resynchronize.'}`
                : '';
        return `🏟 ${stadiumLabel}\n⚽ Kick: ${kick}\n🛑 Damping: ${damping}\n🎲 Physics: ${status}${confirmation}`;
    }

    function onStadiumChange(newStadiumName, byPlayer) {
        // A player event always wins over a pending setter and becomes the new
        // base template. Its event is also the confirmation of the manual map.
        if (byPlayer != null) {
            const hadPending = pending !== null;
            cancelPending('⚠️ Stadium request canceled because a player changed the stadium before confirmation.', { uncertain: true });

            const source = builtins.get(newStadiumName);
            if (source) {
                selected = { name: newStadiumName, source, type: 'builtin' };
            } else if (newStadiumName === customName) {
                selected = { name: customName, source: customStadiumSource, type: 'custom' };
            } else {
                selected = { name: newStadiumName || 'Unknown custom stadium', source: null, type: 'unsupported' };
            }
            randomizedPhysics = null;
            if (hadPending) {
                // The player selection is known at this instant, but the
                // canceled asynchronous setter could still apply afterward.
                stadiumIdentityKnown = false;
                physicsStatus = 'unknown';
                unconfirmedReason = 'A canceled stadium change may still apply. Manually select a supported stadium again after it settles.';
            } else if (abandonedNames.size > 0) {
                stadiumIdentityKnown = false;
                physicsStatus = 'unknown';
                unconfirmedReason = 'A canceled programmatic change may still apply. Wait for its callback, then manually select a supported stadium to resynchronize.';
            } else {
                stadiumIdentityKnown = true;
                physicsStatus = selected.type === 'unsupported' ? 'unknown' : 'original';
                unconfirmedReason = selected.type === 'unsupported'
                    ? 'Physics are unknown for this custom stadium.'
                    : null;
            }
            return;
        }

        // A late callback can mean the actual room changed after cancellation.
        // The API has no current-stadium getter, so retain the last manual base
        // for display but block changes until a player selects a supported map.
        if (!pending) {
            const wasAbandoned = abandonedNames.has(newStadiumName);
            if (wasAbandoned || newStadiumName !== selected.name) {
                stadiumIdentityKnown = false;
                randomizedPhysics = null;
                physicsStatus = 'unknown';
                unconfirmedReason = `A programmatic stadium change to ${newStadiumName || 'an unknown stadium'} arrived without a matching request. Manually select a supported stadium to resynchronize.`;
            }
            clearAbandonedTargets(newStadiumName);
            return;
        }

        if (newStadiumName !== pending.expectedName) {
            const operation = pending;
            finish(operation, `⚠️ Stadium changed to ${newStadiumName || 'an unknown stadium'} while a different change was pending. Manually select a supported stadium to resynchronize.`, { uncertain: true });
            stadiumIdentityKnown = false;
            unconfirmedReason = `Unexpected programmatic stadium change to ${newStadiumName || 'an unknown stadium'}; current stadium identity is unknown. Manually select a supported stadium to resynchronize.`;
            clearAbandonedTargets(newStadiumName);
            return;
        }

        const damping = readBallDamping();
        const dampingChangedToTarget = sameDamping(damping, pending.physics.damping)
            && Number.isFinite(pending.beforeDamping)
            && !sameDamping(pending.beforeDamping, pending.physics.damping);
        // If an older operation for this name was interrupted, a name-only
        // event is ambiguous. A new observed damping transition can still
        // confirm this request; an already-equal value cannot.
        if (abandonedNames.has(newStadiumName) && !dampingChangedToTarget) {
            clearAbandonedTargets(newStadiumName);
            return;
        }
        pending.eventSeen = true;
        checkConfirmation(pending);
    }

    function beginOperation({ kind, source, expectedName, physics, setter, successMessage, identityAffecting = false }) {
        const beforeDamping = readBallDamping();
        const key = targetKey(expectedName, physics.damping);
        if (kind !== 'reset' && abandonedTargets.has(key)) {
            return Promise.resolve(`❌ Cannot confirm this ${expectedName} change safely: an earlier request for this stadium may still emit an indistinguishable late event. Select another stadium or restart the room before retrying with the current damping.`);
        }

        let resolve;
        const result = new Promise(done => { resolve = done; });
        const operation = {
            kind,
            source,
            expectedName,
            physics,
            identityAffecting,
            key,
            beforeDamping,
            eventSeen: false,
            timeout: null,
            poll: null,
            resolve,
            successMessage,
        };
        pending = operation;
        unconfirmedReason = null;
        operation.timeout = schedule(() => {
            finish(operation, `❌ The ${expectedName} change was not confirmed within ${confirmationTimeoutMs} ms. It may have applied, but its state is unconfirmed.`, { uncertain: true });
        }, confirmationTimeoutMs);
        operation.poll = schedule(() => pollConfirmation(operation), confirmationPollMs);

        try {
            setter();
        } catch (error) {
            finish(operation, `❌ Could not ${kind === 'reset' ? 'restore' : 'randomize'} ${expectedName}: ${error.message}`);
        }
        return result;
    }

    function handleCommand(player, message) {
        const match = /^!(randomize|r)(?:\s+(reset|info))?$/i.exec(String(message).trim());
        if (!match) return null;

        const action = (match[2] || 'apply').toLowerCase();
        if (action === 'info') return formatInfo();

        if (player?.admin !== true) return '❌ Only admins can change stadium physics.';
        if (isGameRunning()) return '⚠️ Stop the match before randomizing physics.';
        if (pending) return '⚠️ A stadium change is already awaiting confirmation.';
        if (!stadiumIdentityKnown) {
            return '⚠️ Current stadium identity is uncertain. Manually select a supported stadium to resynchronize before changing physics.';
        }
        if (selected.type === 'unsupported') {
            return `❌ Cannot change physics for unsupported custom stadium: ${selected.name}.`;
        }

        if (action === 'reset') {
            if (physicsStatus === 'original' && !unconfirmedReason) {
                return '✅ Original physics already active.';
            }
            const expectedPhysics = getPhysics(selected.source);
            try {
                return beginOperation({
                    kind: 'reset',
                    source: selected.source,
                    expectedName: selected.name,
                    physics: expectedPhysics,
                    setter: () => {
                        if (selected.type === 'builtin') room.setDefaultStadium(selected.name);
                        else room.setCustomStadium(customStadiumSource);
                    },
                    successMessage: confirmation => confirmation === 'damping'
                        ? `✅ ${selected.name} reset; original ball damping ${expectedPhysics.damping} was observed. Kick strength has no Headless API readback.`
                        : `✅ ${selected.name} original physics restored. Kick strength has no Headless API readback.`,
                });
            } catch (error) {
                return `❌ Could not restore ${selected.name}: ${error.message}`;
            }
        }

        try {
            const result = randomizeDefinition(selected.source, random);
            const physics = {
                kickStrength: result.kickStrength,
                kickMultiplier: result.kickMultiplier,
                damping: result.damping,
            };
            return beginOperation({
                kind: 'randomize',
                source: selected.source,
                expectedName: selected.name,
                physics,
                setter: () => room.setCustomStadium(JSON.stringify(result.stadium)),
                successMessage: confirmation => confirmation === 'damping'
                    ? `🎲 ${selected.name} stadium change confirmed by live ball damping.\n⚽ Kick set to ${result.kickMultiplier.toFixed(2)}x (the Headless API has no kick-strength readback)\n🛑 Damping: ${result.damping}`
                    : `🎲 ${selected.name} randomized.\n⚽ Kick set to ${result.kickMultiplier.toFixed(2)}x (the Headless API has no kick-strength readback)\n🛑 Damping: ${result.damping} (confirmed)`,
            });
        } catch (error) {
            return `❌ Could not randomize ${selected.name}: ${error.message}`;
        }
    }

    return {
        handleCommand,
        onStadiumChange,
        initializeStadium() {
            const physics = getPhysics(customStadiumSource);
            return beginOperation({
                kind: 'reset',
                source: customStadiumSource,
                expectedName: customName,
                physics,
                identityAffecting: true,
                setter: () => room.setCustomStadium(customStadiumSource),
                successMessage: () => 'Initial stadium selection confirmed.',
            });
        },
        onGameStart() {
            cancelPending('⚠️ Match started before the stadium change was confirmed. No success was reported.', { uncertain: true });
        },
        getState() {
            return {
                stadium: selected.name,
                type: selected.type,
                randomized: randomizedPhysics !== null,
                physics: resolveSelectedPhysics(),
                physicsStatus,
                stadiumIdentityKnown,
                pending: pending !== null,
                unconfirmed: unconfirmedReason !== null,
            };
        },
    };
}
