# unstuck (Python)

```bash
pip install unstuck
```

Human takeover for AI browser agents. When your agent hits a CAPTCHA, a login wall or a 2FA prompt, `await unstuck.takeover(page, reason=...)` pauses it, gives a human a link to the live browser, and returns when they're done.

```python
from unstuck import Unstuck

async with Unstuck(on_link=lambda link: print(link.reason, link.url)) as unstuck:
    result = await unstuck.takeover(page, reason="Solve the CAPTCHA")  # Playwright async Page
if result.status != "resolved":
    raise RuntimeError(f"human takeover {result.status}")
```

`result.status` is `resolved`, `timed_out`, `cancelled` (the human tapped "Can't solve") or `failed` (for example the page closed). `takeover()` only raises `UnstuckEngineError` when the engine binary can't run.

The engine comes in the wheel for your platform (macOS 13+, Linux with glibc 2.17+, Windows x64). To use another binary, set `UNSTUCK_ENGINE_PATH` or `Unstuck(engine_path=...)`.

Send the link through Unstuck Cloud, so it opens on any phone, by setting `UNSTUCK_API_KEY=uk_live_...`. Tutorials: https://unstuck.sh/docs

License: Apache-2.0 for the Python code. The bundled engine also contains the Unstuck viewer, licensed AGPL-3.0-only; see NOTICE for the source offer.
