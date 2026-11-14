/** A Markdown file imported as text (`import x from "./a.md" with { type: "text" }`): embedded in the build. */
declare module "*.md" {
  const text: string;
  export default text;
}
