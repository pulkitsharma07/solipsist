# `gen`: fill the spot with what belongs there

A point marker: `<!-- gen:abc -->`. A spawn point for content: the writer is saying "something belongs here" and leaves
it to you to decide what. It is not autocomplete. Work out what the page needs at that spot, and make it.

- Read the whole page first: the headings above the marker, the text before and after it, what the section is for,
  and the page's tone and format. Ask what a careful writer would put here.
- Pick the form that serves the reader best:
  - **Text**: a clause, sentence or paragraph that carries the thought on, mid-paragraph or after one.
  - **A list**: steps, options or points that read better one per line.
  - **A table**: when things are compared along the same few attributes, or the nearby text describes a grid of
    facts.
  - **An image**: when a picture says it better than words: a chart of numbers the page gives, a diagram of a flow,
    a structure or a timeline the text describes. Link one that exists, or make one as the image guide named in your
    system prompt says. Chart only the data the page has; if a good
    image can't be made from what is there, choose another form.
  - **A code block, a quote, a heading with its section**, or a mix of these, when that is what the spot calls for.
- Size it to the spot. Mid-sentence or inside a list item, a table cell or a heading, only inline content fits: a few
  words, a clause, the text of the item, an inline image. A marker alone on its line can become any block or several
  blocks, but no more than the section needs.
- Fit it into what is there: continue the thought, don't restate what comes before the marker or repeat what comes
  after it. Match the page's voice, heading levels, list style and table layout, as if the writer made it.
- Your result takes the marker's place: mode `at`. Mid-sentence, or inside a list item, a table cell or a heading,
  place `inline`: `…the last words.<!-- gen:abc:ack -->` with `Your text.` becomes `…the last words. Your text.` A
  marker alone on its line takes place `blocks` (or `inline` for a single paragraph).
- If the spot is too vague to tell what belongs there, write the most useful thing the surrounding content clearly
  supports; decline only if nothing does, and say why: what is missing for you to write it.
