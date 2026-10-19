---
status: idea
type: software feature
effort: S
potential: high
source_reels: ["[[2026-10-16 sheni_icg DejwNU7sKwd]]", "[[2026-10-04 adilet.fndr DeEiGKKIKqB]]", "[[2026-10-06 nickvasilescu DeKlhD8SZs9]]"]
created: 2026-10-18
tags: [idea, software-feature]
---
# Agent Team Protocol for OmniGram and OmniShop

## Problem
Kai's agents (OmniGram reel pipeline, OmniShop growth, Etsy order/listing automations) run separately, each with its own context. Nobody keeps a shared record of what's done or what was decided while Kai was away, and long runs burn tokens.

## Concept
A lightweight team protocol in files. One lead agent is the only one that talks to Kai; each worker agent keeps `handoff.md` (done / in progress / next / blockers); unattended runs log every choice in `decisions.md`; one `TEAM.md` defines roles, who hands off to whom, scope limits, start/stop rules and how work is checked. Overnight jobs ask their questions up front, before Kai goes offline.

## How to build it for real
1. Create `/workspace/omnigram/agents/TEAM.md` with roles: Lead (Kai-facing), Archivist (process.py + summaries), Growth (OmniShop), Shop-Ops (Etsy orders/listings); define the inputs, outputs and handoff file for each.
2. Add `handoff.md` and `decisions.md` per role (mirrored into OmniBrain `Summaries/Agent Log/` so Kai can read them in Obsidian).
3. Change process.py and the LLM summary pass to append a run summary to the Archivist's handoff.md after each batch.
4. Overnight runs: a pre-run checklist where the agent posts all open questions in one message, then proceeds and logs choices to decisions.md.
5. Cost hygiene: summarise transcripts once into Archive (never re-read raw files), set a compaction/context policy, and track tokens per batch in the handoff file.
6. Morning digest: Lead merges all decisions.md entries into one approval list for Kai.

## Etsy fit
Indirect: more reliable, cheaper automation behind the shop; the morning decisions digest doubles as the approval gate for anything customer-facing.

## Next step
- [ ] Write TEAM.md + handoff.md for the Archivist role and apply it on the next batch of saved reels (lines 23+).

## Source reels
- [[2026-10-16 sheni_icg DejwNU7sKwd]]
- [[2026-10-04 adilet.fndr DeEiGKKIKqB]]
- [[2026-10-06 nickvasilescu DeKlhD8SZs9]]
