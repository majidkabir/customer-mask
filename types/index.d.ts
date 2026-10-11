export type VaultEntry = {
  token: string
  value: string
  label: string
  /** The customer's hint, on its first spelling's entry only. */
  hint?: string
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
