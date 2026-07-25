# Ambient Action Audio 1.1.1 — Reliable Feedback Fix

This release fixes missing sound feedback introduced by the selectable
environment build.

## Cause

Kingdom Hearts and Zen use longer crystal, choir, bowl, and breath tails. The
previous engine allowed only a small number of simultaneous player processes.
When that limit was reached, it silently discarded the newest sound.

That made the editor feel as though some Vim actions were not detected.

## Fix

- New input is no longer discarded because older audio is still playing.
- When the playback limit is full, the oldest sound is stopped.
- The newest action always takes priority.
- Vim movement throttling was reduced from roughly 70 ms to 24 ms.
- Change, delete, yank, and put now use a separate 18 ms action interval.
- The global interval is now only a 12 ms duplicate-event guard.

## Recommended defaults

```jsonc
{
  "ambientActionAudio.globalMinimumIntervalMs": 12,
  "ambientActionAudio.maxConcurrentSounds": 3,
  "ambientActionAudio.vim.movementMinimumIntervalMs": 24,
  "ambientActionAudio.vim.actionMinimumIntervalMs": 18
}
```

These settings retain immediate feedback without allowing long audio tails to
accumulate indefinitely.
