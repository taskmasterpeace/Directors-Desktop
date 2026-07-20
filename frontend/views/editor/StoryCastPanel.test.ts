import { describe, it, expect } from 'vitest'
import { scanSpeakers } from './StoryCastPanel'

describe('scanSpeakers', () => {
  it('finds NAME: speaker lines', () => {
    const script = [
      'JAX: We move at dawn.',
      'Mrs. Vane: Not without the map.',
      'JAX: Then find it.',
    ].join('\n')
    expect(scanSpeakers(script).sort()).toEqual(['JAX', 'Mrs. Vane'])
  })

  it('skips scene headings and structure labels', () => {
    const script = [
      'SCENE: The docks at night',
      'INT: warehouse',
      'CHORUS: repeated hook line',
      'RIA: I saw him first.',
    ].join('\n')
    expect(scanSpeakers(script)).toEqual(['RIA'])
  })

  it('returns empty for prose with no speaker labels', () => {
    expect(scanSpeakers('He whispered that the night was long, and she laughed.')).toEqual([])
  })

  it('requires a leading capital and reasonable length', () => {
    const text = ['x: lowercase ignored', 'A' + 'B'.repeat(40) + ': too long ignored', 'BO: ok'].join('\n')
    expect(scanSpeakers(text)).toEqual(['BO'])
  })
})
