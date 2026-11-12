# unstuck (Python)

Human takeover for AI browser agents. When your agent hits a CAPTCHA, a login wall or a 2FA prompt, `await unstuck.takeover(page, reason=...)` pauses it, gives a human a link to the live browser, and returns when they're done.

```python
from unstuck import Unstuck

async with Unstuck(on_link=lambda link: print(link.reason, link.url)) as unstuck:
    result = await unstuck.takeover(page, reason="Solve the CAPTCHA")  # Playwright async Page
if result.status != "resolved":
    raise RuntimeError(f"human takeover {result.status}")
```

`result.status` is `resolved`, `timed_out`, `cancelled` (the human tapped "Can't solve") or `failed` (for example the page closed). `takeover()` only raises `UnstuckEngineError` when the engine binary can't run.

Until platform wheels ship, point the SDK at an engine binary with `UNSTUCK_ENGINE_PATH` or `Unstuck(engine_path=...)`.

License: Apache-2.0
