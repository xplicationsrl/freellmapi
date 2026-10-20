import { describe, it, expect } from 'vitest'
import {
  COMPOSER_BUTTON_PX,
  COMPOSER_GAP_PX,
  COMPOSER_MAX_HEIGHT_PX,
  composerHasContent,
  composerHeight,
  composerAction,
  sendButtonOffset,
} from './composer-geometry'

describe('composerHasContent', () => {
  it('needs real text or an attachment', () => {
    expect(composerHasContent('', 0)).toBe(false)
    expect(composerHasContent('   \n', 0)).toBe(false)
    expect(composerHasContent('hi', 0)).toBe(true)
    expect(composerHasContent('', 1)).toBe(true)
  })
})

describe('sendButtonOffset', () => {
  it('parks the whole offset on the button: under the bar when empty, at rest when there is content', () => {
    expect(sendButtonOffset(false)).toBe(-(COMPOSER_BUTTON_PX + COMPOSER_GAP_PX))
    expect(sendButtonOffset(true)).toBe(0)
  })
})

describe('composerAction', () => {
  it('is nothing for an empty idle bar, send once there is content', () => {
    expect(composerAction(false, false)).toBeNull()
    expect(composerAction(true, false)).toBe('send')
  })

  it('is stop for as long as a reply is in flight, even with an empty input', () => {
    expect(composerAction(false, true)).toBe('stop')
    expect(composerAction(true, true)).toBe('stop')
  })
})

describe('composerHeight', () => {
  it('caps the textarea and reports the grown threshold', () => {
    expect(composerHeight(40)).toEqual({ height: 40, grown: false })
    expect(composerHeight(60)).toEqual({ height: 60, grown: true })
    expect(composerHeight(900)).toEqual({ height: COMPOSER_MAX_HEIGHT_PX, grown: true })
    expect(composerHeight(-5).height).toBe(0)
  })
})
