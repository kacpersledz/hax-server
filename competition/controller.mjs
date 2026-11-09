// Runs inside the headless browser; keep this factory self-contained.
export function createCompetition({ room, randomizer, getAuth, isRunning, random = Math.random }) {
    let mode = 'rematch', series = null, generation = 0, applyingTeams = false;
    const say = text => room.sendAnnouncement(text, null, 0xFFFFFF, 'normal', 1);
    const help = 'Przywróć uczestników do właściwych drużyn i użyj !comp resume. !comp stop kończy zawody.';
    const players = () => room.getPlayerList();
    const validTeams = () => series && series.teams.every((side, i) => side.every(auth => players().some(p => getAuth(p.id) === auth && p.team === i + 1))) && players().filter(p => p.team !== 0).length === 4;
    function pause(reason) {
        if (!series) return;
        series.paused = true;
        generation++;
        say(`⚠️ Zawody wstrzymane: ${reason} ${help}`);
    }
    function nextTeams() {
        const [a,b,c,d] = series.participants;
        const arrangements = [[[a,b],[c,d]], [[a,c],[b,d]], [[a,d],[b,c]]];
        const match = series.schedule[series.index];
        const teams = arrangements[match.pair].map(side => [...side]);
        return match.rematch ? [teams[1], teams[0]] : teams;
    }
    async function prepare() {
        if (!series || series.paused) return;
        if (series.index >= series.schedule.length) {
            say(`🏁 Koniec zawodów — rozegrano ${series.schedule.length} meczów.`);
            series = null; return;
        }
        const current = series, token = ++generation;
        current.teams = nextTeams();
        const match = current.schedule[current.index];
        say(`${current.index === 0 ? '🏆 Początek zawodów' : match.rematch ? '🔁 Rewanż' : '🔀 Zmiana składów'} — mecz ${current.index + 1}/${current.schedule.length}. Losuję fizykę…`);
        applyingTeams = true;
        try {
            for (const p of players()) {
                const auth = getAuth(p.id);
                const team = current.teams.findIndex(side => side.includes(auth)) + 1;
                if (p.team !== team) room.setPlayerTeam(p.id, team);
            }
        } finally { applyingTeams = false; }
        // Team changes can be delivered asynchronously by the room.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (series !== current || generation !== token || current.paused) return;
        if (!validTeams()) return pause('nie udało się ustawić składów.');
        const response = await randomizer.handleCommand({ admin: true }, '!r');
        if (series !== current || generation !== token || current.paused) return;
        const state = randomizer.getState();
        if (!String(response).startsWith('🎲') || !state.randomized || state.pending || state.unconfirmed || !state.stadiumIdentityKnown) return pause(`losowanie fizyki nie powiodło się. ${response}`);
        if (!validTeams() || isRunning()) return pause('stan pokoju zmienił się przed startem.');
        say(response);
        current.expectedStart = true;
        room.startGame();
    }
    function handleCommand(player, message) {
        const match = /^!comp(?:\s+(.*))?$/i.exec(message.trim());
        if (!match) return null;
        if (!player.admin) return '❌ Tylko admin może sterować zawodami.';
        const arg = (match[1] || 'status').toLowerCase().trim();
        if (arg === 'status') return series ? `🏆 Mecz ${series.index + 1}/${series.schedule.length}; ${series.paused ? 'wstrzymane' : 'aktywne'}.` : `🏆 Zawody nieaktywne. Tryb: ${mode}.`;
        if (arg === 'mode single' || arg === 'mode rematch') {
            if (series) return '⚠️ Zmień tryb po zakończeniu zawodów.';
            mode = arg.split(' ')[1]; return `✅ Tryb zawodów: ${mode}.`;
        }
        if (arg === 'start') {
            if (series) return '⚠️ Zawody już trwają.';
            if (isRunning()) return '⚠️ Zatrzymaj mecz przed rozpoczęciem zawodów.';
            const list = players();
            const identities = list.map(p => getAuth(p.id));
            if (list.length !== 4 || identities.some(x => !x) || new Set(identities).size !== 4) return '⚠️ Potrzeba dokładnie czterech graczy z poprawną identyfikacją.';
            const pairs = [0,1,2];
            for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
            const schedule = pairs.flatMap(pair => mode === 'rematch' ? [{pair, rematch:false}, {pair, rematch:true}] : [{pair, rematch:false}]);
            series = { participants: identities, schedule, index: 0, teams: null, paused: false, expectedStart: false, matchActive: false };
            void prepare(); return '🏆 Rozpoczynam zawody.';
        }
        if (arg === 'stop') {
            if (!series) return '⚠️ Zawody nie trwają.';
            generation++; series = null; return '🏁 Zawody zakończone przez admina.';
        }
        if (arg === 'pause') {
            if (!series) return '⚠️ Zawody nie trwają.';
            pause('decyzja admina.'); return '⏸️ Zawody wstrzymane.';
        }
        if (arg === 'resume') {
            if (!series || !series.paused) return '⚠️ Zawody nie są wstrzymane.';
            if (!validTeams()) return `⚠️ Składy nie są przywrócone. ${help}`;
            series.paused = false;
            if (!isRunning()) void prepare();
            return '▶️ Zawody wznowione.';
        }
        return 'Komendy: !comp start, !comp mode single|rematch, !comp status, !comp pause, !comp resume, !comp stop.';
    }
    return {
        handleCommand,
        isMatchActive() { return !!series?.matchActive; },
        onGameStart() { if (!series) return; if (!series.expectedStart) { pause('mecz uruchomiono ręcznie.'); return; } series.expectedStart = false; series.matchActive = true; },
        onGameStop() { if (!series || !series.matchActive) return; series.matchActive = false; series.index++; if (!series.paused) void prepare(); },
        onPlayerLeave(player) { if (series && series.participants.includes(getAuth(player.id))) pause('uczestnik opuścił pokój.'); },
        onPlayerTeamChange(player, byPlayer) { if (series && !applyingTeams && byPlayer && !validTeams()) pause('zmieniono skład.'); },
        onStadiumChange(name, byPlayer) { if (series && byPlayer) pause('ręcznie zmieniono stadion.'); },
    };
}
