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

`result.status` is `resolved`, `timed_out`, `cancelled` (the human tapped "Can't solve") or `failed` (for example the page closed). `takeover()` raises `UnstuckEngineError` when the engine binary can't run, and `ValueError` for misuse. Inconsistent options raise `UnstuckConfigError`, a `ValueError` subclass (the TypeScript SDK's error of the same name): `alerts="required"` without Unstuck Cloud, or a `relay` that isn't `wss://` (`ws://` only to localhost, from `Unstuck(...)`).

The engine comes in the wheel for your platform (macOS 13+ on Apple silicon or Intel, Linux with glibc 2.17+, Windows x64). To use another binary, set `UNSTUCK_ENGINE_PATH` or `Unstuck(engine_path=...)`.

Send the link through Unstuck Cloud, so it opens on any phone, by setting `UNSTUCK_API_KEY=uk_live_...`. With Cloud, `takeover(..., alerts=False)` skips the phone alert for one takeover, and `alerts="required"` ends the takeover at once as `failed` with detail `alert_failed` if Unstuck Cloud can't accept the link for at least one paired phone. Tutorials: https://unstuck.sh/docs

License: Apache-2.0, including the bundled engine.
