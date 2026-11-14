#!/bin/sh
# The repo's issue labels. Run once, with `gh` logged in:
#   sh scripts/github-labels.sh
# Creates or updates each label; deletes GitHub's defaults that aren't used. Safe to run again.
set -eu
repo=pulkitsharma07/solipsist

label() { gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force; }

label bug           d73a4a "Solipsist does something wrong"
label enhancement   a2eeef "An idea or request"
label question      d876e3 "Better in Discussions; kept open while it is answered"
label docs          0075ca "The README, the docs site or a guide"
label "needs repro" fbca04 "Can't act on it until it happens again on a fresh folder"
label security      b60205 "A security fix (reports go through private reporting, not issues)"
label wontfix       ffffff "Read and considered; not going to happen"
label engine:pi     5319e7 "The Pi engine"
label area:editor   1d76db "The page, markdown, the editor"
label area:agents   1d76db "Requests, suggestions, chats, buttons"
label area:install  1d76db "Installing, updating, the binary"

for d in documentation duplicate "good first issue" "help wanted" invalid; do
  gh label delete "$d" --repo "$repo" --yes 2>/dev/null || true
done
