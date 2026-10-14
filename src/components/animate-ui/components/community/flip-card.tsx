'use client'

import { easeOut, motion } from 'motion/react'
import * as React from 'react'

/**
 * Flip Card — from Animate UI (community), installed via
 * `npx shadcn@latest add @animate-ui/components-community-flip-card`.
 *
 * Changes from the published version, and why:
 *
 * 1. Faces accept arbitrary React nodes. The published component only renders a
 *    profile (avatar, bio, stats, social links).
 * 2. Those social links are gone. They imported `Github`/`Linkedin`/`Twitter`
 *    from lucide-react, which removed the brand icons in v1; the installed
 *    component did not compile. Its `Follow` button also pulled in a shadcn
 *    `Button` this project does not use.
 *
 * Flip interaction is hover on pointer devices and click on touch devices, as in
 * the original. Focus/blur is wired up as well: hover alone would leave the card
 * unreachable by keyboard.
 * 3. `perspective-[1000px]` instead of `perspective-1000`. The latter is a
 *    Tailwind v3 utility and emits nothing under this project's Tailwind v4,
 *    which silently flattened the 3D turn.
 * 4. Faces are stacked with grid areas rather than `absolute inset-0`, so the
 *    container still takes its height from the tallest face.
 */

export interface FlipCardProps {
    /** Front face — the side revealed on hover / focus. */
    front: React.ReactNode
    /** Back face — the side shown at rest. */
    back: React.ReactNode
    className?: string
    /** Disables the 3D turn for reduced-motion users. */
    reducedMotion?: boolean
    /** Start on the front face instead of the back. */
    defaultFlipped?: boolean
    onFlippedChange?: (flipped: boolean) => void
}

const cardVariants = {
    front: { rotateY: 0, transition: { duration: 0.5, ease: easeOut } },
    back: { rotateY: 180, transition: { duration: 0.5, ease: easeOut } },
}

export function FlipCard({
    front,
    back,
    className,
    reducedMotion = false,
    defaultFlipped = false,
    onFlippedChange,
}: FlipCardProps) {
    const [isFlipped, setIsFlipped] = React.useState(defaultFlipped)
    const transition = reducedMotion ? { duration: 0 } : undefined

    const isTouchDevice = typeof window !== 'undefined' && 'ontouchstart' in window

    const flip = React.useCallback(
        (next: boolean) => {
            setIsFlipped(next)
            onFlippedChange?.(next)
        },
        [onFlippedChange],
    )

    // Touch devices have no hover, so a tap stands in for it.
    const handleClick = () => {
        if (isTouchDevice) flip(!isFlipped)
    }
    const handleMouseEnter = () => {
        if (!isTouchDevice) flip(true)
    }
    const handleMouseLeave = () => {
        if (!isTouchDevice) flip(false)
    }
    // Keyboard parity with hover.
    const handleFocus = () => flip(true)
    const handleBlur = () => flip(false)

    return (
        <div
            className={`grid cursor-pointer perspective-[1000px] ${className ?? ''}`}
            onClick={handleClick}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onFocus={handleFocus}
            onBlur={handleBlur}
            tabIndex={0}
        >
            <motion.div
                className="backface-hidden [grid-area:1/1]"
                style={{ transformStyle: 'preserve-3d' }}
                initial={false}
                animate={isFlipped ? 'back' : 'front'}
                variants={cardVariants}
                transition={transition}
            >
                {front}
            </motion.div>

            <motion.div
                className="backface-hidden [grid-area:1/1]"
                // The back face starts turned away, so it is hidden until the
                // card rotates onto it.
                style={{ transformStyle: 'preserve-3d', rotateY: 180 }}
                initial={false}
                animate={isFlipped ? 'front' : 'back'}
                variants={cardVariants}
                transition={transition}
            >
                {back}
            </motion.div>
        </div>
    )
}