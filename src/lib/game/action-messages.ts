import type { ToastKind } from './toast'

export type NightActionType = 'eliminate' | 'investigate' | 'protect'

/**
 * Copy for confirmed action feedback.
 *
 * Kept out of the component so the wording is unit-testable and so every
 * success message reads the same way. The server must confirm the action
 * before any of this is shown — these strings are only ever built after a 2xx.
 */
const NIGHT_ACTION_COPY: Record<
    NightActionType,
    { kind: ToastKind; title: string; description: string }
> = {
    protect: {
        kind: 'success',
        title: 'Protection submitted',
        description: 'Target: {target} · You can change your target before the deadline.',
    },
    investigate: {
        kind: 'success',
        title: 'Investigation submitted',
        description: 'Target: {target} · You can change your target before the deadline.',
    },
    eliminate: {
        kind: 'success',
        title: 'Elimination submitted',
        description: 'Target: {target} · You can change your target before the deadline.',
    },
}

function fill(template: string, target: string): string {
    return template.replace('{target}', target)
}

export function nightActionToast(actionType: NightActionType, targetName: string) {
    const copy = NIGHT_ACTION_COPY[actionType]
    return {
        kind: copy.kind,
        title: copy.title,
        description: fill(copy.description, targetName),
    }
}

export function voteCastToast(targetName: string) {
    return {
        kind: 'success' as const,
        title: 'Vote submitted',
        description: `Voted for ${targetName} · You can change your vote before the deadline.`,
    }
}

/** Shown when the server rejects an action; surfaced inline, not as a toast. */
export function actionFailedToast(actionType: NightActionType) {
    return {
        kind: 'error' as const,
        title: 'Action rejected',
        description: `The server refused your ${actionType}. The phase may have ended.`,
    }
}
