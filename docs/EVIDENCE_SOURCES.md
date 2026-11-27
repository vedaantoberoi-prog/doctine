# Medical evidence sources: how they are loaded, searched and credited

Doctine's assistant can quote trusted medical guidance and credit it under the answer. The store, the search and the
approval step exist (migration `20261130000000_knowledge.sql`). **No content is loaded yet.** Which publisher's text
Doctine may use is a licensing decision for the owner, and each source must be approved by a doctor before the
assistant uses it. Until then every answer says "Doctine has not attached medical sources", which is true.

## How it works

```
Markdown file (text as published + publisher, url, licence)        tools/knowledge-ingest.mjs
        │  checks: https url, a named licence, no text that tries to instruct an AI
        ▼
private.knowledge_sources (status: draft)  +  private.knowledge_chunks (passages ≤ 1,200 characters, full-text index)
        │  a doctor reads it; the founder approves it in the admin console (AI → Medical sources) with the doctor's name and date
        ▼
status: approved   ──►  /api/chat: knowledge_search() finds passages sharing the question's key words (everyday words
                         are expanded to the medical terms they may mean); at most 4 passages, at most 2 from one source
        ▼
the answer may cite only those passages (K1…); the app shows title, publisher and link under the answer
```

- **Only approved sources are searched.** Loading a source again (even the same version) sends it back to draft and
  clears the review, so changed text is always reviewed again.
- **Approval** needs the `ai.manage` permission (held by the founder only) and records the reviewing doctor's name and
  the review date in the source row. A source can be retired at any time; retired sources are never searched.
- **Emergencies skip retrieval** so urgent advice is not delayed.
- **Passages are reference text, not instructions**: the prompt says so, and the loader refuses text that tries to
  instruct an AI. This lowers the risk of prompt injection through a source; it does not remove it, which is one more
  reason every source is reviewed by a person first.
- **Nothing about people is stored here.** Sources are public guidance.

## Turning it on (staging first)

1. Apply `supabase/migrations/20261130000000_knowledge.sql` (staging; production only with the owner's approval).
2. Write each source as a Markdown file with front matter (see the header of `tools/knowledge-ingest.mjs`), copying
   the publisher's text exactly. Check it: `node tools/knowledge-ingest.mjs sources/`.
3. Load it as drafts, from a machine whose environment holds `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for that
   database: `node tools/knowledge-ingest.mjs sources/ --apply`. (Never paste the key into a chat or the app.)
4. A doctor reviews each draft. The founder approves it in the admin console with the doctor's name and date.
5. Set `KNOWLEDGE_PROVIDER=supabase` on the environment (and `KNOWLEDGE_ALLOWED_DOMAINS` to the publishers' domains if
   they are not in the default list: who.int, icmr.gov.in, mohfw.gov.in, nhs.uk, nih.gov, cdc.gov).
6. Run the medical evaluation again and compare it with the last run before relying on it.

## Choosing sources: licence notes (checked 27 Nov 2026; not legal advice)

| Publisher | What the publisher says | Fit for Doctine (a commercial app) |
|---|---|---|
| MedlinePlus (US National Library of Medicine) | Health topic summaries, medical test information and some other pages are US federal works, in the public domain; credit "Source: MedlinePlus, National Library of Medicine". The A.D.A.M. encyclopedia, drug and supplement monographs are copyrighted and may not be loaded into a health IT system without a licence from their owners. | Good for the public-domain pages only. US-centred: a doctor should check what needs Indian context (brands, units, services). |
| CDC (US) | Most pages are US federal works; check each page for third-party material. | As above. |
| NHS website (UK) | Most content can be reused under the NHS website's standard terms; some sub-sites, images and videos are excluded, and API/widget use has syndication terms. | Possible; read the standard terms and confirm use outside the UK and in an AI product with the NHS website team before loading. |
| WHO | Publications are generally CC BY-NC-SA 3.0 IGO: **non-commercial**; commercial use needs WHO's permission (online permissions form). | Only with written permission from WHO. |
| Government of India (MoHFW, ICMR, National Health Portal) | Each site has its own copyright policy; many gov.in sites allow free reproduction with acknowledgement, and datasets on data.gov.in use the Government Open Data Licence – India. | The most relevant for India; confirm each site's policy (in writing if unclear) before loading. |
| Clinical guidelines from professional bodies, textbooks, UpToDate and similar | Copyrighted. | Only under a licence. |

Recommended first step: a small, high-value set (for example the topics behind the evaluation's most common
questions: blood sugar, blood pressure, cholesterol, thyroid, fever, anaemia), from public-domain or licensed sources,
reviewed by the doctor who reviews the evaluation.

Sources for the notes above: [MedlinePlus copyright](https://medlineplus.gov/copyright.html),
[NHS content not licensed for re-use](https://www.nhs.uk/our-policies/terms-and-conditions/content-not-licensed-for-re-use/),
[NHS syndication](https://www.nhs.uk/contact-us/contacts-for-professionals/syndicate-nhs-content/),
[WHO copyright, licensing and permissions](https://www.who.int/copyright).
