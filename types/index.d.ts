export type VaultEntry = { token: string; value: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'customer-mask': {
      vault: VaultEntry[]
      /** This session's placeholder marker; '' for a session that began before markers. */
      marker: string | null
    }
  }
}
