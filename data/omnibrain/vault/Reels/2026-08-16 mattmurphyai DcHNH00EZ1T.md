---
url: "https://www.instagram.com/p/DcHNH00EZ1T/"
shortcode: "DcHNH00EZ1T"
author: "Matt Murphy"
author_handle: "mattmurphyai"
saved_collection: "All posts"
date_posted: 2026-08-16
date_processed: 2026-10-19
language: en
duration: 137.2
media_type: video
tags: [reel, ig/aidirectedengineering, ig/cloudflare, ig/production, ig/vibecoding, ig/waf]
status: transcribed
---
# You put Cloudflare in front of your app

## Caption
You put Cloudflare in front of your app. 

An attacker found your server's real IP and went around it. 

All your WAF rules, DDoS protection, bot filtering bypassed entirely. Your origin IP is leaking through DNS history, email headers, and misconfigured subdomains. 

Cloudflare is not a switch you flip. It is an architecture you configure.

-MM

#vibecoding #aidirectedengineering #cloudflare #waf #production

## Transcript
> Raw: [[Archive/DcHNH00EZ1T.transcript.txt]] · Metadata: [[Archive/DcHNH00EZ1T.info.json]] · Language: en (p=1.0)

You put Cloudflare in front of your app, but an attacker found your server's real IP and went right around it. All your WAF rules all your DDoS protection, your bot filtering, your rate limiting, all of it, bypassed completely because your origin server's IP address is discoverable and your attacker just hit it directly. Cloudflare only protects you if all traffic is flowing through it. The moment someone finds your real IP, they skip everything that you set up. Here is what your AI missed when it configured your Cloudflare.. Step one, your origin IP is leaking.. DNS history tools store every IP your domain has ever pointed to. If you added Cloudflare after your site was already live, your pre-clar IP is a public record. Your email headers are- exposing it Mis-configured subdomains will point straight to it. So direct your AI to check every subdomain, every MX, every outbound email header, and every DNS history service for your origin IP. If it's discoverable anywhere, your Cloudflare setup is a locked front door with a wide open garage door. That's not a win. Step two, your origin server your entire internet. It should only extends from Cloudflare's IP range. So direct your AI to configure your firewall to whitelist Cloudflare's published IP ranges and block everything else. If a request does not come through Cloudflare, it does not reach your server. Period. And number three cela, your SSL is probably set to flexible. That means traffic between your user and Cloudflare is encrypted, but traffic between Cloudflare and your server is not encrypted. So an attacker on the network between Cloudflare and your origin sees everything in plain text. So direct your AI to set SSL to full strict mode and install a Cloudflare origin certificate on your server. Encrypted end-to-end, no gaps. Cloudflare is not a switch that you flip. It is an architecture that you must configure. So direct your AI to configure it correctly before somebody walks right around it.

## Summary
- _(pending LLM pass)_

## Key takeaways
- _(pending LLM pass)_

## Product/feature ideas
- _(pending LLM pass)_

## Relevance to Designed by Kai
- _(pending LLM pass)_
