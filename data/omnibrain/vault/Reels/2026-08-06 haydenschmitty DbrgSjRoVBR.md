---
url: "https://www.instagram.com/p/DbrgSjRoVBR/"
shortcode: "DbrgSjRoVBR"
author: "Hayden Smith | AI Builder"
author_handle: "haydenschmitty"
saved_collection: "All posts"
date_posted: 2026-08-06
date_processed: 2026-10-19
language: en
duration: 63.0
media_type: video
tags: [reel, ig/aicoding, ig/claudecode, ig/startuphacks, ig/vibecoder, ig/vibecoding]
status: transcribed
---
# 5 ways your vibecoded login endpoint isn’t secure

## Caption
5 ways your vibecoded login endpoint isn’t secure #claudecode #vibecoder #vibecoding #startuphacks #aicoding

## Transcript
> Raw: [[Archive/DbrgSjRoVBR.transcript.txt]] · Metadata: [[Archive/DbrgSjRoVBR.info.json]] · Language: en (p=0.998)

Claude Code just added a login screen to your VibeCoded app? Big moment, feels like the app's legit. But get this, that,. That new login page is the easiest thing in your entire application to hack. So here's five things that Claude probably probably forgot to do. Don't worry, don't worry, all of these are JENNIFER codeable changes you just needed to know to ask for. Your session token is stored in local storage. This leaves you wide open to what are called cross-site scripting attacks. Your admin check is happening on the client side and not the server side. You have yet to set up two-factor authentication or a one-time password flow. This means that anybody can sign up as anybody. You wouldn't think that this happens, but it does. Your login endpoint and your password reset endpoint are missing rate limiting. Anybody can brute force their way in if they have enough time. Number five, you don't have password rule set set up on your front end client side, nor do you have a password leak check. I'm not going to ask you to comment or anything so if you want to fix these issues, talk, here's what you need to do. Save the video, share it to Claude with the URL, say, hey, pull all the stuff from this video and implement it in my application. It's really simple as that, why does everybody make that so hard?

## Summary
- _(pending LLM pass)_

## Key takeaways
- _(pending LLM pass)_

## Product/feature ideas
- _(pending LLM pass)_

## Relevance to Designed by Kai
- _(pending LLM pass)_
