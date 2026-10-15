'use client'

import { useState, useEffect } from 'react'

export interface HunterTarget {
    id: string
    displayName: string
}

export interface HunterShotPromptProps {
    targets: HunterTarget[]
    deadlineAt: string
    submitting: boolean
    onSelect: (targetId: string) => void
}

export function HunterShotPrompt({ targets, deadlineAt, submitting, onSelect }: HunterShotPromptProps) {
    const [targetId, setTargetId] = useState('')
    const [remaining, setRemaining] = useState<number | null>(null)

    useEffect(() => {
        const update = () => {
            setRemaining(Math.max(0, new Date(deadlineAt).getTime() - Date.now()))
        }
        update()
        const timer = window.setInterval(update, 250)
        return () => window.clearInterval(timer)
    }, [deadlineAt])

    const expired = remaining !== null && remaining <= 0
    return (
        <section aria-live="polite">
            <p>Hunter final shot</p>
            <p>{remaining === null ? '—' : expired ? 'Expired' : `${Math.ceil(remaining / 1000)}s`}</p>
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={submitting}>
                <option value="">Choose target</option>
                {targets.map((target) => (
                    <option key={target.id} value={target.id}>{target.displayName}</option>
                ))}
            </select>
            <button
                type="button"
                disabled={submitting || expired || !targetId}
                onClick={() => { if (!expired) onSelect(targetId) }}
            >
                Shoot
            </button>
        </section>
    )
}
