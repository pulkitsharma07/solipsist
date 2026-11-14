# Edge cases: a page with a bit of everything

Plain paragraph with **bold**, *italic*, ***both***, `code`, ~~strike~~ and a [link](https://example.com/a?b=1&c=2 "title").
A soft line break follows this line, and then a hard break at the end of this one.  
The line after the hard break. Escaped: \*not italic\*, \# not a heading, 1\. not a list, a_b_c, 2 * 3 * 4.

Angle brackets and entities: 5 < 6 > 4, &amp; &lt;b&gt;, <b>not bold</b>, <div>raw html</div>, <https://auto.link>.

## Lists

1. 
   - A numbered item with no text of its own, then a nested bullet list
   - Second nested bullet
2. 
3. Item after an empty one
   1. Nested ordered
      - Three levels deep
        - Four levels deep, with `code` and **bold**
4. Item with two paragraphs

   The second paragraph of item four.

5. Item with a code block:

   ```js
   const x = [1, 2, 3].map((n) => n * 2);
   ```

- Bullet after an ordered list
- [ ] Task-looking item, open
- [x] Task-looking item, done
-
- Item after an empty bullet

7. Ordered list that starts at seven
8. Second

* Star bullet
+ Plus bullet
- Dash bullet

> * A quote with a list
> + and another right after it

## Quotes and rules

> A quote with **bold**.
>
> > A nested quote
> > on two lines.
>
> - A list inside a quote
> - Second item

---

***

## Code

```
A fence with no language
    keeps its indent
```

```python
def f():
    return "text with <!-- gen:abc --> inside code stays code"
```

~~~
A tilde fence
~~~

    An indented code block

Inline code with a backtick: `` a`b ``.

## Tables

| Team | Owner | Due |
| ---- | :---: | --: |
| Core | Ana   | Q3  |
| Docs | *Bo*  | `Q4` |
| Pipe \| inside | | empty cell left |

| One column |
| --- |
| only |

## Images and links

![A diagram](/api/assets/diagram.png "Diagram")

![](no-alt.png)

<!-- img:img "make the bars horizontal" -->![A chart](images/everything/chart.svg)<!-- /img:img -->

A request over text and a picture: <!-- sel:pic -->see ![A chart](images/everything/chart.svg) here<!-- /sel:pic -->.

[Empty link]() and [reference link][ref] and a bare www.example.com.

[ref]: https://example.com/ref

## Placeholders

A gen marker waiting <!-- gen:aaa --> in the middle of a sentence, one being worked on <!-- gen:bbb:ack -->, one with a suggestion waiting <!-- gen:sss:sug --> and one done <!-- gen:ccc:done -->.

<!-- gen:ddd -->

A task range: <!-- sel:eee -->rewrite this sentence<!-- /sel:eee --> and a done one: <!-- sel:fff:done -->like this<!-- /sel:fff:done -->, with **<!-- sel:ggg:ack -->bold inside<!-- /sel:ggg:ack -->**.

<!-- sel:hhh -->A range over the first paragraph.

And over a second one.<!-- /sel:hhh -->

1. <!-- sel:iii -->range in one list item<!-- /sel:iii -->
2. <!-- sel:iii -->and the same id in the next<!-- /sel:iii -->

With an instruction: <!-- sel:lll "make it &quot;punchier&quot; &amp; shorter &lt;now&gt; -&#45;>" -->the rollout went well<!-- /sel:lll -->, and acknowledged: <!-- sel:mmm:ack "is this right?" -->3 September<!-- /sel:mmm:ack -->.

<!-- sel:nnn "merge these two" -->One paragraph with an instruction.

And the next one, bare.<!-- /sel:nnn -->

Lookalikes that must stay text: <!-- gen:zz -->, <!-- gen:abc:later -->, <!-- sel:jjj --> never closed, <!-- /sel:kkk --> never opened, <!-- just a comment -->, <!-- gen:ooo "no instruction on a gen" -->, <!-- sel:ppp -->closing with one<!-- /sel:ppp "no" -->.

## Awkward text

Tabs	inside	a	line, trailing spaces below   
and non-breaking space between words, emoji 🧪✅, accents café naïve, CJK 日本語のテキスト, RTL مرحبا, a zero width joiner: a‍b.

A very long line without any break: word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word 

Line one of a block
line two of the same block
line three

\

Final paragraph with no newline at the end.