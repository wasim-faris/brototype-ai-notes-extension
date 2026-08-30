import test from 'node:test'
import assert from 'node:assert/strict'
import { richText, code, buildTopicBlocks, buildTaskSections, buildQuestionsBlock, notionLanguage } from '../src/notion/blocks.js'

const sampleTopic = {
  title: 'useContext',
  whatIsIt: 'A React hook that reads a value from a Context.',
  simpleExplanation: 'It lets a component grab shared data without passing props down every level.',
  whyItExists: 'Before it, you passed props through components that did not care about them.',
  problemSolved: 'Prop drilling.',
  howItWorks: 'React walks up the tree to the nearest matching Provider.',
  keyConcepts: ['Provider — supplies the value', 'Consumer — reads the value'],
  syntax: 'const value = useContext(MyContext)',
  codeLanguage: 'jsx',
  codeExample: 'const theme = useContext(ThemeContext)',
  codeExplanation: ['Line 1: reads the current theme'],
  realLifeAnalogy: 'Like a noticeboard in a building.',
  realProjectExample: 'The logged-in user in a shopping cart app.',
  whenToUse: ['Theme', 'Logged-in user'],
  whenNotToUse: ['High-frequency updates'],
  commonMistakes: ['Creating the value object inline, which re-renders everything'],
  importantPoints: ['Every consumer re-renders when the value changes'],
  relatedConcepts: ['useReducer — pairs well with Context'],
  beginnerTips: ['Start with props; reach for Context when it hurts'],
  practicalScenario: 'You are building a dashboard and the header needs the username.',
}

test('rich text handles bold and inline code', () => {
  const rt = richText('Use **Provider** and call `useContext`.')
  assert.equal(rt.length, 5)
  assert.equal(rt[1].annotations.bold, true)
  assert.equal(rt[1].text.content, 'Provider')
  assert.equal(rt[3].annotations.code, true)
  assert.equal(rt[3].text.content, 'useContext')
})

test('no rich-text object exceeds Notion 2000-character limit', () => {
  const long = 'word '.repeat(3000)
  for (const item of richText(long)) {
    assert.ok(item.text.content.length <= 2000, `chunk was ${item.text.content.length}`)
  }
  assert.ok(richText(long).length > 1)
})

test('code languages are mapped to values Notion accepts', () => {
  assert.equal(notionLanguage('jsx'), 'javascript')
  assert.equal(notionLanguage('TSX'), 'typescript')
  assert.equal(notionLanguage('sh'), 'shell')
  assert.equal(notionLanguage('brainfuck'), 'plain text')
  assert.equal(code('x', 'jsx').code.language, 'javascript')
})

test('a legacy flat-field topic still renders every section as proper block types', () => {
  const blocks = buildTopicBlocks(sampleTopic)
  const types = blocks.map((b) => b.type)

  assert.ok(types.includes('heading_3'))
  assert.ok(types.includes('bulleted_list_item'))
  assert.ok(types.includes('numbered_list_item'))
  assert.ok(types.includes('code'))
  assert.ok(types.includes('paragraph'))

  const headings = blocks.filter((b) => b.type === 'heading_3').map((b) => b.heading_3.rich_text[0].text.content)
  assert.ok(headings.includes('What is it?'))
  assert.ok(headings.includes('When NOT to use it'))
  assert.ok(headings.includes('Common mistakes'))
  assert.ok(headings.includes('Analogy'))
  assert.ok(headings.includes('In short'), 'the legacy summary becomes a plain section')
  // learning order: the problem comes before the definition
  assert.ok(headings.indexOf('What problem does it solve?') < headings.indexOf('What is it?'))
  assert.ok(headings.indexOf('Basic syntax') < headings.indexOf('Simple example'))
})

test('optional fields simply disappear instead of leaving empty headings', () => {
  const blocks = buildTopicBlocks({ title: 'Prop drilling', whatIsIt: 'Passing props down.', codeExample: '', keyConcepts: [] })
  const headings = blocks.filter((b) => b.type === 'heading_3').map((b) => b.heading_3.rich_text[0].text.content)
  assert.ok(!headings.includes('Simple example'))
  assert.ok(!headings.includes('Complete working code'))
  assert.ok(!headings.includes('Important things to understand'))
  assert.ok(headings.includes('What is it?'))
})

test('reviewer questions become a toggle of toggles', () => {
  const questions = Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, answer: `A${i}.` }))
  const blockOut = buildQuestionsBlock(questions)
  assert.equal(blockOut.type, 'toggle')
  assert.equal(blockOut.toggle.children.length, 5)
  assert.equal(blockOut.toggle.children[0].type, 'toggle')
  assert.equal(blockOut.toggle.children[0].toggle.children[0].type, 'paragraph')
})

test('task sections give one toggle per subtopic plus questions', () => {
  const sections = buildTaskSections({
    number: 1, title: 'Advanced React Hooks', summary: 'Hooks for shared state.',
    topics: [sampleTopic, { ...sampleTopic, title: 'useReducer' }],
    reviewQuestions: [{ question: 'Why?', answer: 'Because.' }],
  })

  assert.deepEqual(sections.map((s) => s.label), ['summary', 'a. useContext', 'b. useReducer', 'Reviewer Questions'])
  // subtopic = a toggle HEADING, lettered like Brototype's own list
  assert.equal(sections[1].blocks[0].type, 'heading_2')
  assert.equal(sections[1].blocks[0].heading_2.is_toggleable, true)
  assert.equal(sections[1].blocks[0].heading_2.rich_text[0].text.content, 'a. useContext')
  assert.ok(sections[1].blocks[0].heading_2.children.length > 5, 'content is INSIDE the subtopic toggle')
})

test('nesting never exceeds Notion two-levels-per-request rule', () => {
  const depth = (b) => {
    const kids = b[b.type]?.children || []
    return kids.length ? 1 + Math.max(...kids.map(depth)) : 0
  }
  for (const section of buildTaskSections({ number: 1, title: 't', topics: [sampleTopic], reviewQuestions: [{ question: 'q', answer: 'a' }] })) {
    for (const b of section.blocks) assert.ok(depth(b) <= 2, `block ${b.type} nests ${depth(b)} deep`)
  }
})
