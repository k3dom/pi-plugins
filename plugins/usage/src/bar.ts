import { Number, String } from 'effect'

export function render(percent: number, width: number): string {
  const filled = Math.round(
    (Number.clamp(percent, { minimum: 0, maximum: 100 }) / 100) * width,
  )
  return String.repeat(filled)('█') + String.repeat(width - filled)('░')
}
