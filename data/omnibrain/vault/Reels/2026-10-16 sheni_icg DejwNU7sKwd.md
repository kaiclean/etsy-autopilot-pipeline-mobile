---
url: "https://www.instagram.com/reel/DejwNU7sKwd/"
shortcode: "DejwNU7sKwd"
author: "Sheni Salami | AI & Ops"
author_handle: "sheni_icg"
saved_collection: "Sent by Kai"
date_posted: 2026-10-16
date_processed: 2026-10-18
language: en
duration: 156.4
media_type: video
tags: [reel, topic/claude-code, topic/multi-agent, topic/agent-ops, topic/token-costs]
status: summarized
---
# Comment “Superset” for the setup guide

## Caption
Comment “Superset” for the setup guide

## Transcript
> Raw: [[Archive/DejwNU7sKwd.transcript.txt]] · Metadata: [[Archive/DejwNU7sKwd.info.json]] · Language: en (p=0.998)

things you can do to be better than 99% of people with ClaDE code. Skip number 8 and you'll burn all the money you have. Use an ADE, an ADE stands for an agent development and you'll also give them the ability to create their own employees. Only talk to one agent, make it so that the other agents send this agent the right information so that you can answer questions that they may have. Create an agent team skill. This skill controls the starting and stopping rules and also shows exactly how many agents are The skill has an agent team protocol which describes who talks to who, the messages that need to arrive, how to manage handoffs, the scope, and how to check the work. Make sure every window opens in the same mode, for example, bypass permissions or auto mode. If one of the agents is in a different mode it actually blocks some of the messages and they actually don't go through. Make every single agent team member maintain a document called handoff.md. This holds what's done, what's in progress, what needs to be done next and all the other Auto Compact is a slash command that sets how full the context needs to be before it will auto summarize and then clean the context window. Before I turned it on, it was spending about a billion tokens on reads per day, it literally got cut in half. Because of this, I was able to stretch out my usage by about 2, before it was vacuuming my usage and I, and I ran out of usage within about three or four days. Now it's stretching out the entire week with no problems. When you want your agents to run overnight, tell it to front load you with a bunch of questions and then say, I'm going to bed. Keep all of the decisions that you make overnight inside of a document called decisions.md. Claude is very placative and tends to make decisions by itself, but if you give it a scratch pad of things to note down as it goes, it will then tell you what it did whilst you were gone. Wake up to a document with all the information on all the things that it's done and all of the feedback comes back to you and you can decide if the thing that it did was dumb or not. Nothing better than when an agent stops asking you dumb ass questions. Try these out, build your agent team, let me know how it goes.

## Summary
- A list of Claude Code multi-agent tips. The caption plugs 'Superset' as the agent development environment (ADE) and offers a setup guide for commenting 'Superset'.
- Talk to only one lead agent; the other agents report to it. An 'agent team' skill defines start/stop rules, the team size and a protocol (who talks to whom, handoffs, scope, how work is checked).
- Run every agent window in the same permission mode (e.g. bypass/auto), because mixed modes block messages between agents. Each agent keeps a handoff.md (done / in progress / next).
- Tune Auto Compact (how full the context gets before it auto-summarises). The creator says this halved daily read tokens (~1B/day) and made a weekly usage limit last the whole week instead of 3-4 days.
- Overnight runs: have the agent ask all its questions up front, then log every autonomous choice in decisions.md so you can review it in the morning.

## Key takeaways
- One orchestrator plus a written team protocol beats many agents all chatting with you.
- File-based memory (handoff.md, decisions.md) makes long or overnight agent runs resumable and auditable.
- Context compaction settings are a major cost lever for token-heavy agent work.
- Front-loading questions removes blocking interruptions during unattended runs.

## Product/feature ideas
- [[Agent Team Protocol for OmniGram and OmniShop]]: adopt handoff.md / decisions.md / orchestrator rules in Kai's own agent setup
- [[Approval-Gated AI Marketing Team]]: decisions.md works as the morning approval queue
- [[Indie Founder Free Stack Cheat Sheet]]: evaluate Superset (ADE) and the Auto Compact settings

## Relevance to Designed by Kai
- High (operational): Kai already runs several agents (OmniGram, OmniShop, Etsy automations). This is a concrete playbook to make them coordinate, keep costs down and run overnight with an audit trail.
- No direct Etsy product, but it lowers the cost and raises the reliability of every automation behind Designed by Kai.
