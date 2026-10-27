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
}) {
    const builtins = new Map(builtinStadiums.map(stadium => [stadium.name, stadium.source]));
    const customName = 'AAAAuto Arena';
    let selected = { name: customName, source: customStadiumSource, type: 'custom' };
    let randomizedPhysics = null;

    function resolveSelectedPhysics() {
        if (randomizedPhysics) return randomizedPhysics;
        if (selected.source) return getPhysics(selected.source);
        const ball = room.getDiscProperties?.(0);
        return {
            kickStrength: null,
            kickMultiplier: null,
            damping: Number.isFinite(ball?.damping) ? ball.damping : null,
        };
    }

    function formatInfo() {
        const physics = resolveSelectedPhysics();
        const kick = physics.kickMultiplier === null
            ? 'unknown'
            : `${physics.kickMultiplier.toFixed(2)}x`;
        const damping = physics.damping === null ? 'unknown' : String(physics.damping);
        const status = randomizedPhysics ? 'randomized' : 'original';
        return `🏟 ${selected.name}\n⚽ Kick: ${kick}\n🛑 Damping: ${damping}\n🎲 Physics: ${status}`;
    }

    function onStadiumChange(newStadiumName, byPlayer) {
        // The Headless API uses null for programmatic changes. Preserve the
        // selected base template while our own custom stadium is applied.
        if (byPlayer == null) return;

        const source = builtins.get(newStadiumName);
        if (source) {
            selected = { name: newStadiumName, source, type: 'builtin' };
        } else if (newStadiumName === customName) {
            selected = { name: customName, source: customStadiumSource, type: 'custom' };
        } else {
            selected = { name: newStadiumName || 'Unknown custom stadium', source: null, type: 'unsupported' };
        }
        randomizedPhysics = null;
    }

    function handleCommand(player, message) {
        const match = /^!(randomize|r)(?:\s+(reset|info))?$/i.exec(String(message).trim());
        if (!match) return null;

        const action = (match[2] || 'apply').toLowerCase();
        if (action === 'info') return formatInfo();

        if (player?.admin !== true) return '❌ Only admins can change stadium physics.';
        if (isGameRunning()) return '⚠️ Stop the match before randomizing physics.';
        if (selected.type === 'unsupported') {
            return `❌ Cannot change physics for unsupported custom stadium: ${selected.name}.`;
        }

        if (action === 'reset') {
            try {
                if (selected.type === 'builtin') {
                    room.setDefaultStadium(selected.name);
                } else {
                    room.setCustomStadium(customStadiumSource);
                }
                randomizedPhysics = null;
                return `✅ ${selected.name} original physics restored.`;
            } catch (error) {
                return `❌ Could not restore ${selected.name}: ${error.message}`;
            }
        }

        try {
            const result = randomizeDefinition(selected.source, random);
            room.setCustomStadium(JSON.stringify(result.stadium));
            randomizedPhysics = {
                kickStrength: result.kickStrength,
                kickMultiplier: result.kickMultiplier,
                damping: result.damping,
            };
            return `🎲 ${selected.name} randomized!\n⚽ Kick: ${result.kickMultiplier.toFixed(2)}x\n🛑 Damping: ${result.damping}`;
        } catch (error) {
            return `❌ Could not randomize ${selected.name}: ${error.message}`;
        }
    }

    return {
        handleCommand,
        onStadiumChange,
        getState() {
            return {
                stadium: selected.name,
                type: selected.type,
                randomized: randomizedPhysics !== null,
                physics: resolveSelectedPhysics(),
            };
        },
    };
}
