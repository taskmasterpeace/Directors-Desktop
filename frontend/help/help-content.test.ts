import { describe, it, expect } from 'vitest'
import {
  HELP_AREAS,
  HELP_SECTIONS,
  HELP_SECTION_IDS,
  helpSectionsByArea,
  searchHelp,
  helpKnowledgeText,
} from './help-content'

describe('help-content — the single source of truth', () => {
  it('covers 100% of the app: every TOC area has at least one section', () => {
    for (const area of HELP_AREAS) {
      const inArea = HELP_SECTIONS.filter((s) => s.area === area)
      expect(inArea.length, `area "${area}" has no help sections`).toBeGreaterThan(0)
    }
  })

  it('every section uses a valid area', () => {
    for (const s of HELP_SECTIONS) {
      expect(HELP_AREAS, `section ${s.id} has area not in HELP_AREAS`).toContain(s.area)
    }
  })

  it('section ids are unique', () => {
    expect(new Set(HELP_SECTION_IDS).size).toBe(HELP_SECTION_IDS.length)
  })

  it('every section has the required fields', () => {
    for (const s of HELP_SECTIONS) {
      expect(s.id, 'missing id').toBeTruthy()
      expect(s.title, `${s.id} missing title`).toBeTruthy()
      expect(s.icon, `${s.id} missing icon`).toBeTruthy()
      expect(s.blurb.length, `${s.id} blurb too short`).toBeGreaterThan(20)
    }
  })

  it('no "related" link is dangling (all resolve to real sections)', () => {
    const ids = new Set(HELP_SECTION_IDS)
    for (const s of HELP_SECTIONS) {
      for (const rid of s.related ?? []) {
        expect(ids.has(rid), `${s.id} → related "${rid}" does not exist`).toBe(true)
      }
    }
  })

  it('the agentic "how the AI works" area is present and explained', () => {
    const ai = HELP_SECTIONS.filter((s) => s.area === 'Director’s Pal (AI)')
    expect(ai.length).toBeGreaterThanOrEqual(3)
    expect(ai.map((s) => s.id)).toContain('directors-pal-overview')
    expect(ai.map((s) => s.id)).toContain('directors-pal-perception')
    expect(ai.map((s) => s.id)).toContain('agent-bridge')
  })

  it('the timeline’s "fancy buttons" are documented across several sections', () => {
    const timeline = HELP_SECTIONS.filter((s) => s.area === 'Timeline')
    // Menus, tools, transport, tracks, clips, context menu, takes, shortcuts, …
    expect(timeline.length).toBeGreaterThanOrEqual(10)
    const ids = timeline.map((s) => s.id)
    for (const must of ['timeline-context-menu', 'timeline-takes', 'timeline-shortcuts', 'timeline-tracks']) {
      expect(ids, `timeline missing ${must}`).toContain(must)
    }
  })

  it('helpSectionsByArea returns groups in HELP_AREAS order with no empties', () => {
    const groups = helpSectionsByArea()
    expect(groups.length).toBe(HELP_AREAS.length)
    groups.forEach((g, i) => {
      expect(g.area).toBe(HELP_AREAS[i])
      expect(g.sections.length).toBeGreaterThan(0)
    })
  })

  it('search finds sections by title, keyword, and control label', () => {
    expect(searchHelp('captions').some((s) => s.id === 'timeline-transcript')).toBe(true)
    expect(searchHelp('batch').some((s) => s.id === 'batch')).toBe(true)
    expect(searchHelp('replace person').some((s) => s.id === 'timeline-replace-person')).toBe(true)
    expect(searchHelp('').length).toBe(HELP_SECTIONS.length) // empty query = everything
    expect(searchHelp('zzzznotathing').length).toBe(0)
  })

  it('the Director’s Pal knowledge dump includes every section', () => {
    const text = helpKnowledgeText()
    for (const s of HELP_SECTIONS) {
      expect(text, `knowledge text missing ${s.id}`).toContain(`id: ${s.id}`)
    }
  })
})
