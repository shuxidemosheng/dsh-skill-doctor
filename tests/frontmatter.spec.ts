import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from '../src/scanner/frontmatter'

describe('parseFrontmatter', () => {
  it('parses a normal block and records the body line offset', () => {
    const parsed = parseFrontmatter('---\nname: demo\ndescription: A demo\n---\nBody\n')
    expect(parsed.error).toBeUndefined()
    expect(parsed.data).toEqual({ name: 'demo', description: 'A demo' })
    expect(parsed.body).toBe('Body\n')
    expect(parsed.bodyLineOffset).toBe(5)
  })

  it('accepts CRLF and a leading BOM', () => {
    const parsed = parseFrontmatter('\uFEFF---\r\nname: demo\r\ndescription: d\r\n---\r\nBody\r\n')
    expect(parsed.error).toBeUndefined()
    expect(parsed.data.name).toBe('demo')
    expect(parsed.body).toBe('Body\n')
  })

  it('parses block scalars and nested maps', () => {
    const parsed = parseFrontmatter('---\nname: demo\ndescription: >-\n  Folded\n  text\nmetadata:\n  key: value\n---\nBody\n')
    expect(parsed.data.description).toBe('Folded text')
    expect(parsed.data.metadata).toEqual({ key: 'value' })
  })

  it('reports missing, unterminated, invalid and non-object frontmatter', () => {
    expect(parseFrontmatter('no frontmatter\n').error).toMatch(/missing frontmatter/)
    expect(parseFrontmatter('---\nname: demo\n').error).toMatch(/unterminated/)
    expect(parseFrontmatter('---\nname: [unclosed\n---\nBody\n').error).toMatch(/invalid YAML/)
    expect(parseFrontmatter('---\n- a\n- b\n---\nBody\n').error).toMatch(/mapping/)
  })
})
