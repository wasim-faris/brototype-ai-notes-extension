import { useState } from 'react'
import { parseTaskListText } from '../../content/parse.js'
import { Panel, Callout } from '../../ui/components.jsx'

/**
 * Last-resort path: paste the task list as text. Same parser as automatic
 * detection, so nesting works identically.
 */
export default function ManualPaste({ onUse, onCancel }) {
  const [text, setText] = useState('')
  const tasks = text.trim() ? parseTaskListText(text) : []
  const subtopics = tasks.reduce((n, t) => n + t.subtopics.length, 0)

  return (
    <Panel title="Paste your tasks">
      <p className="small muted">
        Copy the task list from Brototype and paste it below. Keep the numbering
        (<code>1.</code>, <code>a.</code>) — that is how subtopics are detected.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'1. Understand Advanced React Hooks\na. useContext\nb. useReducer\n\n2. Understand Context API\na. Context fundamentals'}
      />
      {tasks.length > 0 && (
        <Callout kind="ok">
          Found {tasks.length} task{tasks.length === 1 ? '' : 's'} and {subtopics} subtopics.
        </Callout>
      )}
      {!tasks.length && text.trim() && (
        <Callout kind="warn" title="Nothing detected yet">
          Each task needs to start with a number, like <code>1.</code>, and each subtopic with a letter, like <code>a.</code>
        </Callout>
      )}
      <div className="row">
        <button onClick={onCancel}>Back</button>
        <button className="primary grow" disabled={!tasks.length} onClick={() => onUse(tasks)}>Use these tasks</button>
      </div>
    </Panel>
  )
}
