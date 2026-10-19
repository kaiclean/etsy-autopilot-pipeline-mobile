---
url: "https://www.instagram.com/p/DdtcLTODhrB/"
shortcode: "DdtcLTODhrB"
author: "Security News Today"
author_handle: "securitynewstoday"
saved_collection: "All posts"
date_posted: 2026-09-25
date_processed: 2026-10-17
language: en
duration: 169.0
media_type: video
tags: [reel, topic/security, topic/nfc, topic/apple-pay, topic/research, ig/cybersecurity, ig/datasecurity, ig/exploit, ig/mkbhd, ig/phonesecurity, ig/privacy, ig/techhacks, ig/technews]
status: summarized
---
# Tricking phones for transactions it's all about telling lies to the sy

## Caption
Tricking phones for transactions: it's all about telling lies to the system. We bypassed unlocking by pretending to be a transit terminal. Clever, right? #TechHacks #CyberSecurity #PhoneSecurity #Exploit #DataSecurity #Privacy #TechNews #MKBHD

## Transcript
> Raw: [[Archive/DdtcLTODhrB.transcript.txt]] · Metadata: [[Archive/DdtcLTODhrB.info.json]] · Language: en (1.0)

hard part is what you need to do to that data to trick the phone and the reader into authorizing the transaction see to actually steal money using this attack you have to get past three layers of defense on both systems and to do that we have to tell three buys two to the phone when you walk through they don't want a bunch of people lining up and having to unlock their face and you know maybe they're this is super-convenient but we can also We found out how this worked by going to London Underground with our laptops and our equipment and actually scanning the signals and seeing what the gate was saying to the phone and that's how we discovered this code Here's what that message would typically look like in binary code each of these bits carries important information about the transaction now the important part of this message for us is this bit and authentic transit transaction would have a one right here This tells the the phone that the reader may be offline like if it's underground on the subway in which case the phone send an extra layer of authentication So when marquez's phone receives the transaction request from what it thinks is a transit reader it's going to be expecting that value to be set to one but in reality the device sending the request is our retail reader As this communicates through our computer we're convincing the phone an It,

## Summary
- Security researchers (featured in an MKBHD video) show a contactless-payment attack: a retail reader pretends to be a transit gate (Express Transit mode).
- They sniffed London Underground gate traffic and found the flag bit that tells the phone the reader may be offline, which skips the unlock requirement.
- By spoofing that, a locked phone authorises a payment at a non-transit reader; three defence layers bypassed.

## Key takeaways
- Convenience features (Express Transit) widen attack surfaces.
- Security explainers with visual 'binary message' breakdowns are strong educational content.

## Product/feature ideas
- [[Retro Gaming Hacker POD Collection]]: NFC/hacker humour designs ('Tap to pay? Not today')

## Relevance to Designed by Kai
- Low: personal interest in security; possible hacker-humour designs.
