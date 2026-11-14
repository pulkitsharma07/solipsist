# Format 1

A page as the first public build writes it: a request waiting, <!-- gen:abc:sug --> one taken as a button, and a question in the margin.

The <!-- sel:def:btn "make it shorter" -->deadline is the end of the month<!-- /sel:def:btn --> for all teams.

<!-- solip-comments
"format": 1
"meta":
  "rev": 7
  "body_rev": 6
  "body_by": "server"
"comments":
  "c1":
    "id": "c1"
    "status": "open"
    "thinker": "review"
    "title": "Which month?"
    "anchor":
      "quote": "end of the month"
      "prefix": "deadline is the "
      "suffix": " for all"
    "created": "2026-11-11T10:00:00.000Z"
    "created_rev": 5
"agent":
  "on": false
  "model": "pi:openrouter/deepseek/deepseek-chat"
"tasks":
  "abc":
    "type": "gen"
    "created_by": "writer"
    "created": "2026-11-11T09:00:00.000Z"
    "acked": "2026-11-11T09:00:01.000Z"
    "finished": "2026-11-11T09:00:30.000Z"
    "status": "suggested"
    "mode": "at"
    "place": "inline"
    "suggestion": "the \u003cb\u003ethirtieth\u003c/b\u003e"
    "note": "A date."
    "agent":
      "engine": "pi"
      "model": "openrouter/deepseek/deepseek-chat"
      "session": "s-1"
  "def":
    "type": "sel"
    "created_by": "writer"
    "created": "2026-11-11T09:10:00.000Z"
    "status": "button"
    "mode": "replace"
    "place": "inline"
    "suggestion": "deadline is the 30th"
    "saw": "deadline is the end of the month"
    "button":
      "at": "2026-11-11T09:20:00.000Z"
      "every": 86400000
      "from": "2026-11-11T09:20:00.000Z"
-->
