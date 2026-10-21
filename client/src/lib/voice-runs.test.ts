import { describe, expect, it } from 'vitest'
import { nextVoiceState, speakable, takeSentences } from './voice'
import { applyRunEvent, EMPTY_RUN, parseRunFrame } from './runs'

describe('takeSentences', () => {
  it('emits complete sentences and keeps the tail', () => {
    const out = takeSentences('This is the first sentence here. And a partial')
    expect(out.sentences).toEqual(['This is the first sentence here.'])
    expect(out.rest).toBe('And a partial')
  })

  it('waits when a terminator ends the buffer, unless flushing', () => {
    expect(takeSentences('One complete sentence is here.').sentences).toEqual([])
    expect(takeSentences('One complete sentence is here.', true).sentences).toEqual(['One complete sentence is here.'])
  })

  it('merges short fragments into the next sentence', () => {
    const out = takeSentences('Hi. This second sentence is the long enough one. ', true)
    expect(out.sentences).toEqual(['Hi. This second sentence is the long enough one.'])
  })
})

describe('speakable', () => {
  it('drops code, links markup and citation ids', () => {
    expect(speakable('See [the doc](http://x) [kb:1#2] and `code`.')).toBe('See the doc and code.')
    expect(speakable('```js\nfoo()\n```')).toContain('code block omitted')
  })
})

describe('nextVoiceState', () => {
  it('walks a full turn and returns to listening', () => {
    let s = nextVoiceState('idle', 'start')
    expect(s).toBe('listening')
    s = nextVoiceState(s, 'speech-end')
    expect(s).toBe('transcribing')
    s = nextVoiceState(s, 'transcript')
    expect(s).toBe('thinking')
    s = nextVoiceState(s, 'playback-started')
    expect(s).toBe('speaking')
    expect(nextVoiceState(s, 'barge-in')).toBe('listening')
    expect(nextVoiceState(s, 'reply-finished')).toBe('listening')
  })

  it('ignores actions that do not apply', () => {
    expect(nextVoiceState('idle', 'speech-end')).toBe('idle')
    expect(nextVoiceState('listening', 'playback-started')).toBe('listening')
  })
})

describe('applyRunEvent', () => {
  it('folds a tool round into the view', () => {
    let v = applyRunEvent(EMPTY_RUN, { type: 'run.started', runId: 'r1', conversationId: 1 })
    v = applyRunEvent(v, { type: 'tool.approval_required', runId: 'r1', callId: 'c1', name: 'sandbox__run_python', source: 'sandbox', arguments: { code: 'print(1)' } })
    expect(v.tools[0].status).toBe('awaiting_approval')
    v = applyRunEvent(v, { type: 'tool.started', runId: 'r1', callId: 'c1', name: 'sandbox__run_python', source: 'sandbox', arguments: { code: 'print(1)' } })
    v = applyRunEvent(v, { type: 'tool.completed', runId: 'r1', callId: 'c1', status: 'completed', outcome: 'ok', summary: '1' })
    expect(v.tools).toHaveLength(1)
    expect(v.tools[0]).toMatchObject({ name: 'sandbox__run_python', status: 'completed', outcome: 'ok' })
    v = applyRunEvent(v, { type: 'message.delta', runId: 'r1', text: 'Done' })
    v = applyRunEvent(v, { type: 'run.completed', runId: 'r1', status: 'completed' })
    expect(v.text).toBe('Done')
    expect(v.status).toBe('completed')
  })

  it('does not duplicate a citation', () => {
    const c = { id: 'kb:1#0', title: 'doc' }
    let v = applyRunEvent(EMPTY_RUN, { type: 'citation.added', runId: 'r', citation: c })
    v = applyRunEvent(v, { type: 'citation.added', runId: 'r', citation: c })
    expect(v.citations).toHaveLength(1)
  })
})

describe('parseRunFrame', () => {
  it('parses a data frame and ignores [DONE] and junk', () => {
    expect(parseRunFrame('data: {"type":"run.completed","runId":"r","status":"completed"}')?.type).toBe('run.completed')
    expect(parseRunFrame('data: [DONE]')).toBeNull()
    expect(parseRunFrame(': keepalive')).toBeNull()
    expect(parseRunFrame('data: {nope')).toBeNull()
  })
})
