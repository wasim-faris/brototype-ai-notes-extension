/**
 * One error type for the whole extension.
 *
 * Every failure carries a `code` (for the code to branch on) and a `message`
 * written for YOU, not for a developer. The rule in this project is: never
 * fail silently, and never show a raw stack trace in the popup.
 */
export class AppError extends Error {
  constructor(code, message, { retryable = false, cause = null, detail = null } = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.retryable = retryable
    this.detail = detail
    if (cause) this.cause = cause
  }

  /** Errors cross the service-worker -> popup boundary as plain JSON. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      detail: this.detail,
      // Whether the request actually reached the server, and where it went.
      // Without these, a local validation failure and a real HTTP failure are
      // indistinguishable in the UI - which once produced a self-contradictory
      // "no such model" message that also listed the model as available.
      sentRequest: this.sentRequest ?? false,
      requestUrl: this.requestUrl ?? null,
    }
  }

  static from(error) {
    if (error instanceof AppError) return error
    if (error?.code && error?.message) {
      const restored = new AppError(error.code, error.message, { retryable: error.retryable, detail: error.detail })
      restored.sentRequest = error.sentRequest ?? false
      restored.requestUrl = error.requestUrl ?? null
      return restored
    }

    const message = String(error?.message || error)
    // fetch() rejects with a bare TypeError when the network is unreachable.
    if (error instanceof TypeError || /failed to fetch|network/i.test(message)) {
      return new AppError('NETWORK', 'Could not reach the internet. Check your connection and try again.', { retryable: true, cause: error })
    }
    return new AppError('UNKNOWN', message, { cause: error })
  }
}

export const errors = {
  noTasks: () => new AppError('NO_TASKS',
    'No tasks were found on this page. Open your Brototype task page first, or use "Pick the task list manually".'),

  notionNotConnected: () => new AppError('NOTION_NOT_CONNECTED',
    'Notion is not connected yet. Open the Notion tab in the extension and press "Continue with Notion".'),

  notionReconnect: () => new AppError('NOTION_UNAUTHORIZED',
    'Your Notion connection has expired. Reconnect Notion to continue.'),

  notionNoParent: () => new AppError('NOTION_NO_PARENT',
    'No Notion parent page is chosen yet. Open the Notion tab in the extension and pick the page your weekly notes should live under.'),

  aiNotConfigured: () => new AppError('AI_NOT_CONFIGURED',
    'Connect your AI provider to generate study notes.'),
}
