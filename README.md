# hax-server

A HaxBall room hosted through the Headless API, with match statistics and
optional randomized stadium physics.

## Chat commands

| Command | Description |
| --- | --- |
| `!help` | Show the command list. |
| `!me` | Show your statistics. |
| `!stats [name]` | Show your statistics or another player's statistics. |
| `!rank` | Show the top ten scorers. |
| `!last` | Show the latest recorded match. |
| `!randomize` / `!r` | Randomize the selected stadium's kick strength and ball damping. Admin only; the match must be stopped. |
| `!randomize reset` / `!r reset` | Restore the selected stadium's original physics. Admin only; the match must be stopped. |
| `!randomize info` / `!r info` | Show the selected stadium, kick multiplier, damping, and whether its physics are original or randomized. Available to everyone, including during a match. |

The statistics commands require a validated player auth. Physics changes check
the player's current HaxBall admin flag. A running or paused match counts as
active, so randomization and reset are rejected until the game is stopped.
These commands never stop or restart a match.

## Randomized physics

`!randomize` supports the ten built-in stadiums and the custom `AAAAuto Arena`
(`stadiums/rounded-fast.hbs`). It makes independent, uniform selections from
these discrete values:

| Property | Values |
| --- | --- |
| Kick multiplier | `1.10x`, `1.15x`, `1.20x`, `1.25x`, `1.30x` |
| `kickStrength` | `5.5`, `5.75`, `6.0`, `6.25`, `6.5` (multiplier × HaxBall's standard value of `5`) |
| Ball `damping` | `0.985`, `0.9875`, `0.990` |

The server makes a fresh version from the selected stadium's original template
for each randomization. Geometry and other physics stay as authored in that
template. Choosing a stadium manually selects a new base and clears its
randomized status. `!randomize reset` uses HaxBall's built-in stadium reset for
built-in maps and reloads the original `.hbs` file for AAAAuto Arena. An
unsupported custom stadium returns an error instead of using another map's
template. `!randomize info` still shows its name and live ball damping; the
kick multiplier is shown as unknown when HaxBall has not provided a bundled
template for that custom stadium.

When the selected stadium's original physics are confirmed, `!r reset` returns
`✅ Original physics already active.` without calling a setter. If physics are
unknown after a failed or timed-out request, reset still attempts to restore
them.

The Headless API applies stadium setters asynchronously and ignores them while
a game is in progress. Randomize and reset commands therefore wait for
`onStadiumChange` and, when available, the live ball damping to match before
reporting success. If a same-name custom reload does not emit an event, a
change in live damping can confirm the reload; an already-matching damping
value cannot. Requests that receive no confirmation time out as unconfirmed.
If a late or unexpected programmatic stadium callback arrives, `!r info` marks
the current stadium as unknown and `!r`/`!r reset` remain blocked until the
outstanding callback is observed and a supported stadium is selected manually.
A manual selection made while an operation is pending also leaves the state
unknown, since the canceled setter could still apply afterward. If no late
callback arrives, restarting the room is the only way to clear that uncertainty
safely.

The Headless API reference lists `onStadiumChange` but no method for inspecting
the current stadium, and its event contains only the stadium name and player,
with no request id. A reset after an unconfirmed request may therefore be
attempted but still time out if the stadium and damping already match and no
event distinguishes it from a stale callback. HaxBall also provides no getter
for player kick strength: the reported multiplier is the value sent in the
stadium payload, not a live readback. See the
[Headless API reference](https://github.com/haxball/haxball-issues/wiki/Headless-Host).

The ten bundled built-in definitions and their source checksums are documented
in [stadiums/builtin/README.md](stadiums/builtin/README.md). They are verified
locally at startup; randomization does not make network requests.
