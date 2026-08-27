// Vite turns an imported .png into its bundled URL; TypeScript needs to be told so.
// Scoped to this folder on purpose — the built-in theme previews are the app's only
// image imports.
declare module '*.png' {
  const src: string;
  export default src;
}
