import { StatsDatabase } from './database.mjs';

const CONFIG = {
    ASSIST_TIME_WINDOW: 5000,  // 5 seconds in ms
    RANK_LIMIT: 10,            // top 10 in !rank
};

/**
 * HaxballStatsTracker - main stats tracking and integration class
 */
export class HaxballStatsTracker {
    constructor(page, dbPath) {
        this.page = page;
        this.db = new StatsDatabase(dbPath);
        this.currentMatch = null;
    }

    /**
     * Initialize database and setup browser integration
     */
    async initialize() {
        // Initialize database schema
        this.db.initialize();

        // Expose functions to browser context
        await this.page.exposeFunction('statsOnPlayerJoin', (auth, name) => {
            this.handlePlayerJoin(auth, name);
        });

        await this.page.exposeFunction('statsOnPlayerLeave', (auth) => {
            this.handlePlayerLeave(auth);
        });

        await this.page.exposeFunction('statsOnGameStart', (players) => {
            this.handleGameStart(players);
        });

        await this.page.exposeFunction('statsOnGameStop', (matchResult) => {
            this.handleGameStop(matchResult);
        });

        await this.page.exposeFunction('statsOnTeamGoal', (team, scorer, assister) => {
            this.handleTeamGoal(team, scorer, assister);
        });

        await this.page.exposeFunction('statsOnPlayerChat', (auth, message) => {
            return this.handlePlayerChat(auth, message);
        });

        console.log('📊 Stats tracker initialized successfully');
    }

    /**
     * Handle player join
     */
    handlePlayerJoin(auth, name) {
        this.db.upsertPlayer(auth, name);
        console.log(`[Stats] Player joined: ${name} (${auth})`);
    }

    /**
     * Handle player leave
     */
    handlePlayerLeave(auth) {
        const player = this.db.getPlayer(auth);
        if (player) {
            console.log(`[Stats] Player left: ${player.name}`);
        }
    }

    /**
     * Handle game start
     */
    handleGameStart(players) {
        this.currentMatch = {
            startTime: Date.now(),
            players: players, // { auth, name, team }[]
            playerStats: {}, // { auth: { goals, assists, startTime } }
        };

        // Initialize player stats for this match
        for (const player of players) {
            this.currentMatch.playerStats[player.auth] = {
                goals: 0,
                assists: 0,
                startTime: Date.now(),
            };
        }

        console.log(`[Stats] Match started with ${players.length} players`);
    }

    /**
     * Handle team goal
     */
    handleTeamGoal(team, scorer, assister) {
        if (!this.currentMatch) return;

        if (!scorer) {
            console.log(`[Stats] Goal - Team: ${team}, Scorer: UNKNOWN (no ball touches recorded), Assister: N/A`);
            return; // Can't attribute goal to anyone
        }

        console.log(`[Stats] Goal - Team: ${team}, Scorer: ${scorer.name}, Assister: ${assister?.name || 'none'}`);

        // Update scorer stats
        if (scorer) {
            // Check if own goal
            const isOwnGoal = scorer.team !== team;

            if (isOwnGoal) {
                // Own goal - update in database immediately only for stable auth identities.
                if (scorer.auth) {
                    this.db.updatePlayerStats(scorer.auth, { own_goals: 1 });
                }
                console.log(`[Stats] Own goal by ${scorer.name}`);
            } else {
                // Regular goal
                if (this.currentMatch.playerStats[scorer.auth]) {
                    this.currentMatch.playerStats[scorer.auth].goals++;
                }
            }
        }

        // Update assister stats
        if (assister) {
            if (this.currentMatch.playerStats[assister.auth]) {
                this.currentMatch.playerStats[assister.auth].assists++;
            }
        }
    }

    /**
     * Handle game stop
     */
    handleGameStop(matchResult) {
        if (!this.currentMatch) return;

        const { scoreRed, scoreBlue, redPlayers, bluePlayers } = matchResult;
        const duration = Math.floor((Date.now() - this.currentMatch.startTime) / 1000);

        console.log(`[Stats] Match ended: Red ${scoreRed} - ${scoreBlue} Blue (${duration}s)`);

        // Determine match outcome
        let redOutcome, blueOutcome;
        if (scoreRed > scoreBlue) {
            redOutcome = 'win';
            blueOutcome = 'loss';
        } else if (scoreBlue > scoreRed) {
            redOutcome = 'loss';
            blueOutcome = 'win';
        } else {
            redOutcome = blueOutcome = 'draw';
        }

        // Check clean sheets
        const redCleanSheet = scoreBlue === 0 && redOutcome === 'win';
        const blueCleanSheet = scoreRed === 0 && blueOutcome === 'win';

        // Update player statistics
        const updatePlayerMatchStats = (playerAuth, team, outcome, cleanSheet) => {
            const matchStats = this.currentMatch.playerStats[playerAuth] || { goals: 0, assists: 0 };
            const player = this.db.getPlayer(playerAuth);
            if (!player) return;

            const updates = {
                games: 1,
                goals: matchStats.goals,
                assists: matchStats.assists,
                minutes_played: Math.floor(duration / 60),
            };

            // Win/Loss/Draw
            if (outcome === 'win') {
                updates.wins = 1;
                const newStreak = player.current_streak + 1;
                updates.current_streak = newStreak;
                if (newStreak > player.best_streak) {
                    updates.best_streak = newStreak;
                }
            } else if (outcome === 'loss') {
                updates.losses = 1;
                updates.current_streak = 0; // Reset streak
            } else {
                updates.draws = 1;
                updates.current_streak = 0; // Draw also resets streak
            }

            // Clean sheet
            if (cleanSheet) {
                updates.clean_sheets = 1;
            }

            this.db.updatePlayerStats(playerAuth, updates);
        };

        // Update all players
        for (const player of redPlayers) {
            updatePlayerMatchStats(player.auth, 1, redOutcome, redCleanSheet);
        }
        for (const player of bluePlayers) {
            updatePlayerMatchStats(player.auth, 2, blueOutcome, blueCleanSheet);
        }

        // Save match to database
        const matchPlayers = [];
        for (const player of redPlayers) {
            const stats = this.currentMatch.playerStats[player.auth] || { goals: 0, assists: 0 };
            matchPlayers.push({
                auth: player.auth,
                team: 1,
                goals: stats.goals,
                assists: stats.assists,
            });
        }
        for (const player of bluePlayers) {
            const stats = this.currentMatch.playerStats[player.auth] || { goals: 0, assists: 0 };
            matchPlayers.push({
                auth: player.auth,
                team: 2,
                goals: stats.goals,
                assists: stats.assists,
            });
        }

        this.db.saveMatch({
            scoreRed,
            scoreBlue,
            duration,
            players: matchPlayers,
        });

        // Reset current match
        this.currentMatch = null;
    }

    /**
     * Handle player chat - process commands
     */
    handlePlayerChat(auth, message) {
        const msg = message.trim();

        // !help
        if (msg === '!help') {
            return this.formatHelp();
        }

        // !stats [player] or !me
        if (msg.startsWith('!stats') || msg === '!me') {
            const args = msg.split(' ');
            let targetPlayer;

            if (msg === '!me' || args.length === 1) {
                // Show own stats
                targetPlayer = this.db.getPlayer(auth);
            } else {
                // Show stats for named player
                const playerName = args.slice(1).join(' ');
                targetPlayer = this.db.getPlayerByName(playerName);
            }

            if (!targetPlayer) {
                return '❌ Gracz nie znaleziony';
            }

            return this.formatStats(targetPlayer);
        }

        // !rank
        if (msg === '!rank') {
            const topPlayers = this.db.getTopPlayers(CONFIG.RANK_LIMIT);
            return this.formatRank(topPlayers);
        }

        // !last
        if (msg === '!last') {
            const lastMatch = this.db.getLastMatch();
            if (!lastMatch) {
                return '❌ Brak zapisanych meczów';
            }
            return this.formatLastMatch(lastMatch);
        }

        return null; // Not a stats command
    }

    /**
     * Format time played from minutes to human-readable format
     */
    formatTimePlayed(minutes) {
        if (minutes === 0) return '0m';

        const days = Math.floor(minutes / 1440); // 1440 minutes in a day
        const hours = Math.floor((minutes % 1440) / 60);
        const mins = minutes % 60;

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (mins > 0) parts.push(`${mins}m`);

        return parts.join(' ');
    }

    /**
     * Format player stats for display
     */
    formatStats(player) {
        const winRate = this.calculateWinRate(player);
        const goalsPerGame = player.games > 0 ? (player.goals / player.games).toFixed(2) : '0.00';
        const timePlayed = this.formatTimePlayed(player.minutes_played);

        return `📊 Statystyki: ${player.name}
⚽ Bramki: ${player.goals} | Asysty: ${player.assists} | Samobóje: ${player.own_goals}
🎮 Mecze: ${player.games} (${player.wins}W-${player.losses}L-${player.draws}D) | Win Rate: ${winRate}%
🏆 Clean Sheets: ${player.clean_sheets} | Czas gry: ${timePlayed}
📈 Streak: ${player.current_streak} (best: ${player.best_streak}) | Goals/Match: ${goalsPerGame}`;
    }

    /**
     * Format ranking for display
     */
    formatRank(players) {
        if (players.length === 0) {
            return '❌ Brak graczy w rankingu';
        }

        let output = `🏆 TOP ${Math.min(players.length, CONFIG.RANK_LIMIT)} STRZELCÓW:\n`;
        players.forEach((player, index) => {
            const goals = player.goals === 1 ? 'gol' : (player.goals < 5 ? 'gole' : 'goli');
            output += `${index + 1}. ${player.name} - ${player.goals} ${goals}\n`;
        });

        return output.trim();
    }

    /**
     * Format last match for display
     */
    formatLastMatch(match) {
        const redPlayers = match.players.filter(p => p.team === 1);
        const bluePlayers = match.players.filter(p => p.team === 2);

        let output = `🏁 Ostatni mecz: 🔴 Red ${match.score_red} - ${match.score_blue} Blue 🔵\n`;

        // Red scorers
        const redScorers = redPlayers.filter(p => p.goals > 0);
        if (redScorers.length > 0) {
            const scorersList = redScorers.map(p => `${p.name} (${p.goals})`).join(', ');
            output += `⚽ Strzelcy 🔴 Red: ${scorersList}\n`;
        } else {
            output += `⚽ Strzelcy 🔴 Red: Brak\n`;
        }

        // Blue scorers
        const blueScorers = bluePlayers.filter(p => p.goals > 0);
        if (blueScorers.length > 0) {
            const scorersList = blueScorers.map(p => `${p.name} (${p.goals})`).join(', ');
            output += `⚽ Strzelcy 🔵 Blue: ${scorersList}`;
        } else {
            output += `⚽ Strzelcy 🔵 Blue: Brak`;
        }

        return output;
    }

    /**
     * Format help message for display
     */
    formatHelp() {
        return `📖 DOSTĘPNE KOMENDY:
!help - pokazuje tę wiadomość
!me - twoje statystyki
!stats [nazwa] - statystyki gracza
!rank - ranking top ${CONFIG.RANK_LIMIT} strzelców
!last - wyniki ostatniego meczu`;
    }

    /**
     * Calculate win rate (draws count as 0.5 wins)
     */
    calculateWinRate(player) {
        const totalGames = player.wins + player.losses + player.draws;
        if (totalGames === 0) return '0.0';

        const effectiveWins = player.wins + (player.draws * 0.5);
        return ((effectiveWins / totalGames) * 100).toFixed(1);
    }

    /**
     * Clear all statistics
     */
    async clearStats() {
        await this.db.clearStats();
    }

    /**
     * Delete test players (names starting with ___test)
     */
    async deleteTestPlayers() {
        return await this.db.deleteTestPlayers();
    }

    /**
     * Delete a specific player's stats by name
     */
    async deletePlayerStats(playerName) {
        return await this.db.deletePlayerStats(playerName);
    }

    /**
     * Get all players for admin tools
     */
    getAllPlayers() {
        return this.db.getAllPlayers();
    }

    /**
     * Merge one player into another by auth
     */
    async mergePlayers(sourceAuth, targetAuth) {
        return await this.db.mergePlayers(sourceAuth, targetAuth);
    }

    /**
     * Close database connection
     */
    close() {
        this.db.close();
    }
}
