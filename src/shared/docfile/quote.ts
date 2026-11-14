import { IMAGE_CHAR, imagesIn } from "./anchor";
import { markdownToDoc } from "./markdown";
import { docText } from "./text";

export type QuoteProblem = "empty" | "crosses-cells" | "too-short";

const MIN_WORDS = 3;
const MIN_CHARS = 12;

/**
 * Turns a model's quote into document text. The model reads markdown, so it may quote syntax
 * (`**end** of Q3`, `` `deploy` ``, `- item`); running it through the same parser strips that for free. To comment
 * on an image the model quotes it, `![alt](src)`, alone or with text around it: it becomes the image character,
 * and its src is kept to tell images apart. A quote still holding `|` is an attempt to span table cells.
 */
export function cleanQuote(raw: string): { quote: string; images?: string[] } | { problem: QuoteProblem } {
  const dt = docText(markdownToDoc(raw.trim()));
  const quote = dt.text.replace(/\s+/g, " ").trim();
  const images = imagesIn(dt, 0, dt.text.length);
  if (!quote) return { problem: "empty" };
  if (quote.includes("|")) return { problem: "crosses-cells" };
  // An image is specific enough on its own; text needs a few words.
  if (!quote.includes(IMAGE_CHAR) && (quote.split(" ").length < MIN_WORDS || quote.length < MIN_CHARS)) return { problem: "too-short" };
  return images.length ? { quote, images } : { quote };
}
