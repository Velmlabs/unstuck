"""Unstuck + browser-use: give the agent an `ask_human` tool. When it hits a CAPTCHA, a login or a 2FA prompt,
it calls the tool; Unstuck sends a person a link to the same Chrome and returns once they're done.

    pip install -r requirements.txt
    # Chrome with a debugging port, shared by browser-use and Unstuck:
    google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.unstuck-chrome"
    ANTHROPIC_API_KEY=... python main.py

Add UNSTUCK_API_KEY=uk_live_... to your environment to send the link through Unstuck Cloud.
"""

import asyncio
import os

from browser_use import Agent, Browser, Tools
from playwright.async_api import async_playwright

from unstuck import Unstuck

CDP_URL = os.environ.get("CDP_URL", "http://127.0.0.1:9222")
tools = Tools()


# region snippet
@tools.action("Ask a human to take over the browser: for a CAPTCHA, a login, a 2FA code or anything you can't do. Say why.")
async def ask_human(reason: str) -> str:
    async with async_playwright() as p:
        # The same Chrome browser-use is driving; take over the tab it is on.
        browser = await p.chromium.connect_over_cdp(CDP_URL)
        page = [pg for ctx in browser.contexts for pg in ctx.pages if pg.url != "about:blank"][-1]

        def on_link(link):
            print(f"\n{link.reason}. Open this on any device:\n{link.url}\n", flush=True)

        async with Unstuck(on_link=on_link) as unstuck:
            result = await unstuck.takeover(page, reason=reason, timeout_s=600)
    print(f"Takeover {result.status} after {result.duration_s}s", flush=True)
    return f"The human finished: {result.status}. Look at the page again before continuing."
# endregion snippet


async def main() -> None:
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")):
        print("There is no model key, so the agent is skipped and we ask for help directly.", flush=True)
        await ask_human("Please solve the CAPTCHA")
        return
    llm = "anthropic:claude-sonnet-5-5" if os.environ.get("ANTHROPIC_API_KEY") else "openai:gpt-5"
    agent = Agent(
        task="Open https://www.google.com/recaptcha/api2/demo and submit the form. Ask a human for any CAPTCHA.",
        llm=llm,
        browser=Browser(cdp_url=CDP_URL),
        tools=tools,
    )
    await agent.run()


if __name__ == "__main__":
    asyncio.run(main())
