/** Something the user can fix on the command line or in their files. The CLI exits 2 on it, the server answers 4xx. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}
