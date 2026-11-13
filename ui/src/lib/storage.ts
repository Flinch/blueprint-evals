// localStorage can be missing, blocked or throw (private windows, cleared site
// data). Every access is wrapped, and the app works without it.

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Not remembered. Nothing else depends on it.
  }
}
