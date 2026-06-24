/**
 * Caret pixel coordinates inside a <textarea>, via the standard hidden-mirror technique:
 * clone the textarea's text-affecting styles into an off-screen div, render the text up to
 * the caret, and measure a marker span. Returns coordinates RELATIVE to the textarea's own
 * border box (so a dropdown positioned `absolute` in the same wrapper tracks scrolling —
 * never `position:fixed`, which the plan forbids because it ignores the scrolling hosts).
 */

const MIRRORED_PROPERTIES = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontFamily',
  'lineHeight',
  'letterSpacing',
  'textTransform',
  'wordSpacing',
  'textIndent',
  'whiteSpace',
  'tabSize',
] as const

export interface CaretCoordinates {
  /** Distance from the textarea's top border to the caret line top (minus scroll). */
  top: number
  left: number
  height: number
}

export function getCaretCoordinates(element: HTMLTextAreaElement, position: number): CaretCoordinates {
  const div = document.createElement('div')
  const style = div.style
  const computed = window.getComputedStyle(element)

  style.position = 'absolute'
  style.visibility = 'hidden'
  style.whiteSpace = 'pre-wrap'
  style.wordWrap = 'break-word'
  style.overflow = 'hidden'

  for (const prop of MIRRORED_PROPERTIES) {
    style[prop] = computed[prop]
  }

  div.textContent = element.value.substring(0, position)
  const span = document.createElement('span')
  // a non-empty span so it has a measurable box even at the very end of the text
  span.textContent = element.value.substring(position) || '.'
  div.appendChild(span)

  document.body.appendChild(div)
  const top = span.offsetTop + parseInt(computed.borderTopWidth || '0', 10) - element.scrollTop
  const left = span.offsetLeft + parseInt(computed.borderLeftWidth || '0', 10) - element.scrollLeft
  const height = parseInt(computed.lineHeight || computed.fontSize || '16', 10)
  document.body.removeChild(div)

  return { top, left, height }
}
