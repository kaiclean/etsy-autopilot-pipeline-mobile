# 🧠 OmniBrain — Home

Kai's saved-reels brain: every saved Instagram post → transcript → summary → buildable ideas for **Designed by Kai** (Etsy: digital downloads + POD, CHF) and the OmniShop account.

## Indexes
- [[Summaries/Reels Index|📼 All reels]]
- [[Summaries/Ideas Index|💡 All ideas]]
- [[Summaries/First-20|📊 Rollup: first 20 saved items]]

## Folders
- `Reels/` one note per saved post (status: transcribed → summarized)
- `Ideas/` one note per product/feature idea (status: idea → validating → building → shipped)
- `Summaries/` rollups and indexes
- `Archive/` raw transcripts + yt-dlp metadata JSON
- `_Templates/` Reel and Idea templates

## Pipeline status
- Reels waiting for LLM pass: notes with `status: transcribed`
- Pipeline: `/workspace/omnigram/process.py` (idempotent, resumable; failures → `failed.txt`)

```dataview
TABLE author, language, status FROM "Reels" SORT date_processed DESC
```

```dataview
TABLE type, potential, effort, status FROM "Ideas" SORT potential DESC
```
