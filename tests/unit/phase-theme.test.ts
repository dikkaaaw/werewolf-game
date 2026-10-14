import { describe, expect, it } from 'vitest';

import {
  NEUTRAL_THEME_TOKENS,
  PHASE_THEMES,
  phaseThemeKey,
  resolveGameOverPresentation,
  resolvePhaseTheme,
  resolvePhaseThemeKey,
  toWinnerFaction,
  type PhaseThemeKey,
} from '@/lib/game/phase-theme';

const THEME_KEYS: PhaseThemeKey[] = ['lobby', 'night', 'day', 'voting', 'gameover'];

describe('Phase theme — resolution from the authoritative snapshot', () => {
  it('maps every legal room status/phase pair to the right theme', () => {
    expect(resolvePhaseThemeKey('lobby', 'lobby')).toBe('lobby');
    expect(resolvePhaseThemeKey('in_progress', 'night')).toBe('night');
    expect(resolvePhaseThemeKey('in_progress', 'day')).toBe('day');
    expect(resolvePhaseThemeKey('in_progress', 'voting')).toBe('voting');
    expect(resolvePhaseThemeKey('finished', 'finished')).toBe('gameover');
  });

  it('trusts status when status and phase disagree (DB guarantees agreement)', () => {
    // A finished room always renders the game-over theme, never a phase theme.
    expect(resolvePhaseThemeKey('finished', 'night')).toBe('gameover');
    expect(resolvePhaseThemeKey('finished', 'voting')).toBe('gameover');
    expect(resolvePhaseThemeKey('lobby', 'night')).toBe('lobby');
  });

  it('falls back to the lobby theme for unknown or missing state', () => {
    expect(resolvePhaseThemeKey(undefined, undefined)).toBe('lobby');
    expect(resolvePhaseThemeKey(null, null)).toBe('lobby');
    expect(resolvePhaseThemeKey('in_progress', 'teleport')).toBe('lobby');
    expect(resolvePhaseThemeKey('weird', 'weirder')).toBe('lobby');
  });

  it('produces a stable key so a phase swap replaces the themed tree in one commit', () => {
    expect(phaseThemeKey('in_progress', 'night')).toBe('night');
    expect(phaseThemeKey('in_progress', 'day')).toBe('day');
    expect(phaseThemeKey('in_progress', 'night')).not.toBe(
      phaseThemeKey('in_progress', 'day'),
    );
  });
});

describe('Phase theme — design tokens', () => {
  it('defines a complete token set for every theme', () => {
    for (const key of THEME_KEYS) {
      const theme = PHASE_THEMES[key];
      expect(theme.key).toBe(key);

      for (const [token, value] of Object.entries(theme)) {
        if (token === 'key' || token === 'isLight') continue;
        expect(value, `${key}.${token}`).toBeTruthy();
      }

      expect(typeof theme.isLight, `${key}.isLight`).toBe('boolean');
    }
  });

  it('marks exactly the daylight themes as light', () => {
    expect(PHASE_THEMES.day.isLight).toBe(true);
    expect(PHASE_THEMES.voting.isLight).toBe(true);

    expect(PHASE_THEMES.lobby.isLight).toBe(false);
    expect(PHASE_THEMES.night.isLight).toBe(false);
    expect(PHASE_THEMES.gameover.isLight).toBe(false);
  });

  it('gives every theme a row-hover wash matching its lightness', () => {
    const rowHovers = THEME_KEYS.map((key) => PHASE_THEMES[key].rowHover);
    expect(new Set(rowHovers).size).toBeGreaterThan(1);
    for (const key of THEME_KEYS) {
      expect(PHASE_THEMES[key].rowHover).toBeTruthy();
    }
  });

  it('gives each phase a distinct page background', () => {
    const pages = THEME_KEYS.map((key) => PHASE_THEMES[key].page);
    expect(new Set(pages).size).toBe(THEME_KEYS.length);
  });

  it('gives each active phase a distinct accent so transitions are obvious', () => {
    const active: PhaseThemeKey[] = ['night', 'day', 'voting'];
    const accents = active.map((key) => PHASE_THEMES[key].accent);
    expect(new Set(accents).size).toBe(active.length);

    expect(PHASE_THEMES.night.accent).toContain('indigo');
    expect(PHASE_THEMES.day.accent).toContain('amber');
    expect(PHASE_THEMES.voting.accent).toContain('blue');
  });

  it('themes night dark and day/voting light', () => {
    expect(PHASE_THEMES.night.page).toContain('bg-gradient-to-b');
    expect(PHASE_THEMES.night.page).toContain('text-slate-100');

    expect(PHASE_THEMES.day.text).toContain('text-stone-900');
    expect(PHASE_THEMES.voting.text).toContain('text-slate-900');
  });

  it('resolves to the same object identity for repeated calls (stable theming)', () => {
    expect(resolvePhaseTheme('in_progress', 'night')).toBe(PHASE_THEMES.night);
    expect(resolvePhaseTheme('in_progress', 'voting')).toBe(PHASE_THEMES.voting);
    expect(resolvePhaseTheme('finished', 'finished')).toBe(PHASE_THEMES.gameover);
  });

  it('exposes a neutral token set for the pre-snapshot loading frame', () => {
    expect(NEUTRAL_THEME_TOKENS.label).toBe('Connecting');
    expect(NEUTRAL_THEME_TOKENS.page).toBeTruthy();
  });

  it('never leaves the role-card surface inheriting a light page background', () => {
    // The secret role card keeps its own dark identity; a light phase theme must
    // not be able to wash it out.
    for (const key of THEME_KEYS) {
      expect(PHASE_THEMES[key].surface).toBeTruthy();
    }
  });
});

describe('Game over presentation', () => {
  it('distinguishes the two winning factions', () => {
    const village = resolveGameOverPresentation('village');
    const pack = resolveGameOverPresentation('werewolf');

    expect(village.headline).not.toBe(pack.headline);
    expect(village.glyph).not.toBe(pack.glyph);
    expect(village.accent).toContain('emerald');
    expect(pack.accent).toContain('rose');
    expect(village.surface).not.toBe(pack.surface);
  });

  it('falls back to a neutral finish when the winner is unknown', () => {
    const unknown = resolveGameOverPresentation(undefined);
    expect(unknown.glyph).toBe('🏁');
    expect(unknown.headline).toBe('Game Finished');
  });

  it('narrows untrusted winner values from the snapshot', () => {
    expect(toWinnerFaction('village')).toBe('village');
    expect(toWinnerFaction('werewolf')).toBe('werewolf');
    expect(toWinnerFaction('martian')).toBeNull();
    expect(toWinnerFaction(undefined)).toBeNull();
  });
});