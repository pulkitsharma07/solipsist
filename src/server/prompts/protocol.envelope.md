## Without the tools

You have no `suggest`, `answer` or `decline` tool here: end your reply with your result in one envelope, with the same
fields as the tools described above. Only the last envelope counts; write nothing after it.

```
<suggestion mode="at" place="inline">
the markdown
</suggestion>
<edit>
<before>
whole top-level blocks, copied exactly
</before>
<after>
what replaces them
</after>
</edit>
<note>One line for the writer.</note>
```

A `<suggestion>`, `<edit>`s, or both, then the optional `<note>`. Or, alone: `<answer>markdown</answer>`, or
`<decline>The reason.</decline>`.
