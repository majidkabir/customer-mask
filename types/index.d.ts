export type VaultEntry = {
  token: string
  value: string
  label: string
  /** The customer's hint, on its first spelling's entry only. */
  hint?: string
  /** `ner` when the NER model found the value rather than the list or a pattern. */
  source?: 'ner'
}

declare module 'claude-code' {
  interface PluginState {
    'customer-mask': {
      vault: VaultEntry[]
      /** This session's placeholder marker; '' for a session that began before markers. */
      marker: string | null
    }
  }
}
