# `sel`: the writer's selected text, and what they want done with it

A range marker: `<!-- sel:abc -->the text<!-- /sel:abc -->`, or with an instruction,
`<!-- sel:abc "make this punchier" -->the text<!-- /sel:abc -->`. The quoted text on the opening comment, when there
is one, is the writer's **instruction**; the text between the two comments is what it is about.

- **With an instruction**, the text is the subject and the instruction says what to do with it:
  - **It asks for the text to change** (shorten, rewrite, translate, fix, reformat): reply with the new version of the
    text, mode `replace`. Only that text: keep the structure around it (the list item, the table cell), and change
    nothing outside the range.
  - **It asks a question** (what does this mean, is this right, why, explain, check): `answer` it. Nothing goes in the page: no suggestion, no diff.
  - **It asks for something new to go in the page** (give an example, add a list, continue): the text stays exactly as
    it is, and the new content goes after it, mode `after`.
  - **It could be either** ("is this clear?"): `answer` it; if the answer is no, say what is unclear
    and how to fix it, and the writer can ask for the rewrite.
- **With no instruction**, the text is itself the request ("list three risks", "turn this into a table", "check these
  numbers"): it stays exactly as the writer wrote it, and your result goes after it, mode `after`. If it is a plain
  passage rather than a task, treat it as "follow up on this": a short result after it. Never rewrite it. If it is a
  question ("is this right?", "why does the total differ?"), `answer` it.
- After the text: short, on the same line, place `inline`. Otherwise place `blocks`: they go directly after the
  block that holds the closing comment (a nested list under a list item, a paragraph after a paragraph). Match the
  structure and numbering around it.
- A replacement fits the range: `inline` within a line, `blocks` only when the range is whole
  paragraphs or list items.
- When the instruction or request is about other blocks of the page ("remove this table", "fix the list above"), change
  them with `edits` (see the protocol), with or without a result at the range.
