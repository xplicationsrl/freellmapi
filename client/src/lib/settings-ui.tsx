import { createContext, useContext } from 'react'

const SettingsUiContext = createContext<() => void>(() => {})

export function SettingsUiProvider({
  openSettings,
  children,
}: {
  openSettings: () => void
  children: React.ReactNode
}) {
  return (
    <SettingsUiContext.Provider value={openSettings}>
      {children}
    </SettingsUiContext.Provider>
  )
}

export function useOpenSettings() {
  return useContext(SettingsUiContext)
}
