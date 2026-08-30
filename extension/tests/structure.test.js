import test from 'node:test'
import assert from 'node:assert/strict'
import { normaliseTask, normaliseSection, SECTION_KINDS, MAX_SECTIONS_PER_TOPIC, TASK_SCHEMA } from '../src/ai/schema.js'
import { cleanProse, cleanList, cleanCode, cleanHeading, stripFences } from '../src/ai/content.js'
import { buildTaskTree, buildMainTopicBlock, buildSubtopicToggle, buildTopicBlocks, table } from '../src/notion/blocks.js'
import { CORE_RULES } from '../src/ai/prompt.js'

/**
 * THE contract:
 *
 *   ▸ 1. Main topic            H1 toggle        app decides
 *       ▸ a. Subtopic          H2 toggle        app decides
 *           <section>          H3 + content     AI decides WHICH sections and their words;
 *                                               app decides the block types
 *
 * The same notes in five model dialects must give an identical structure.
 */

const task = {
  number: 1,
  title: 'Understand Advanced React Hooks',
  subtopics: [{ title: 'useContext', children: [] }, { title: 'useReducer', children: [] }],
}

const sec = (heading, kind, payload) => ({
  heading, kind, text: '', items: [], code: '', language: '', tableHeaders: [], tableRows: [], ...payload,
})

/** Clean, exactly our schema - a strict-schema provider (Gemini / OpenAI strict / Claude tool). */
const geminiShaped = {
  number: 1, title: 'Understand Advanced React Hooks', summary: 'Hooks for sharing state.',
  topics: [
    {
      title: 'useContext',
      sections: [
        sec('What is useContext?', 'text', { text: 'Lets a component get shared data without passing props through every component.' }),
        sec('Real-world example', 'text', { text: 'A dark/light theme shared by many components.' }),
        sec('useState vs useContext', 'table', { tableHeaders: ['useState', 'useContext'], tableRows: [['Manages state', 'Shares data'], ['Usually local', 'Across components']] }),
        sec('Simple example', 'code', { code: 'const theme = useContext(ThemeContext);', language: 'jsx' }),
      ],
    },
    {
      title: 'useReducer',
      sections: [
        sec('What is useReducer?', 'text', { text: 'Manages state when the update logic gets complex.' }),
        sec('How it works', 'list', { items: ['dispatch(action)', 'reducer(state, action)', 'new state'] }),
        sec('Simple example', 'code', { code: 'dispatch({ type: "INCREMENT" });', language: 'jsx' }),
      ],
    },
  ],
  reviewQuestions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, answer: `A${i}.` })),
}

/** Same content, but the model wrote markdown INSIDE the fields and used its own kind names. */
const gptShaped = {
  ...geminiShaped,
  topics: geminiShaped.topics.map((t) => ({
    ...t,
    sections: t.sections.map((s) => ({
      ...s,
      heading: `### **${s.heading}**`,
      kind: { text: 'paragraph', list: 'bullets', code: 'snippet', table: 'comparison' }[s.kind],
      text: s.text ? `**${s.heading}:** ${s.text}` : '',
      items: s.items.map((i) => `- ${i}`),
      code: s.code ? '```jsx\n' + s.code + '\n```' : '',
      language: '',
    })),
  })),
}

/** A Llama-style prompt-mode answer: wrapper object, "subtopics", invented key names, rows as "a | b". */
const llamaShaped = {
  task: {
    title: 'Understand Advanced React Hooks',
    summary: 'Hooks for sharing state.',
    subtopics: geminiShaped.topics.map((t) => ({
      name: t.title,
      parts: t.sections.map((s) => ({
        title: s.heading,
        type: s.kind,
        content: s.text,
        points: s.items,
        snippet: s.code,
        lang: s.language,
        columns: s.tableHeaders,
        rows: s.tableRows.map((r) => r.join(' | ')),
      })),
    })),
    questions: geminiShaped.reviewQuestions.map((q) => ({ q: q.question, a: q.answer })),
  },
}

/** DeepSeek-style: topics as an object keyed by title, no "kind" at all - the content implies it. */
const deepseekShaped = {
  title: 'Understand Advanced React Hooks',
  summary: 'Hooks for sharing state.',
  topics: Object.fromEntries(geminiShaped.topics.map((t) => [t.title, {
    sections: t.sections.map(({ kind, ...rest }) => rest),
  }])),
  reviewerQuestions: geminiShaped.reviewQuestions,
}

/** Claude tool input: clean, but numbered questions and labelled answers. */
const claudeShaped = {
  ...geminiShaped,
  reviewQuestions: geminiShaped.reviewQuestions.map((q, i) => ({ question: `Q${i + 1}. ${q.question}`, answer: `Answer: ${q.answer}` })),
}

const DIALECTS = { gemini: geminiShaped, gpt: gptShaped, llama: llamaShaped, deepseek: deepseekShaped, claude: claudeShaped }

/** Structure only: block types, toggle-ness, headings, nesting. Never content. */
function signature(block) {
  const value = block[block.type] || {}
  const label = ['heading_1', 'heading_2', 'heading_3', 'toggle'].includes(block.type)
    ? value.rich_text?.map((r) => r.text.content).join('')
    : undefined
  return {
    type: block.type,
    ...(value.is_toggleable ? { toggle: true } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(value.children?.length ? { children: value.children.map(signature) } : {}),
  }
}

const subtopicsOf = (tree) => tree.heading_1.children.filter((b) => b.type === 'heading_2')
const h3sOf = (sub) => sub.heading_2.children.filter((b) => b.type === 'heading_3').map((b) => b.heading_3.rich_text[0].text.content)

// --- 1-5: the fixed hierarchy ---------------------------------------------------------

test('1. the main topic is always an H1 toggle', () => {
  const root = buildMainTopicBlock({ number: 3, title: 'Understand Context API' })
  assert.equal(root.type, 'heading_1')
  assert.equal(root.heading_1.is_toggleable, true)
  assert.equal(root.heading_1.rich_text[0].text.content, '3. Understand Context API')
})

test('2 + 3. every subtopic is an H2 toggle INSIDE the main topic', () => {
  const tree = buildTaskTree(normaliseTask(geminiShaped, task))
  assert.equal(tree.type, 'heading_1', 'one root')
  const subs = subtopicsOf(tree)
  assert.equal(subs.length, 2)
  for (const s of subs) assert.equal(s.heading_2.is_toggleable, true)
})

test('4. subtopics are labelled a. b. c. in order', () => {
  const tree = buildTaskTree(normaliseTask(geminiShaped, task))
  assert.deepEqual(subtopicsOf(tree).map((b) => b.heading_2.rich_text[0].text.content), ['a. useContext', 'b. useReducer'])
  assert.equal(buildSubtopicToggle({ title: 'useMemo', sections: [sec('x', 'text', { text: 'y' })] }, 2).heading_2.rich_text[0].text.content, 'c. useMemo')
})

test('5. every section is inside its own subtopic as H3 + content, and nothing higher leaks in', () => {
  const tree = buildTaskTree(normaliseTask(geminiShaped, task))
  for (const sub of subtopicsOf(tree)) {
    for (const k of sub.heading_2.children) {
      assert.ok(!['heading_1', 'heading_2'].includes(k.type), `a ${k.type} leaked inside a subtopic`)
    }
  }
  assert.ok(!tree.heading_1.children.some((b) => b.type === 'heading_3'), 'no H3 directly under the main topic')
})

// --- 6: the AI's choice of sections is honoured exactly --------------------------------

test('6. the sections are the ones the AI chose, in the order it chose, and nothing is added', () => {
  const tree = buildTaskTree(normaliseTask(geminiShaped, task))
  const [ctx, red] = subtopicsOf(tree)
  assert.deepEqual(h3sOf(ctx), ['What is useContext?', 'Real-world example', 'useState vs useContext', 'Simple example'])
  assert.deepEqual(h3sOf(red), ['What is useReducer?', 'How it works', 'Simple example'])
  // the block after each heading is the kind the AI asked for
  const types = ctx.heading_2.children.map((b) => b.type)
  assert.deepEqual(types, ['heading_3', 'paragraph', 'heading_3', 'paragraph', 'heading_3', 'table', 'heading_3', 'code'])
})

test('6b. a one-section topic stays a one-section topic - no template is imposed', () => {
  const vite = normaliseTask({
    topics: [{ title: 'What is Vite?', sections: [
      sec('What is Vite?', 'text', { text: 'Vite is a frontend build tool and development server.' }),
      sec('It helps', 'list', { items: ['Create a React project', 'Start a local dev server', 'Reload changes quickly', 'Build for production'] }),
    ] }],
    reviewQuestions: [],
  }, { number: 4, title: 'Tooling', subtopics: [{ title: 'What is Vite?', children: [] }] })

  const [sub] = subtopicsOf(buildTaskTree(vite))
  assert.deepEqual(h3sOf(sub), ['What is Vite?', 'It helps'])
  assert.equal(sub.heading_2.children.length, 2 + 1 + 4, 'two headings, one paragraph, four bullets - nothing else')
})

test('6c. a comparison table renders as a real Notion table with header row', () => {
  const [ctx] = normaliseTask(geminiShaped, task).topics
  const tbl = buildTopicBlocks(ctx).find((b) => b.type === 'table')
  assert.equal(tbl.table.table_width, 2)
  assert.equal(tbl.table.has_column_header, true)
  assert.equal(tbl.table.children.length, 3, 'header + 2 rows')
  assert.equal(tbl.table.children[0].type, 'table_row')
  assert.equal(tbl.table.children[1].table_row.cells[0][0].text.content, 'Manages state')
  // ragged rows are padded so Notion accepts them
  assert.equal(table(['a', 'b', 'c'], [['1']]).table.children[1].table_row.cells.length, 3)
})

// --- 7 + 9: model independence ---------------------------------------------------------

test('7. five differently-shaped model responses give the IDENTICAL structure', () => {
  const signatures = Object.fromEntries(
    Object.entries(DIALECTS).map(([name, payload]) => [name, JSON.stringify(signature(buildTaskTree(normaliseTask(payload, task))))]),
  )
  for (const [name, sig] of Object.entries(signatures)) {
    assert.equal(sig, signatures.gemini, `${name} produced a different Notion structure`)
  }
})

test('7b. every dialect recovered the content, not just the hierarchy', () => {
  for (const [name, payload] of Object.entries(DIALECTS)) {
    const notes = normaliseTask(payload, task)
    const [ctx] = notes.topics
    assert.equal(ctx.sections[0].text, 'Lets a component get shared data without passing props through every component.', name)
    assert.equal(ctx.sections[2].kind, 'table', name)
    assert.deepEqual(ctx.sections[2].rows[0], ['Manages state', 'Shares data'], name)
    assert.equal(ctx.sections[3].code, 'const theme = useContext(ThemeContext);', name)
    assert.equal(ctx.sections[3].language, 'jsx', `${name}: language recovered from the fence or field`)
    assert.equal(notes.reviewQuestions.length, 5, name)
    assert.equal(notes.reviewQuestions[0].question, 'Q0?', name)
    assert.equal(notes.reviewQuestions[0].answer, 'A0.', name)
  }
})

test('9. a model cannot restructure: its markup is stripped, not rendered', () => {
  const walk = (b, out = []) => { out.push(b); for (const c of b[b.type]?.children || []) walk(c, out); return out }
  for (const b of walk(buildTaskTree(normaliseTask(gptShaped, task)))) {
    if (b.type === 'code') continue
    for (const rt of b[b.type]?.rich_text || []) {
      assert.ok(!/^\s*#{1,6}\s/.test(rt.text.content), `markdown heading rendered: ${rt.text.content}`)
      assert.ok(!/^\s*[-*•]\s/.test(rt.text.content), `bullet marker rendered: ${rt.text.content}`)
      assert.ok(!/```/.test(rt.text.content), `fence rendered: ${rt.text.content}`)
    }
  }
  const [ctx] = normaliseTask(gptShaped, task).topics
  assert.equal(ctx.sections[0].heading, 'What is useContext?', '"### **…**" became a plain heading')
  assert.ok(!ctx.sections[0].text.startsWith('**What is useContext?'), 'the duplicated label is gone')
})

test('9b. a model that answers with prose instead of data is rejected, never written', () => {
  assert.throws(() => normaliseTask('# useContext\n\nuseContext lets you…', task), /not an object/)
  assert.throws(() => normaliseTask({ markdown: '# 1. Hooks\n## a. useContext' }, task), /no usable topics/)
})

test('9c. a verbose model is capped, so one subtopic cannot become a chapter', () => {
  const many = Array.from({ length: 20 }, (_, i) => sec(`Section ${i}`, 'text', { text: `t${i}` }))
  const notes = normaliseTask({ topics: [{ title: 'useContext', sections: many }] }, task)
  assert.equal(notes.topics[0].sections.length, MAX_SECTIONS_PER_TOPIC)
  assert.equal(TASK_SCHEMA.properties.topics.items.properties.sections.maxItems, MAX_SECTIONS_PER_TOPIC)
})

// --- 8: missing / odd content ----------------------------------------------------------

test('8. empty sections vanish; the hierarchy never does', () => {
  const sparse = {
    topics: [
      { title: 'Prop drilling', sections: [sec('What is it?', 'text', { text: 'Passing props through layers that do not need them.' }), sec('Empty', 'list', {})] },
      { title: 'Lifting state', sections: [sec('', 'text', { text: 'Move shared data to the parent.' })] },
    ],
    reviewQuestions: [],
  }
  // Titles come from the SOURCE task, so the source must list these subtopics.
  const sparseTask = { number: 3, title: 'Understand Context API', subtopics: [{ title: 'Prop drilling', children: [] }, { title: 'Lifting state', children: [] }] }
  const tree = buildTaskTree(normaliseTask(sparse, sparseTask))
  const subs = subtopicsOf(tree)
  assert.deepEqual(subs.map((b) => b.heading_2.rich_text[0].text.content), ['a. Prop drilling', 'b. Lifting state'])
  assert.deepEqual(h3sOf(subs[0]), ['What is it?'], 'the empty list section was dropped')
  assert.deepEqual(h3sOf(subs[1]), ['Notes'], 'a headingless section gets a plain default heading')
  assert.ok(!tree.heading_1.children.some((b) => b.type === 'toggle'), 'no questions toggle when there are none')
})

test('a topic with no usable sections is rejected rather than rendered as an empty toggle', () => {
  const notes = normaliseTask({ topics: [{ title: 'useContext', sections: [sec('x', 'text', { text: 'y' })] }, { title: 'ghost', sections: [] }] }, task)
  assert.equal(notes.topics.length, 1)
})

test('the kind is inferred from the content when the label is missing or wrong', () => {
  assert.equal(normaliseSection({ heading: 'h', kind: 'text', code: 'x()' }).kind, 'code')
  assert.equal(normaliseSection({ heading: 'h', items: ['a', 'b'] }).kind, 'list')
  assert.equal(normaliseSection({ heading: 'h', kind: 'table', tableHeaders: ['a'] }), null, 'a table with no rows is nothing')
  assert.equal(normaliseSection({ heading: 'h', kind: 'nonsense', text: 'hi' }).kind, 'text')
})

// --- the legacy contract still renders --------------------------------------------------

test('an old flat-field response still becomes a proper tree', () => {
  const legacy = { topics: [{ title: 'useContext', whatIsIt: 'A hook.', codeExample: 'useContext(C)', codeLanguage: 'jsx', commonMistakes: ['Inline objects'] }] }
  const [sub] = subtopicsOf(buildTaskTree(normaliseTask(legacy, task)))
  assert.deepEqual(h3sOf(sub), ['What is it?', 'Simple example', 'Common mistakes'])
})

// --- the prompt and the builder agree ---------------------------------------------------

test('the prompt names exactly the section kinds the builder renders, and tells the model to stop', () => {
  for (const kind of SECTION_KINDS) assert.ok(CORE_RULES.includes(`"${kind}"`), kind)
  assert.match(CORE_RULES, /Include ONLY what is needed/)
  assert.match(CORE_RULES, /Then stop/)
  assert.ok(!/Produce every field/.test(CORE_RULES), 'the old "fill everything" rule must be gone')
})

// --- the cleaners --------------------------------------------------------------------------

test('content cleaners remove markup and keep words', () => {
  assert.equal(cleanProse('### How does it work?\nProvider → consumer.'), 'Provider → consumer.')
  assert.equal(cleanProse('**Remember:** dispatch → reducer'), 'dispatch → reducer')
  assert.equal(cleanProse('Plain text with **bold** and `code` stays'), 'Plain text with **bold** and `code` stays')
  assert.deepEqual(cleanList('- a\n- b\n\n* c'), ['a', 'b', 'c'])
  assert.deepEqual(cleanList(['1. a', '2) b', '• c', '']), ['a', 'b', 'c'])
  assert.deepEqual(cleanCode('```jsx\nconst x = 1\n```'), { code: 'const x = 1', language: 'jsx' })
  assert.deepEqual(stripFences('no fence'), { code: 'no fence', language: '' })
  assert.equal(cleanHeading('## **What is useContext?**:'), 'What is useContext?')
  assert.equal(cleanHeading('Real-world example\nmore text'), 'Real-world example')
})
