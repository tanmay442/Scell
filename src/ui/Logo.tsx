import { cellPalette } from '../cell-theme'

/**
 * Cell mark: a V (for the V8 isolates everything runs on) whose upper
 * bowl holds a horizontal 8 — two eyes, an agent face, and the
 * infinity of an always-on loop, in one glyph. Below 20px the eyes
 * become filled dots so the mark survives favicon sizes.
 */
export function Logo({ size = 28 }: { size?: number }) {
  const small = size < 20
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="Cell">
      <path
        d="M7 7 L24 41 L41 7"
        stroke={cellPalette.brandBright}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {small ? (
        <>
          <circle cx="18.2" cy="16.5" r="2.8" fill={cellPalette.text} />
          <circle cx="29.8" cy="16.5" r="2.8" fill={cellPalette.text} />
        </>
      ) : (
        <>
          <circle cx="18.2" cy="16.5" r="4.4" stroke={cellPalette.text} strokeWidth="3" />
          <circle cx="29.8" cy="16.5" r="4.4" stroke={cellPalette.text} strokeWidth="3" />
        </>
      )}
    </svg>
  )
}
