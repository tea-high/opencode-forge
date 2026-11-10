Before doing anything, I want you to understand a problem I have with you when we work in this repo, because you are going to be the one who fixes it in your own instructions file.

The problem, in first person:

When we work in large repos, you tend to think out loud. You narrate what you are going to read, what you are going to inspect, which files you are going to touch, which methods, which endpoints, which internal IDs. You give me a huge amount of technical detail I did not ask for and that, honestly, I often do not understand — not only because of exhaustion, but because you talk to me as if you were reasoning for yourself instead of communicating with me. The result is that I get flooded with details, I lose the thread of what we were doing, and worse: the business context gets diluted. I forget which feature we were working on, why, what constraints we had agreed on, which user or flow is affected. You keep the technical trace; I am left without the map.

What I need from you is not to work less or explore less. It is to **change the register in which you communicate with me**: speak in terms of business and impact, and reserve technical detail for when I explicitly ask for it or when it is essential for me to make a decision.

Your task now:

1. Read the repo's current `AGENTS.md` (if it exists) and understand what instructions are already there, what language they are in, and what tone they use. Do not delete or contradict them without reason; integrate with them.
2. Reason briefly, to yourself, about which concrete rules follow from the problem I have described. Do not narrate that reasoning in your response.
3. Modify `AGENTS.md` (create it if it does not exist) by adding or adjusting a section on **communication style and preservation of business context**. That section must:
   - Explain the *why* of the problem in one or two sentences, so that any future instance of you reading the file understands the intent, not just the letter.
   - Explicitly prohibit narrating your internal process (no "I'm going to read...", "I'm going to inspect...", "now I'll call...").
   - Prohibit internal details by default (IDs, endpoints, method names, file paths, traces) unless I ask for them or they are strictly necessary for a decision.
   - Establish that, when explaining a change, you start with the business impact (which feature, which flow, which user) and only afterwards, if needed, give one concise technical sentence.
   - Establish that, if you lack business context to answer well, you ask me for it instead of assuming it or filling the gap with technical exploration.
   - Establish that, when closing a block of work or before a feature change, you give a brief business-level summary (goal, decisions made and why, next step) so I do not lose the thread.
4. Adapt the text to the language and tone of the existing `AGENTS.md`. If the repo is in English, write it in English; if it is in Spanish, in Spanish. It should look like a natural part of the file, not a graft.
5. Do not touch anything else in the repo. Only `AGENTS.md`.

When you are done, reply to me with:
- A 3–5 line summary, in business terms, of what you changed and why.
- The diff or the exact fragment you added.
- If you found any previous instruction in `AGENTS.md` that conflicts with this, tell me and explain how you resolved it.

And in your own response to this message, apply the style I am asking for starting now: without narrating what you are going to do, without dumping unnecessary technical details.
