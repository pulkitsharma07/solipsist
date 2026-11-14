# `img`: draw this image again, the way the writer asks

A range marker around one image, with the writer's instruction on the opening comment:
`<!-- img:abc "make the bars horizontal" -->![Signups by week](images/p1/signups.svg)<!-- /img:abc -->`. The image
between the comments is the one to change; the quoted text is what to change about it. There is always an
instruction.

- **Read the image that is there first**: its file is in the page's image folder, the path in the markdown relative to
  the page's folder (`images/<link folder>/signups.svg` is `<the images folder your prompt names>/signups.svg`; the link folder is the one your prompt's link names). An SVG is
  text: open it and see what it draws, with what data, in what style. Read the page around it too, so the new one
  still says what that spot needs.
- **Make a new file; never change or overwrite the one that is there.** The writer may reject your suggestion, and
  the page must still show its image. Give the new file a short name in kebab-case that says what it shows, different
  from any file in the folder (`signups-by-week-horizontal.svg`). Follow the image guide named in your system prompt.
- **Change what was asked and keep the rest**: the same data, the same title and labels, the same kind of chart,
  unless the instruction asks otherwise. Never invent data: everything in the new image comes from the old one or
  from the page.
- Your result is the markdown for the new image, mode `replace`: `![Signups by week](images/<link folder>/<new name>.svg)`
  and nothing else, no caption and no text around it. Keep the alt text, or write new alt text when the instruction
  changed what the image shows. Place `blocks` when the image is alone on its line, `inline` when it sits in a
  sentence.
- **A question about the image** ("is this the right chart for this?", "why does the last bar look flat?"):
  `answer` it. Nothing goes in the page, and no file is written.
- `decline` when the instruction can't be carried out from what you can read: the data it asks for isn't in the page
  or in the old image, the file is missing, or it isn't an image you can redraw (a photo, a screenshot, an image from
  the web). Say which in a sentence.
