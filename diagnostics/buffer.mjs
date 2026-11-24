// Self-contained factory: serialized into the HaxBall page by initializeRoom.
export function createDiagnostics() {
    const historyMs = 180000, maxEvents = 16000, maxSnapshots = 1801, maxDecisions = 1000;
    const events = [], snapshots = [], attributionDecisions = [];
    let lastSample = -Infinity;
    const clone = value => JSON.parse(JSON.stringify(value));
    function prune(now) {
        for (const list of [events, snapshots, attributionDecisions]) {
            while (list.length && list[0].timestamp < now - historyMs) list.shift();
        }
    }
    function add(list, value, limit) {
        const item = clone(value);
        prune(item.timestamp);
        list.push(item);
        if (list.length > limit) list.shift();
    }
    return {
        event(value) { add(events, value, maxEvents); },
        decision(value) { add(attributionDecisions, value, maxDecisions); },
        sample(value) {
            if (value.timestamp - lastSample < 100) return;
            lastSample = value.timestamp;
            add(snapshots, value, maxSnapshots);
        },
        report({ trigger, timestamp, comment = null, context = {} }) {
            prune(timestamp);
            return clone({ schemaVersion: 1, trigger, timestamp: new Date(timestamp).toISOString(), comment, context, events, snapshots, attributionDecisions });
        },
    };
}
