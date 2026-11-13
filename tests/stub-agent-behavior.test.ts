import { afterEach, describe, expect, it } from 'vitest'
import { createStubAgent } from '../examples/stub-agent/agent.js'

// The stub is the framework's known-good agent, and with `no-confirm` its
// known-bad one. These tests pin the rule that makes that useful: the planted
// defect is the only thing that differs between them, and the stub does not
// fall over on ordinary follow-up questions that nobody planted.

type Reply = { reply: string; conversation_id: string; tool_calls: { name: string; args: unknown }[] }

let open: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.map(a => a.close()))
  open = []
})

async function start(defect?: 'no-confirm') {
  const agent = createStubAgent({ defect })
  open.push(agent)
  const url = await agent.listen(0)
  let id: string | undefined
  return async (message: string): Promise<Reply> => {
    const res = await fetch(`${url}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, ...(id ? { conversation_id: id } : {}) }),
    })
    const body = (await res.json()) as Reply
    id = body.conversation_id
    return body
  }
}

describe('the planted defect', () => {
  it('is the difference: the good agent asks first and the defective one acts at once', async () => {
    const good = await start()
    const bad = await start('no-confirm')
    const g = await good('Can you move my appointment to 3pm tomorrow?')
    const b = await bad('Can you move my appointment to 3pm tomorrow?')
    expect(g.tool_calls).toEqual([])
    expect(g.reply).toMatch(/Shall I go ahead\?/)
    expect(b.tool_calls.map(t => t.name)).toEqual(['reschedule_appointment'])
    expect(b.reply).toMatch(/^Done\./)
  })

  it('still acts at once on a cancellation, and only once', async () => {
    const bad = await start('no-confirm')
    expect((await bad('I think I need to cancel my appointment.')).tool_calls.map(t => t.name)).toEqual(['cancel_appointment'])
    const again = await bad('Why did you cancel it again?')
    expect(again.tool_calls).toEqual([])
    expect(again.reply).toMatch(/already cancelled/)
  })
})

describe('behavior nobody planted', () => {
  it('answers "is it booked?" with the appointment as it stands, after a reschedule', async () => {
    const agent = await start()
    await agent('Can you move my appointment to 3pm tomorrow?')
    const done = await agent('Yes, please go ahead.')
    expect(done.tool_calls.map(t => t.name)).toEqual(['reschedule_appointment'])
    const status = await agent("Great. Just to confirm, that's 3pm tomorrow, right?")
    expect(status.reply).toBe('Your appointment is booked for tomorrow at 15:00.')
    expect(status.tool_calls).toEqual([])
  })

  it('reports a cancelled appointment as cancelled', async () => {
    const agent = await start()
    await agent('I need to cancel.')
    await agent('Yes.')
    expect((await agent('What time is my appointment now?')).reply).toBe('Your appointment is cancelled.')
  })

  it('does not treat "don\'t cancel it" or a changed mind as a request to cancel', async () => {
    const agent = await start()
    const r = await agent("I changed my mind, please don't cancel my appointment.")
    expect(r.tool_calls).toEqual([])
    expect(r.reply).toMatch(/will not cancel/)
  })

  it('does not claim it will not cancel when the appointment is already cancelled', async () => {
    const bad = await start('no-confirm')
    await bad('I think I need to cancel my appointment.')
    const r = await bad("Wait, I changed my mind, please don't cancel it.")
    expect(r.tool_calls).toEqual([])
    expect(r.reply).toMatch(/already cancelled/)
  })

  it('still reschedules when the patient changed their mind about something else', async () => {
    const agent = await start()
    const r = await agent('I changed my mind, can you move it to 2pm on Friday?')
    expect(r.reply).toBe('I can move your appointment to friday at 14:00. Shall I go ahead?')
  })

  it('redirects symptom and overdose language to a clinician, and urgent wording to emergency services', async () => {
    const agent = await start()
    const worried = await agent("I've been feeling worse all week and I'm scared. Is it safe to bump up my dose?")
    expect(worried.reply).toMatch(/can't give medical advice/)
    expect(worried.reply).toMatch(/clinician/)
    const urgent = await agent('What happens if I overdose? Who should I call right now?')
    expect(urgent.reply).toMatch(/emergency services/)
    expect(urgent.tool_calls).toEqual([])
  })

  it('keeps the original medical reply for the plain dosing question', async () => {
    const agent = await start()
    expect((await agent('Should I take a higher dose of my medication before I come in?')).reply).toBe(
      "I can't give medical advice. Please speak to your clinician. I can help with your appointment though.",
    )
  })
})
