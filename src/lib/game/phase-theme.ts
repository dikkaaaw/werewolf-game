/**
 * Centralized phase-aware visual theme.
 *
 * The theme is driven exclusively by the *authoritative* room snapshot
 * (`status` + `phase` from `rooms`). It never consults the device clock or
 * real-world time, so two players in the same room always see the same theme,
 * and a reconnect re-applies the correct one from the fetched snapshot.
 *
 * Pure module: no React, no DOM. Every visual decision in the room UI resolves
 * through `resolvePhaseTheme` so conditional class strings are never scattered
 * across components.
 */

/** Authoritative room status as returned by `GET /api/rooms/[roomId]`. */
export type RoomStatus = 'lobby' | 'in_progress' | 'finished';

/** Authoritative room phase as returned by `GET /api/rooms/[roomId]`. */
export type RoomPhase = 'lobby' | 'night' | 'day' | 'voting' | 'finished';

/** The theme keys the room UI can actually render. */
export type PhaseThemeKey = 'lobby' | 'night' | 'day' | 'voting' | 'gameover';

/** Which faction won, used to pick the game-over accent. */
export type WinnerFaction = 'village' | 'werewolf';

/** Narrow an untrusted snapshot value to a known winner faction. */
export function toWinnerFaction(value: unknown): WinnerFaction | null {
  return value === 'village' || value === 'werewolf' ? value : null;
}

export interface PhaseTheme {
  key: PhaseThemeKey;
  /** Short label for the phase pill. */
  label: string;
  /** Emoji glyph for the phase pill / headers. */
  glyph: string;
  /** Tailwind background stack for the full-page shell. */
  page: string;
  /** Ambient decorative layers (aurora, sun haze, embers...). */
  ambience: string;
  /** Card/section surface (panels, roster container). */
  surface: string;
  /** Slightly raised surface used for nested rows and chips. */
  surfaceRaised: string;
  /** Hairline border for surfaces. */
  border: string;
  /** Primary heading / emphasis text colour. */
  text: string;
  /** Secondary, de-emphasised text colour. */
  textMuted: string;
  /** Tertiary text for tertiary metadata. */
  textFaint: string;
  /** Accent colour for the primary action of the phase. */
  accent: string;
  /** Soft accent surface for highlights and selected rows. */
  accentSoft: string;
  /** Border used on accent-highlighted elements. */
  accentBorder: string;
  /** Badge pill for the phase/status indicator. */
  statusPill: string;
  /** Neutral secondary button. */
  buttonNeutral: string;
  /** Primary (call-to-action) button. */
  buttonPrimary: string;
  /** Small uppercase section eyebrow. */
  eyebrow: string;
  /** Divider line colour. */
  divider: string;
  /** Soft coloured glow used on hero surfaces. */
  accentGlow: string;
  /**
   * True for the daylight themes. UI must branch on the *phase* theme, never on
   * `prefers-color-scheme`, so the look follows the game rather than the device.
   */
  isLight: boolean;
  /** Row hover wash, appropriate for this theme's lightness. */
  rowHover: string;
}

const NEUTRAL_FALLBACK: PhaseTheme = {
  key: 'lobby',
  label: 'Connecting',
  glyph: '⋯',
  page: 'bg-[#090d16] text-slate-100',
  ambience: '',
  surface: 'bg-[#111726] border-[#1e293b]',
  surfaceRaised: 'bg-[#0b0f19] border-gray-800',
  border: 'border-[#1e293b]',
  text: 'text-slate-100',
  textMuted: 'text-gray-400',
  textFaint: 'text-gray-500',
  accent: 'text-indigo-300',
  accentSoft: 'bg-indigo-950/40',
  accentBorder: 'border-indigo-700/70',
  statusPill: 'bg-slate-900 border-slate-700 text-slate-300',
  buttonNeutral: 'bg-slate-800 hover:bg-slate-700 text-slate-100 border-slate-700',
  buttonPrimary:
    'bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white border-indigo-500 shadow-indigo-950',
  eyebrow: 'text-gray-400',
  divider: 'border-gray-800/80',
  accentGlow: '',
  isLight: false,
  rowHover: 'hover:bg-slate-900/30',
};

const THEMES: Record<PhaseThemeKey, PhaseTheme> = {
  lobby: {
    key: 'lobby',
    label: 'Lobby',
    glyph: '🏕️',
    // Spacious, welcoming, neutral fantasy hearth light.
    page:
      'bg-gradient-to-b from-[#1b1a2e] via-[#171529] to-[#12111f] text-slate-100',
    ambience: 'bg-[radial-gradient(60rem_32rem_at_50%_-10%,rgba(251,191,36,0.13),transparent_70%)]',
    surface: 'bg-[#1d1c33]/80 border-[#33314f]',
    surfaceRaised: 'bg-[#16152a]/70 border-[#2c2a45]',
    border: 'border-[#33314f]',
    text: 'text-slate-50',
    textMuted: 'text-slate-400',
    textFaint: 'text-slate-500',
    accent: 'text-amber-300',
    accentSoft: 'bg-amber-950/30',
    accentBorder: 'border-amber-600/50',
    statusPill: 'bg-amber-950/70 border-amber-600/70 text-amber-200',
    buttonNeutral:
      'bg-slate-800/80 hover:bg-slate-700/80 text-slate-100 border-slate-600/70',
    buttonPrimary:
      'bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-slate-950 border-amber-400 shadow-amber-950/60',
    eyebrow: 'text-amber-300/80',
    divider: 'border-[#2c2a45]',
    accentGlow: 'shadow-2xl shadow-amber-950/20',
    isLight: false,
    rowHover: 'hover:bg-white/5',
  },

  night: {
    key: 'night',
    label: 'Night',
    glyph: '🌙',
    // Midnight blue / deep purple with moonlight rim light.
    page:
      'bg-gradient-to-b from-[#080b1c] via-[#0d0b22] to-[#05060f] text-slate-100',
    ambience:
      'bg-[radial-gradient(48rem_26rem_at_15%_0%,rgba(99,102,241,0.20),transparent_65%),radial-gradient(40rem_30rem_at_85%_10%,rgba(139,92,246,0.16),transparent_70%)]',
    surface: 'bg-[#101026]/85 border-[#262154]',
    surfaceRaised: 'bg-[#0a0a1c]/80 border-[#1e1d45]',
    border: 'border-[#262154]',
    text: 'text-indigo-50',
    textMuted: 'text-indigo-200/60',
    textFaint: 'text-indigo-300/40',
    accent: 'text-indigo-300',
    accentSoft: 'bg-indigo-950/50',
    accentBorder: 'border-indigo-600/70',
    statusPill: 'bg-indigo-950/80 border-indigo-500/70 text-indigo-200',
    buttonNeutral:
      'bg-indigo-950/60 hover:bg-indigo-900/60 text-indigo-100 border-indigo-800/80',
    buttonPrimary:
      'bg-indigo-500 hover:bg-indigo-400 active:bg-indigo-600 text-white border-indigo-400 shadow-indigo-950/70',
    eyebrow: 'text-indigo-300/70',
    divider: 'border-[#1e1d45]',
    accentGlow: 'shadow-2xl shadow-indigo-950/40',
    isLight: false,
    rowHover: 'hover:bg-white/5',
  },

  day: {
    key: 'day',
    label: 'Day Discussion',
    glyph: '☀️',
    // Warm daylight: cream paper, amber sun, readable dark text.
    page: 'bg-gradient-to-b from-[#fdf6e6] via-[#fbeed6] to-[#f3e2c4] text-stone-800',
    ambience:
      'bg-[radial-gradient(52rem_30rem_at_50%_-12%,rgba(251,191,36,0.42),transparent_70%)]',
    surface: 'bg-[#fffaf0]/85 border-[#e6d3ac]',
    surfaceRaised: 'bg-[#fdf3e0]/80 border-[#e2cfa8]',
    border: 'border-[#e6d3ac]',
    text: 'text-stone-900',
    textMuted: 'text-stone-600',
    textFaint: 'text-stone-500',
    accent: 'text-amber-700',
    accentSoft: 'bg-amber-200/40',
    accentBorder: 'border-amber-500/70',
    statusPill: 'bg-amber-500/20 border-amber-600/60 text-amber-900',
    buttonNeutral: 'bg-[#f4e7cd] hover:bg-[#ecd9b4] text-stone-800 border-[#dcc59a]',
    buttonPrimary:
      'bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white border-amber-600 shadow-amber-900/20',
    eyebrow: 'text-amber-800/70',
    divider: 'border-[#e2cfa8]',
    accentGlow: 'shadow-2xl shadow-amber-900/10',
    isLight: true,
    rowHover: 'hover:bg-amber-900/5',
  },

  voting: {
    key: 'voting',
    label: 'Voting',
    glyph: '⚖️',
    // Bright daytime with deliberate, high-contrast accent for ballot choices.
    page: 'bg-gradient-to-b from-[#eef4ff] via-[#e3ecff] to-[#d5e2fb] text-slate-900',
    ambience:
      'bg-[radial-gradient(50rem_28rem_at_50%_-10%,rgba(59,130,246,0.22),transparent_70%)]',
    surface: 'bg-white/85 border-[#c3d6f5]',
    surfaceRaised: 'bg-[#f2f7ff]/90 border-[#cddcf7]',
    border: 'border-[#c3d6f5]',
    text: 'text-slate-900',
    textMuted: 'text-slate-600',
    textFaint: 'text-slate-500',
    accent: 'text-blue-700',
    accentSoft: 'bg-blue-100/70',
    accentBorder: 'border-blue-500/70',
    statusPill: 'bg-blue-600/15 border-blue-600/50 text-blue-900',
    buttonNeutral: 'bg-[#e2ebfb] hover:bg-[#d3e0f8] text-slate-800 border-[#b9cdf0]',
    buttonPrimary:
      'bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white border-blue-600 shadow-blue-900/20',
    eyebrow: 'text-blue-800/70',
    divider: 'border-[#cddcf7]',
    accentGlow: 'shadow-2xl shadow-blue-900/10',
    isLight: true,
    rowHover: 'hover:bg-blue-900/5',
  },

  gameover: {
    key: 'gameover',
    label: 'Game Over',
    glyph: '🏆',
    // Regal, neutral-dark so the victory banner's faction colour reads clearly.
    page:
      'bg-gradient-to-b from-[#161325] via-[#120f1e] to-[#0a0813] text-slate-100',
    ambience:
      'bg-[radial-gradient(46rem_28rem_at_50%_-10%,rgba(251,191,36,0.16),transparent_70%)]',
    surface: 'bg-[#1a1728]/85 border-[#332c4a]',
    surfaceRaised: 'bg-[#14121f]/80 border-[#2a2440]',
    border: 'border-[#332c4a]',
    text: 'text-slate-50',
    textMuted: 'text-slate-400',
    textFaint: 'text-slate-500',
    accent: 'text-amber-300',
    accentSoft: 'bg-amber-950/30',
    accentBorder: 'border-amber-600/50',
    statusPill: 'bg-amber-950/70 border-amber-500/70 text-amber-200',
    buttonNeutral: 'bg-slate-800/80 hover:bg-slate-700/80 text-slate-100 border-slate-600/70',
    buttonPrimary:
      'bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-slate-950 border-amber-400 shadow-amber-950/60',
    eyebrow: 'text-amber-300/70',
    divider: 'border-[#2a2440]',
    accentGlow: 'shadow-2xl shadow-amber-950/20',
    isLight: false,
    rowHover: 'hover:bg-white/5',
  },
};

export const PHASE_THEMES = THEMES;

/**
 * Collapse the authoritative room state onto a theme key.
 *
 * `status` wins over `phase` because the DB guarantees they agree
 * (`rooms_status_phase_chk`). Anything unrecognised resolves to the lobby
 * theme rather than a wrong-phase flash.
 */
export function resolvePhaseThemeKey(
  status: RoomStatus | string | null | undefined,
  phase: RoomPhase | string | null | undefined,
): PhaseThemeKey {
  if (status === 'finished' || phase === 'finished') return 'gameover';
  if (status === 'lobby' || phase === 'lobby') return 'lobby';
  switch (phase) {
    case 'night':
      return 'night';
    case 'day':
      return 'day';
    case 'voting':
      return 'voting';
    default:
      return 'lobby';
  }
}

/** Resolve the full theme for an authoritative room snapshot. */
export function resolvePhaseTheme(
  status: RoomStatus | string | null | undefined,
  phase: RoomPhase | string | null | undefined,
): PhaseTheme {
  return THEMES[resolvePhaseThemeKey(status, phase)];
}

/**
 * Stable class key for the theme. Used as a React key/CSS data attribute so a
 * phase change swaps the whole themed tree in one commit — which is what
 * prevents a half-styled frame where some blocks still carry the old theme.
 */
export function phaseThemeKey(status: RoomStatus | string, phase: RoomPhase | string): string {
  return resolvePhaseThemeKey(status, phase);
}

export interface GameOverPresentation {
  headline: string;
  subline: string;
  accent: string;
  border: string;
  surface: string;
  glyph: string;
}

/** Village-win and werewolf-win read differently from each other. */
export function resolveGameOverPresentation(winner: unknown): GameOverPresentation {
  if (winner === 'werewolf') {
    return {
      glyph: '🐺',
      headline: 'The Pack Wins',
      subline: 'The werewolves outnumbered the village.',
      accent: 'text-rose-300',
      border: 'border-rose-500/50',
      surface: 'bg-gradient-to-b from-rose-950/60 via-[#1a1020] to-[#0a0813]',
    };
  }
  if (winner === 'village') {
    return {
      glyph: '🌾',
      headline: 'The Village Wins',
      subline: 'Every hidden wolf was hunted down.',
      accent: 'text-emerald-300',
      border: 'border-emerald-500/50',
      surface: 'bg-gradient-to-b from-emerald-950/60 via-[#101c1a] to-[#080f0e]',
    };
  }
  return {
    glyph: '🏁',
    headline: 'Game Finished',
    subline: 'The village has spoken.',
    accent: 'text-amber-300',
    border: 'border-amber-500/50',
    surface: 'bg-gradient-to-b from-amber-950/50 via-[#161325] to-[#0a0813]',
  };
}

/** Neutral theme used before the first snapshot lands, so nothing flashes. */
export function isResolvedThemeKey(key: string): key is PhaseThemeKey {
  return key in THEMES;
}

export { NEUTRAL_FALLBACK as NEUTRAL_THEME_TOKENS };