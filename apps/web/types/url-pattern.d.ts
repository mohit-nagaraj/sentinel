// Next 16.3.3 references the current URLPattern web-platform types before the
// TypeScript 5.9 DOM library ships them. Remove this shim when lib.dom includes
// URLPatternInput and URLPatternOptions.
interface URLPatternInit {
  baseURL?: string
  hash?: string
  hostname?: string
  password?: string
  pathname?: string
  port?: string
  protocol?: string
  search?: string
  username?: string
}

interface URLPatternOptions {
  ignoreCase?: boolean
}

type URLPatternInput = string | URLPatternInit

interface URLPattern {
  readonly pathname: string
}
