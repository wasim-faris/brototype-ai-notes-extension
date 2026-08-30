import test from 'node:test'
import assert from 'node:assert/strict'
import { generateTaskNotes } from '../src/ai/generator.js'
import { validateNotes, alignTopicsToSource, looksLikePlaceholder } from '../src/ai/schema.js'
import { resolveStudyStyle, DEFAULT_STUDY_STYLE_SETTINGS } from '../src/ai/studyStyle.js'
import { buildTaskTree, buildMainTopicBlock, buildTaskSections } from '../src/notion/blocks.js'

/**
 * The Notion page is a fixed template. The weekly task decides WHAT is in it;
 * nothing the model returns is allowed to decide its SHAPE.
 *
 * Every test here drives the real generator with a deliberately misbehaving
 * provider — one that drops subtopics, adds inventions, reorders them, renames
 * them, echoes the task title, or answers "test" — and asserts the page comes
 * out the same shape regardless.
 */

const options = { studyStyle: resolveStudyStyle(DEFAULT_STUDY_STYLE_SETTINGS), pace: async () => {}, config: {}, unit: { title: 'Mod 6' } }

// Two genuinely different weeks, with different subtopic counts.
const WEEK_A = {
  number: 1,
  title: 'Understand Advanced React Hooks',
  subtopics: ['useContext', 'useReducer', 'useMemo', 'useCallback', 'Custom Hooks'].map((title) => ({ title, children: [] })),
}
const WEEK_B = {
  number: 3,
  title: 'Understand Modern JavaScript for React',
  subtopics: ['Variables and constants', 'Scope and execution flow', 'Primitive and reference types', 'Type conversion and coercion'].map((title) => ({ title, children: [] })),
}

const body = (topic) => `Real study material about ${topic}, with enough substance to be useful.`
const sectionsFor = (topic) => [{ kind: 'text', heading: 'What is it?', text: body(topic) }]
const questions = (n, tag) => Array.from({ length: n }, (_, i) => ({ question: `${tag} question ${i + 1}?`, answer: `${tag} answer ${i + 1}.` }))

/** A provider whose task response is whatever `shape` returns. */
const providerFor = (shape) => ({
  generateStructured: async (prompt, schema) => {
    // The per-subtopic and questions schemas are the repair paths.
    if (schema?.properties?.reviewQuestions && !schema.properties.topics) return { reviewQuestions: questions(5, 'topped-up') }
    if (!schema?.properties?.topics && !schema?.properties?.reviewQuestions) {
      return { title: 'whatever', sections: sectionsFor('a repaired subtopic') }
    }
    return shape()
  },
})

const labels = (notes) => buildTaskSections(notes).map((s) => s.label)
const headingOf = (block) => block[block.type].rich_text.map((r) => r.text.content).join('')

/** Every heading in the tree, at any depth. Body prose may mention anything. */
function headings(block, out = []) {
  if (!block || typeof block !== 'object') return out
  if (Array.isArray(block)) { block.forEach((b) => headings(b, out)); return out }
  if (/^heading_[123]$/.test(block.type)) out.push(headingOf(block))
  const value = block[block.type]
  if (value?.children) headings(value.children, out)
  return out
}

/** The template: main heading, one lettered section per source subtopic, questions. */
function assertTemplate(notes, task) {
  assert.equal(headingOf(buildMainTopicBlock(notes)), `${task.number}. ${task.title}`, 'main heading is the source task, once')

  const expected = task.subtopics.map((s, i) => `${'abcdefghij'[i]}. ${s.title}`)
  const got = labels(notes).filter((l) => l !== 'summary' && l !== 'Reviewer Questions')
  assert.deepEqual(got, expected, 'one lettered section per source subtopic, in source order')

  assert.equal(notes.reviewQuestions.length, 5, 'exactly five reviewer questions')
  assert.deepEqual(validateNotes(notes, task), [], 'the structure validates against the source task')

  // The title may be mentioned in prose; it must be a HEADING exactly once.
  const asHeading = headings(buildTaskTree(notes)).filter((h) => h.includes(task.title))
  assert.equal(asHeading.length, 1, `the task title is a heading ${asHeading.length} times: ${JSON.stringify(asHeading)}`)

  const tree = JSON.stringify(buildTaskTree(notes))
  assert.ok(!/"content":"(test|TODO|placeholder|coming soon)"/i.test(tree), 'no placeholder content reached Notion')
}

// --- the same template for two different weeks ----------------------------

for (const task of [WEEK_A, WEEK_B]) {
  test(`a well-behaved response produces the template for "${task.title}"`, async () => {
    const provider = providerFor(() => ({
      number: task.number, title: task.title, summary: 'A summary.',
      topics: task.subtopics.map((s) => ({ title: s.title, sections: sectionsFor(s.title) })),
      reviewQuestions: questions(5, task.title),
    }))
    const { notes } = await generateTaskNotes(task, { ...options, provider })
    assertTemplate(notes, task)
  })
}

test('different weeks produce different content, not a shared template body', async () => {
  const run = async (task) => {
    const provider = providerFor(() => ({
      topics: task.subtopics.map((s) => ({ title: s.title, sections: sectionsFor(s.title) })),
      reviewQuestions: questions(5, task.title),
    }))
    return (await generateTaskNotes(task, { ...options, provider })).notes
  }
  const a = await run(WEEK_A)
  const b = await run(WEEK_B)

  assert.notDeepEqual(a.topics.map((t) => t.title), b.topics.map((t) => t.title))
  assert.equal(a.topics.length, 5)
  assert.equal(b.topics.length, 4, 'four source subtopics produce four sections, not five')
  assert.ok(JSON.stringify(a.topics).includes('useReducer'))
  assert.ok(JSON.stringify(b.topics).includes('Type conversion and coercion'))
})

// --- the ways a model reshapes the page -----------------------------------

test('a model that drops subtopics has them regenerated, not omitted', async () => {
  // Returns only two of the five.
  const provider = providerFor(() => ({
    topics: [
      { title: 'useContext', sections: sectionsFor('useContext') },
      { title: 'Custom Hooks', sections: sectionsFor('Custom Hooks') },
    ],
    reviewQuestions: questions(5, 'A'),
  }))
  const { notes, partial } = await generateTaskNotes(WEEK_A, { ...options, provider })

  assert.equal(partial.length, 0, 'the gaps were filled')
  assertTemplate(notes, WEEK_A)
})

test('a model that invents extra subtopics has them discarded', async () => {
  const provider = providerFor(() => ({
    topics: [
      ...WEEK_B.subtopics.map((s) => ({ title: s.title, sections: sectionsFor(s.title) })),
      { title: 'Bonus: RxJS deep dive', sections: sectionsFor('RxJS') },
      { title: 'Another thing I made up', sections: sectionsFor('nonsense') },
    ],
    reviewQuestions: questions(5, 'B'),
  }))
  const { notes } = await generateTaskNotes(WEEK_B, { ...options, provider })

  assertTemplate(notes, WEEK_B)
  assert.ok(!JSON.stringify(notes).includes('RxJS'), 'invented sections never reach Notion')
})

test('a model that reorders and renames subtopics is realigned to the source', async () => {
  const provider = providerFor(() => ({
    topics: [
      { title: 'd. TYPE CONVERSION AND COERCION', sections: sectionsFor('coercion') },
      { title: 'Variables and constants', sections: sectionsFor('variables') },
      { title: 'Primitive and reference types', sections: sectionsFor('types') },
      { title: 'Scope and execution flow', sections: sectionsFor('scope') },
    ],
    reviewQuestions: questions(5, 'B'),
  }))
  const { notes } = await generateTaskNotes(WEEK_B, { ...options, provider })

  assertTemplate(notes, WEEK_B)
  // Realigned by name, so the coercion content sits under the coercion heading.
  const coercion = notes.topics.find((t) => t.title === 'Type conversion and coercion')
  assert.ok(JSON.stringify(coercion.sections).includes('coercion'), 'content followed its own subtopic')
})

test('a model that echoes the task title as a subtopic does not duplicate the heading', async () => {
  const provider = providerFor(() => ({
    topics: [
      { title: 'Understand Modern JavaScript for React', sections: sectionsFor('the whole task') },
      ...WEEK_B.subtopics.map((s) => ({ title: s.title, sections: sectionsFor(s.title) })),
    ],
    reviewQuestions: questions(5, 'B'),
  }))
  const { notes } = await generateTaskNotes(WEEK_B, { ...options, provider })
  assertTemplate(notes, WEEK_B)   // asserts the title appears exactly once
})

test('a subtopic answered with "test" is regenerated rather than written', async () => {
  let repaired = 0
  const provider = {
    generateStructured: async (prompt, schema) => {
      if (schema?.properties?.reviewQuestions && !schema.properties.topics) return { reviewQuestions: questions(5, 'Q') }
      if (!schema?.properties?.topics) { repaired++; return { title: 'useMemo', sections: sectionsFor('useMemo, properly this time') } }
      return {
        topics: WEEK_A.subtopics.map((s) => ({
          title: s.title,
          sections: s.title === 'useMemo' ? [{ kind: 'text', heading: 'What is it?', text: 'test' }] : sectionsFor(s.title),
        })),
        reviewQuestions: questions(5, 'A'),
      }
    },
  }
  const { notes } = await generateTaskNotes(WEEK_A, { ...options, provider })

  assert.equal(repaired, 1, 'the placeholder subtopic was asked for again')
  assertTemplate(notes, WEEK_A)
  assert.ok(JSON.stringify(notes).includes('properly this time'))
})

test('a model returning too few reviewer questions is topped up to five', async () => {
  const provider = providerFor(() => ({
    topics: WEEK_A.subtopics.map((s) => ({ title: s.title, sections: sectionsFor(s.title) })),
    reviewQuestions: questions(2, 'partial'),
  }))
  const { notes } = await generateTaskNotes(WEEK_A, { ...options, provider })

  assert.equal(notes.reviewQuestions.length, 5)
  assert.equal(notes.reviewQuestions[0].question, 'partial question 1?', 'the ones it did give are kept')
  assert.ok(notes.reviewQuestions.some((q) => q.question.startsWith('topped-up')), 'the rest were requested')
})

test('a model returning more than five reviewer questions is trimmed to five', async () => {
  const provider = providerFor(() => ({
    topics: WEEK_A.subtopics.map((s) => ({ title: s.title, sections: sectionsFor(s.title) })),
    reviewQuestions: questions(9, 'A'),
  }))
  const { notes } = await generateTaskNotes(WEEK_A, { ...options, provider })
  assert.equal(notes.reviewQuestions.length, 5)
})

// --- the pieces on their own ----------------------------------------------

test('alignment never returns more sections than the task has subtopics', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ title: `Invented ${i}`, sections: [{ kind: 'text', heading: 'h', text: 'x' }] }))
  const { topics, missing } = alignTopicsToSource(many, WEEK_B.subtopics)

  // Twelve inventions for four subtopics: none of them is trustworthy, so all
  // four are regenerated rather than filled with whatever came back.
  assert.equal(topics.length + missing.length, WEEK_B.subtopics.length)
  assert.equal(topics.length, 0, 'nothing that names no source subtopic is used')
  assert.deepEqual(missing.map((m) => m.title), WEEK_B.subtopics.map((s) => s.title))
})

test('content is never filed under the wrong subtopic when the model adds or drops one', () => {
  // The model returns four topics for five subtopics, out of order, one of them
  // an invention. Position is meaningless here: matching by it once put
  // useMemo's content under the useReducer heading.
  const ai = [
    { title: 'Custom Hooks', sections: [{ kind: 'text', heading: 'h', text: 'about custom hooks' }] },
    { title: 'useMemo', sections: [{ kind: 'text', heading: 'h', text: 'about useMemo' }] },
    { title: 'A bonus topic nobody asked for', sections: [{ kind: 'text', heading: 'h', text: 'noise' }] },
    { title: 'useContext', sections: [{ kind: 'text', heading: 'h', text: 'about useContext' }] },
  ]
  const { topics, missing } = alignTopicsToSource(ai, WEEK_A.subtopics)

  for (const topic of topics) {
    const body = JSON.stringify(topic.sections)
    assert.ok(body.includes(topic.title.toLowerCase()) || body.includes(topic.title),
      `"${topic.title}" holds content that is not its own: ${body}`)
    assert.ok(!body.includes('noise'), 'the invention was filed under a real subtopic')
  }
  assert.deepEqual(missing.map((m) => m.title), ['useReducer', 'useCallback'], 'the unmatched ones are regenerated')
})

test('a renamed subtopic is regenerated, never guessed at by position', () => {
  // One topic per subtopic, only the wording of one differs. Position would
  // "recover" it — but a renamed subtopic and an invented one are
  // indistinguishable from here, so guessing would eventually file invented
  // content under a real heading. It is regenerated against the source instead.
  const ai = WEEK_B.subtopics.map((s, i) => ({
    title: i === 1 ? 'How code runs, top to bottom' : s.title,
    sections: [{ kind: 'text', heading: 'h', text: `content ${i}` }],
  }))
  const { topics, missing } = alignTopicsToSource(ai, WEEK_B.subtopics)

  assert.deepEqual(missing.map((m) => m.title), ['Scope and execution flow'])
  assert.ok(!JSON.stringify(topics).includes('content 1'), 'the unmatched content is not filed anywhere')
  assert.deepEqual(topics.map((t) => t.title),
    WEEK_B.subtopics.filter((s) => s.title !== 'Scope and execution flow').map((s) => s.title))
})

test('placeholder detection is narrow enough not to flag real prose', () => {
  for (const fake of ['test', 'Testing', 'TODO', 'placeholder', 'coming soon', 'N/A', 'TBD', 'example']) {
    assert.ok(looksLikePlaceholder(fake), `${fake} should be treated as a placeholder`)
  }
  for (const real of [
    'Testing your reducer with Jest keeps regressions out.',
    'Check whether the dependency array actually changed.',
    'useMemo caches an expensive computed value between renders.',
  ]) {
    assert.ok(!looksLikePlaceholder(real), `real prose was flagged: ${real}`)
  }
})

test('validateNotes reports every structural rule it is given', () => {
  const good = {
    number: WEEK_B.number, title: WEEK_B.title,
    topics: WEEK_B.subtopics.map((s) => ({ title: s.title, sections: sectionsFor(s.title) })),
    reviewQuestions: questions(5, 'B'),
  }
  assert.deepEqual(validateNotes(good, WEEK_B), [])

  const missing = { ...good, topics: good.topics.slice(0, 2) }
  assert.ok(validateNotes(missing, WEEK_B).some((p) => p.includes('is missing')))

  const renamed = { ...good, title: 'Something the model preferred' }
  assert.ok(validateNotes(renamed, WEEK_B).some((p) => p.includes('main title')))

  const shortQuestions = { ...good, reviewQuestions: questions(3, 'B') }
  assert.ok(validateNotes(shortQuestions, WEEK_B).some((p) => p.includes('instead of 5')))

  const empty = { ...good, topics: [{ title: WEEK_B.subtopics[0].title, sections: [{ kind: 'text', heading: 'h', text: 'test' }] }, ...good.topics.slice(1)] }
  assert.ok(validateNotes(empty, WEEK_B).some((p) => p.includes('no real study content')))
})

// --- the two rules that guessing and partial writes used to break -----------

test('an invented topic is never filed under a real subtopic heading', async () => {
  // Four correct names plus one invention, for five subtopics. Pairing the
  // leftovers would put "Invented thing" under "Custom Hooks": a page that
  // looks complete and teaches something nobody asked for.
  let repairedFor = null
  const provider = {
    generateStructured: async (prompt, schema) => {
      if (schema?.properties?.reviewQuestions && !schema.properties.topics) return { reviewQuestions: questions(5, 'Q') }
      if (!schema?.properties?.topics) {
        repairedFor = (/ONE subtopic: (.+)$/m.exec(prompt.user) || [])[1]
        return { title: 'x', sections: sectionsFor(repairedFor) }
      }
      return {
        topics: [
          ...WEEK_A.subtopics.slice(0, 4).map((s) => ({ title: s.title, sections: sectionsFor(s.title) })),
          { title: 'Invented thing', sections: [{ kind: 'text', heading: 'h', text: 'INVENTED-NOISE' }] },
        ],
        reviewQuestions: questions(5, 'A'),
      }
    },
  }
  const { notes } = await generateTaskNotes(WEEK_A, { ...options, provider })

  assertTemplate(notes, WEEK_A)
  assert.equal(repairedFor, 'Custom Hooks', 'the unmatched subtopic was regenerated by name')
  assert.ok(!JSON.stringify(notes).includes('INVENTED-NOISE'), 'the invention reached nothing')
})

test('a subtopic that still cannot be written fails the task rather than shortening the page', async () => {
  const provider = {
    generateStructured: async (prompt, schema) => {
      if (schema?.properties?.reviewQuestions && !schema.properties.topics) return { reviewQuestions: questions(5, 'Q') }
      if (!schema?.properties?.topics) throw Object.assign(new Error('the provider refused'), { code: 'AI_FAILED' })
      return {
        topics: [{ title: 'useContext', sections: sectionsFor('useContext') }],
        reviewQuestions: questions(5, 'A'),
      }
    },
  }

  await assert.rejects(() => generateTaskNotes(WEEK_A, { ...options, provider }), (error) => {
    assert.equal(error.code, 'AI_INCOMPLETE_TASK')
    // Naming them matters: the student needs to know which part is missing.
    for (const name of ['useReducer', 'useMemo', 'useCallback', 'Custom Hooks']) {
      assert.ok(error.message.includes(name), `the message does not name ${name}`)
    }
    assert.ok(error.retryable)
    return true
  })
})

test('the letters never shift onto the wrong subtopic', async () => {
  // The failure mode a short page produces: drop "useReducer" and "Custom
  // Hooks" slides from e to b. Nothing may reach Notion in that state.
  const provider = providerFor(() => ({
    topics: [{ title: 'useContext', sections: sectionsFor('useContext') }, { title: 'Custom Hooks', sections: sectionsFor('Custom Hooks') }],
    reviewQuestions: questions(5, 'A'),
  }))
  const { notes } = await generateTaskNotes(WEEK_A, { ...options, provider })

  const lettered = labels(notes).filter((l) => l !== 'summary' && l !== 'Reviewer Questions')
  assert.deepEqual(lettered, ['a. useContext', 'b. useReducer', 'c. useMemo', 'd. useCallback', 'e. Custom Hooks'])
  assert.equal(lettered[4], 'e. Custom Hooks', 'Custom Hooks stayed at e')
})

// --- responses observed from the live OpenRouter run ------------------------

const MODERN_JS = {
  number: 1,
  title: 'Understand Modern JavaScript for React',
  subtopics: ['Variables and constants', 'Scope and execution flow', 'Primitive and reference types',
    'Type conversion and coercion', 'Template literals'].map((title) => ({ title, children: [] })),
}

test('the overview is never written as placeholder text', async () => {
  // Verbatim from a live run: the model titled the task "test" and summarised
  // it "This is a test." The title was already ignored; the summary was not,
  // and reached Notion as the page's 📌 overview.
  const provider = providerFor(() => ({
    number: 1, title: 'test', summary: 'This is a test.',
    topics: MODERN_JS.subtopics.map((s) => ({ title: s.title, sections: sectionsFor(s.title) })),
    reviewQuestions: questions(5, 'A'),
  }))
  const { notes } = await generateTaskNotes(MODERN_JS, { ...options, provider })

  assert.equal(notes.summary, '', 'a placeholder overview is dropped, not written')
  assert.ok(!labels(notes).includes('summary'), 'so no 📌 block is built at all')
  assertTemplate(notes, MODERN_JS)
})

test('a real overview is kept', async () => {
  const provider = providerFor(() => ({
    summary: 'Modern JavaScript gives React its building blocks: let, const, destructuring and modules.',
    topics: MODERN_JS.subtopics.map((s) => ({ title: s.title, sections: sectionsFor(s.title) })),
    reviewQuestions: questions(5, 'A'),
  }))
  const { notes } = await generateTaskNotes(MODERN_JS, { ...options, provider })

  assert.ok(notes.summary.includes('building blocks'))
  assert.equal(labels(notes)[0], 'summary')
})

test('a response with no topics array at all still produces five sections', async () => {
  // Also verbatim from a live run: the model ignored the schema and returned
  // { title, sections: [...] } with the subtopics as section headings. There
  // were zero topics to align, so all five slots were regenerated.
  let regenerated = 0
  const provider = {
    generateStructured: async (prompt, schema) => {
      if (schema?.properties?.reviewQuestions && !schema.properties.topics) return { reviewQuestions: questions(5, 'Q') }
      if (!schema?.properties?.topics) {
        regenerated++
        const name = (/ONE subtopic: (.+)$/m.exec(prompt.user) || [])[1]
        return { title: name, sections: sectionsFor(name) }
      }
      return {
        title: '1. Understand Modern JavaScript for React (Mod 6)',
        sections: MODERN_JS.subtopics.map((s, i) => ({ heading: `${'abcde'[i]}. ${s.title}`, kind: 'text', text: 'prose' })),
      }
    },
  }
  const { notes } = await generateTaskNotes(MODERN_JS, { ...options, provider })

  assert.equal(regenerated, 5, 'every slot was filled individually')
  assertTemplate(notes, MODERN_JS)
})

test('the number of sections comes from the source, never from the response', async () => {
  // One source, four different response shapes. The section count never moves.
  const shapes = [
    () => ({ topics: [{ title: 'Variables and constants', sections: sectionsFor('one') }], reviewQuestions: questions(5, 'A') }),
    () => ({ topics: [], reviewQuestions: questions(5, 'A') }),
    () => ({ topics: MODERN_JS.subtopics.map((s) => ({ title: s.title, sections: sectionsFor(s.title) })), reviewQuestions: questions(5, 'A') }),
    () => ({ topics: Array.from({ length: 9 }, (_, i) => ({ title: `Invented ${i}`, sections: sectionsFor(`x${i}`) })), reviewQuestions: questions(5, 'A') }),
  ]
  for (const [i, shape] of shapes.entries()) {
    const { notes } = await generateTaskNotes(MODERN_JS, { ...options, provider: providerFor(shape) })
    assert.equal(notes.topics.length, 5, `shape ${i} produced ${notes.topics.length} sections`)
    assert.deepEqual(notes.topics.map((t) => t.title), MODERN_JS.subtopics.map((s) => s.title), `shape ${i} changed the titles`)
  }
})
