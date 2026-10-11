export type VaultEntry = { token: string; value: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'customer-mask': { vault: VaultEntry[] }
  }
}
