import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSubtopics, parseTaskHeading, parseTaskListText } from '../src/content/parse.js'

// All fixtures below are copied verbatim from a real Brototype task page.

test('flat lettered subtopics (task 1)', () => {
  const result = parseSubtopics('a. useContext\nb. useReducer\nc. useMemo\nd. useCallback\ne. Custom Hooks')
  assert.equal(result.length, 5)
  assert.equal(result[0].title, 'useContext')
  assert.equal(result[4].title, 'Custom Hooks')
  assert.deepEqual(result[0].children, [])
})

test('roman numerals nest under their letter (task 12)', () => {
  const blob = [
    'a. Use AI For',
    ' i. Architecture reviews',
    ' ii. Component optimization suggestions',
    ' iii. State management discussions',
    ' iv. Authentication flow design',
    ' v. UI/UX improvement ideas',
    '',
    'b. Validate',
    ' i. Generated React code',
    ' ii. State management approaches',
    ' iii. Authentication implementations',
    ' iv. Performance recommendations',
    '',
    'c. Identify',
    ' i. Unnecessary complexity',
    ' ii. Performance bottlenecks',
    ' iii. Poor architectural decisions',
  ].join('\n')

  const result = parseSubtopics(blob)
  assert.equal(result.length, 3, 'three top-level subtopics')
  assert.deepEqual(result.map((r) => r.title), ['Use AI For', 'Validate', 'Identify'])
  assert.equal(result[0].children.length, 5)
  assert.equal(result[0].children[0].title, 'Architecture reviews')
  assert.equal(result[1].children.length, 4)
  assert.equal(result[2].children.length, 3)
})

test('"i." is the 9th LETTER when it continues an a-b-c run (task 13)', () => {
  const blob = [
    'a. Build a scalable React application structure',
    'b. Implement Context API for state management',
    'c. Integrate React application with Django REST APIs',
    'd. Build authentication and authorization workflows',
    'e. Implement protected routes',
    'f. Handle API loading and error states',
    'g. Optimize application performance',
    'h. Create reusable custom hooks',
    'i. Build production-ready frontend architecture',
    'j. Develop a complete frontend application connected to a Django backend',
  ].join('\n')

  const result = parseSubtopics(blob)
  assert.equal(result.length, 10, 'all ten stay top-level; none nest under "h"')
  assert.equal(result[8].title, 'Build production-ready frontend architecture')
  assert.equal(result[8].children.length, 0)
})

test('roman nesting still works without indentation', () => {
  const result = parseSubtopics('a. Use AI For\ni. Architecture reviews\nii. Component optimization\nb. Validate\ni. Generated React code')
  assert.deepEqual(result.map((r) => r.title), ['Use AI For', 'Validate'])
  assert.equal(result[0].children.length, 2)
  assert.equal(result[1].children.length, 1)
})

test('task headings', () => {
  assert.deepEqual(parseTaskHeading('1. Understand Advanced React Hooks'), {
    number: 1, title: 'Understand Advanced React Hooks',
  })
  assert.deepEqual(parseTaskHeading('10. Understand Error Handling & Resilience'), {
    number: 10, title: 'Understand Error Handling & Resilience',
  })
  assert.equal(parseTaskHeading('Learning Topics & Workspace'), null)
  assert.equal(parseTaskHeading('Sem 1'), null)
})

test('manual paste fallback parses a whole list', () => {
  const tasks = parseTaskListText([
    '1. Understand Advanced React Hooks',
    'a. useContext',
    'b. useReducer',
    '2. Thinking with AI',
    'a. Use AI For',
    '  i. Architecture reviews',
  ].join('\n'))

  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].subtopics.length, 2)
  assert.equal(tasks[1].subtopics[0].children[0].title, 'Architecture reviews')
})
