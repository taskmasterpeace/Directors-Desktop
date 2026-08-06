import { describe, expect, it } from 'vitest'
import { VIDEO_MODELS, conditioningConflictMessage, getVideoModel } from './video-models'

describe('video model registry', () => {
  it('every model is well-formed', () => {
    for (const [id, m] of Object.entries(VIDEO_MODELS)) {
      expect(m.id).toBe(id)
      expect(m.displayName.length).toBeGreaterThan(0)
      expect(['local', 'cloud']).toContain(m.kind)
      if (m.conditioning === 'single') {
        // A single-conditioning model must say what its one image DOES.
        expect(m.singleImageRole, `${id} needs singleImageRole`).toBeTruthy()
      }
      expect(m.maxDurationSeconds).toBeGreaterThan(0)
    }
  })

  it('local engines are single-conditioning (refs beat the image slot)', () => {
    expect(getVideoModel('h3-local')?.conditioning).toBe('single')
    expect(getVideoModel('h3-local')?.singleImageRole).toBe('character-lock')
    expect(getVideoModel('ltx-comfy')?.conditioning).toBe('single')
    expect(getVideoModel('ltx-comfy')?.singleImageRole).toBe('first-frame')
  })

  it('seedance 2.0 is dual — both attachments are honored, no warning', () => {
    expect(getVideoModel('seedance-2.0')?.conditioning).toBe('dual')
    expect(conditioningConflictMessage('seedance-2.0')).toBe('')
    expect(conditioningConflictMessage('seedance-2.0-fast')).toBe('')
  })

  it('conflict messages say exactly what happens', () => {
    expect(conditioningConflictMessage('h3-local')).toContain('reference drives the character')
    expect(conditioningConflictMessage('h3-local')).toContain('ignored')
    expect(conditioningConflictMessage('ltx-comfy')).toContain('reference becomes the first frame')
    expect(conditioningConflictMessage('ltx-fast')).toContain("doesn't use reference images")
    expect(conditioningConflictMessage('unknown-model')).toBe('')
  })
})
