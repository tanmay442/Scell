import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs/vfs'
import { addReminder, deleteReminder, dueReminders, loadReminders, parseReminderWhen } from './agent-reminders'

describe('agent-reminders', () => {
  it('parses relative and absolute times', () => {
    const now = Date.parse('2026-01-01T12:00:00Z')
    expect(parseReminderWhen('in 20m', now)).toEqual({ at: now + 20 * 60_000 })
    expect(parseReminderWhen('in 2h', now)).toEqual({ at: now + 2 * 3_600_000 })
    expect(parseReminderWhen('in 1d', now)).toEqual({ at: now + 86_400_000 })
    expect(parseReminderWhen('2026-01-02T09:00:00Z', now)).toEqual({ at: Date.parse('2026-01-02T09:00:00Z') })
    expect(parseReminderWhen('someday', now)).toEqual({ error: expect.stringContaining('could not parse') })
    expect(parseReminderWhen('in 30d', now)).toEqual({ error: expect.stringContaining('7 days') })
    expect(parseReminderWhen('2025-01-01T00:00:00Z', now)).toEqual({ error: expect.stringContaining('past') })
  })

  it('adds, lists, fires once, deletes', () => {
    const vfs = createVfs()
    const now = Date.parse('2026-01-01T12:00:00Z')
    const added = addReminder(vfs, { text: 'check the deploy', when: 'in 20m', chatId: '42', threadId: 't1' }, now)
    expect('ok' in added && added.ok).toBe(true)
    if (!('ok' in added)) return
    expect(added.reminder.chatId).toBe('42')
    expect(loadReminders(vfs)).toHaveLength(1)
    expect(dueReminders(vfs, now + 19 * 60_000)).toHaveLength(0)
    expect(dueReminders(vfs, now + 21 * 60_000)).toHaveLength(1)
    expect(deleteReminder(vfs, added.reminder.id)).toBe(true)
    expect(loadReminders(vfs)).toHaveLength(0)
    expect(deleteReminder(vfs, 'rem-nope')).toBe(false)
  })

  it('rejects empty text, long text and overflow', () => {
    const vfs = createVfs()
    const now = Date.now()
    expect(addReminder(vfs, { text: '  ', when: 'in 5m' }, now)).toEqual({ error: expect.stringContaining('empty') })
    expect(addReminder(vfs, { text: 'x'.repeat(501), when: 'in 5m' }, now)).toEqual({
      error: expect.stringContaining('cap'),
    })
  })

  it('survives malformed reminders.json', () => {
    const vfs = createVfs()
    vfs.write('/home/user/.cell/reminders.json', '[[[')
    expect(loadReminders(vfs)).toEqual([])
    expect(dueReminders(vfs, Date.now())).toEqual([])
  })
})
