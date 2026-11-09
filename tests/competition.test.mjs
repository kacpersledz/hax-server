import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompetition } from '../competition/controller.mjs';

function harness() {
    const roster = [1,2,3,4].map(id => ({ id, team: 0, admin: id === 1 }));
    const announcements = [], lineups = [];
    let running = false, controller;
    const room = {
        getPlayerList: () => roster,
        sendAnnouncement: m => announcements.push(m),
        setPlayerTeam(id, team) { roster.find(p => p.id === id).team = team; },
        startGame() { running = true; lineups.push(roster.map(p => p.team)); controller.onGameStart(); },
    };
    const randomizer = { handleCommand: async () => '🎲 randomized', getState: () => ({ randomized:true, pending:false, unconfirmed:false, stadiumIdentityKnown:true }) };
    controller = createCompetition({ room, randomizer, getAuth: id => String(id), isRunning: () => running, random: () => 0 });
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));
    return { roster, announcements, lineups, controller, settle, stop() { running = false; controller.onGameStop(); } };
}
test('six matches cover all three partnerships with a rematch', async () => {
    const h = harness(); h.controller.handleCommand(h.roster[0], '!comp start'); await h.settle();
    for (let i = 0; i < 6; i++) { h.stop(); await h.settle(); }
    assert.equal(h.lineups.length, 6);
    for (let i = 0; i < 6; i += 2) assert.deepEqual(h.lineups[i + 1], h.lineups[i].map(t => 3-t));
    assert.equal(new Set([0,2,4].map(i => h.lineups[i].map((t,j) => t === 1 ? j : '').filter(String).join(','))).size, 3);
    assert.match(h.announcements.at(-1), /Koniec zawodów/);
});
test('pause after a player leaves prevents progression until teams are restored', async () => {
    const h = harness(); h.controller.handleCommand(h.roster[0], '!comp mode single'); h.controller.handleCommand(h.roster[0], '!comp start'); await h.settle();
    h.roster[1].team = 0; h.controller.onPlayerTeamChange(h.roster[1], h.roster[0]); h.stop(); await h.settle();
    assert.equal(h.lineups.length, 1); assert.match(h.controller.handleCommand(h.roster[0], '!comp resume'), /nie są przywrócone/);
    h.roster[1].team = h.lineups[0][1]; h.controller.handleCommand(h.roster[0], '!comp resume'); await h.settle(); assert.equal(h.lineups.length, 2);
});
