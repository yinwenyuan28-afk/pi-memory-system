# Pi Memory System — English Promo Video

**Tagline:** Make every conversation the starting point for your next task.

45 seconds · 1920 × 1080 · 16:9 · 30 fps · English narration · burned-in English subtitles · original synthesized music.

| Time | Visual | Narration |
|---|---|---|
| 00–05 s | Project context, a decision, and an unfinished task appear beside the opening question. | Returning to a project shouldn’t mean starting over. |
| 05–12 s | A conversation about an orders project becomes four reusable memory cards: fact, method, task, and deliverable. | Pi Memory System turns useful conversations into reusable project memories. |
| 12–18 s | Related memories gather into a project story: problem, decision, and next step. | Related memories come together as a project story, with the context behind them. |
| 18–27 s | The next day, a fresh session retrieves the sorting method and open task. Both appear in the answer context before Pi replies. | With semantic recall set up, Pi can find relevant context in a new session and help you pick up where you left off. |
| 27–34 s | In the viewer illustration, inspect and edit a memory, then mark the regression test done. | Review and correct your memories. Mark tasks open, done, or dropped. |
| 34–40 s | Review suggested profile changes, choose the ones to keep, and approve them. | Your long-term profile starts as a suggestion. You review and approve every change. |
| 40–45 s | Product mark, tagline, project link, and installation guide. | Make every conversation the starting point for your next task. |

All scenes are clearly labeled product illustrations using sample content. Semantic recall is shown with its setup conditions. Project stories are shown as an organizing step, not as information injected into every reply. The profile only updates after user approval. The end card identifies Windows as the supported platform.

## Files

- `pi-memory-system-promo-en.mp4` — finished English video.
- `poster-en.jpg` — video poster.
- `subtitles.en.srt` — separate English subtitle file.
- `storyboard.en.json` — English narration, timing, and copy.
- `render.py` — shared renderer; select the English storyboard with `PIMS_STORYBOARD=storyboard.en.json`.

```powershell
$env:PIMS_STORYBOARD = "storyboard.en.json"
python render.py --prepare-audio --preview --render
```
