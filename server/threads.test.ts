import { describe, expect, it } from 'vitest'
import { createThreadRouter } from './threads'

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('createThreadRouter', () => {
  it('concurrent same-id: one ran, one busy', async () => {
    const router = createThreadRouter()
    const gate = deferred()
    const first = router.runExclusive('thread-a', async () => {
      await gate.promise
      return 'one'
    })
    expect(router.isBusy('thread-a')).toBe(true)
    const second = await router.runExclusive('thread-a', async () => 'two')
    expect(second).toEqual({ status: 'busy' })
    gate.release()
    expect(await first).toEqual({ status: 'ran', value: 'one' })
    expect(router.isBusy('thread-a')).toBe(false)
  })

  it('different ids run concurrently', async () => {
    const router = createThreadRouter()
    const gate = deferred()
    const first = router.runExclusive('thread-a', async () => {
      await gate.promise
      return 'a'
    })
    const second = router.runExclusive('thread-b', async () => 'b')
    expect(await second).toEqual({ status: 'ran', value: 'b' })
    expect(router.busyIds()).toEqual(['thread-a'])
    gate.release()
    expect(await first).toEqual({ status: 'ran', value: 'a' })
    expect(router.busyIds()).toEqual([])
  })

  it('busy clears after completion: isBusy false, second runExclusive runs', async () => {
    const router = createThreadRouter()
    expect(await router.runExclusive('t', async () => 1)).toEqual({
      status: 'ran',
      value: 1,
    })
    expect(router.isBusy('t')).toBe(false)
    expect(await router.runExclusive('t', async () => 2)).toEqual({
      status: 'ran',
      value: 2,
    })
  })

  it('failed fn releases the slot', async () => {
    const router = createThreadRouter()
    await expect(
      router.runExclusive('t', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(router.isBusy('t')).toBe(false)
    expect(router.busyIds()).toEqual([])
    expect(await router.runExclusive('t', async () => 'recovered')).toEqual({
      status: 'ran',
      value: 'recovered',
    })
  })

  it('invalid id throws', async () => {
    const router = createThreadRouter()
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'has space']) {
      await expect(router.runExclusive(bad, async () => 1)).rejects.toThrow(
        /bare session\/thread stem/,
      )
      expect(() => router.isBusy(bad)).toThrow(/bare session\/thread stem/)
    }
  })

  it('ctx signal is a live non-aborted AbortSignal', async () => {
    const router = createThreadRouter()
    const outcome = await router.runExclusive('t', async (ctx) => {
      expect(ctx.signal).toBeInstanceOf(AbortSignal)
      return ctx.signal.aborted
    })
    expect(outcome).toEqual({ status: 'ran', value: false })
  })
})
