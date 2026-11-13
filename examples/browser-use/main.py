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
import sys

from browser_use import Agent, Browser, Tools
from playwright.async_api import async_playwright

from unstuck import Unstuck

CDP_URL = os.environ.get("CDP_URL", "http://127.0.0.1:9222")
START_URL = sys.argv[1] if len(sys.argv) > 1 else "https://www.google.com/recaptcha/api2/demo"
tools = Tools()


# region snippet
@tools.action(
    "Ask a human to take over the browser: for a CAPTCHA, a login, a 2FA code or anything you can't do. "
    "Give the reason and the URL of the page you're stuck on."
)
async def ask_human(reason: str, url: str) -> str:
    async with async_playwright() as p:
        # The same Chrome browser-use is driving; take over the tab the agent is stuck on.
        browser = await p.chromium.connect_over_cdp(CDP_URL)
        tabs = [pg for ctx in browser.contexts for pg in ctx.pages if pg.url.startswith(("http://", "https://"))]
        matching = [pg for pg in tabs if pg.url.startswith(url) or url.startswith(pg.url)]
        if not matching:
            return f"No open tab is on {url}; check the URL and ask again."
        page = matching[-1]
        print("Taking over", page.url, flush=True)

        def on_link(link):
            print(f"\n{link.reason}. Open this link:\n{link.url}\n", flush=True)

        async with Unstuck(on_link=on_link) as unstuck:
            result = await unstuck.takeover(page, reason=reason, timeout_s=600)
    print(f"Takeover {result.status} after {result.duration_s}s", flush=True)
    return f"The human finished: {result.status}. Look at the page again before continuing."
# endregion snippet


async def main() -> None:
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")):
        print("There is no model key, so the agent is skipped and we ask for help directly.", flush=True)
        await ask_human("Please solve the CAPTCHA", START_URL)
        return
    llm = "anthropic:claude-sonnet-5-5" if os.environ.get("ANTHROPIC_API_KEY") else "openai:gpt-5"
    agent = Agent(
        task=f"Open {START_URL} and submit the form. Ask a human for any CAPTCHA.",
        llm=llm,
        browser=Browser(cdp_url=CDP_URL),
        tools=tools,
    )
    await agent.run()


if __name__ == "__main__":
    asyncio.run(main())
