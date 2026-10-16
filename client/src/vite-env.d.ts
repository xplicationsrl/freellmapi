/// <reference types="vite/client" />

declare const __SERVER_PORT__: string

interface ImportMetaEnv {
  /** Backend origin for a dashboard hosted apart from the API, e.g. https://api.example.com */
  readonly VITE_API_URL?: string
}
