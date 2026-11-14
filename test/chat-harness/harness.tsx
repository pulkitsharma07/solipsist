// The chat modal on its own, against the fake agent in `server.ts`: `bun test/chat-harness/server.ts`, then open the
// page. `?ph=` picks the conversation it opens on (`empty`, `long`, `busy`, `gone`); what you say picks the reply.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/app/app.css";
import { ChatModal } from "../../src/app/pages/ChatModal";

const task = new URLSearchParams(location.search).get("ph") ?? "empty";

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <main style={{ padding: 24 }}>
      <p>Chat harness on <b>{task}</b>. Say <code>tool</code>, <code>tools</code>, <code>long</code>, <code>think</code>, <code>error</code>, <code>slow</code>, <code>suggest</code>, <code>reply</code>, <code>bad</code>, <code>code</code>, <code>decline</code> or anything else.</p>
      {!open && <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Open the chat</button>}
      {/* A page long enough to scroll, as the sheet behind the real modal is: scrolling the chat must not move it. */}
      <div style={{ height: 3000 }} />
      {open && <ChatModal page="harness" chat={{ task: task, title: `Harness · ${task}` }} onClose={() => setOpen(false)} />}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
