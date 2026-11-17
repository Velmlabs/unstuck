"""Unstuck Browser + browser-use: UnstuckTools gives the agent check_page and ask_human. After each navigation the
model calls check_page; a CAPTCHA or "verify you are human" check there brings a person in, and the model carries on.

    pip install -r requirements.txt
    # Chrome with a debugging port, shared by browser-use and Unstuck:
    google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.unstuck-chrome"
    ANTHROPIC_API_KEY=... python unstuck_tools.py [url]

Without a model key it checks the page once itself, which shows what the model's call does.
"""

import asyncio
import os
import sys

from unstuck import Unstuck
from unstuck.browser_use import UNSTUCK_SYSTEM_MESSAGE, UnstuckTools

CDP_URL = os.environ.get("CDP_URL", "http://127.0.0.1:9222")
START_URL = sys.argv[1] if len(sys.argv) > 1 else "https://www.google.com/recaptcha/api2/demo"


def on_link(link):
    print(f"\n{link.reason}. Open this link:\n{link.url}\n", flush=True)


async def main() -> None:
    # region snippet
    unstuck = Unstuck(on_link=on_link)
    tools = UnstuckTools(CDP_URL, unstuck=unstuck, remember=True)
    if os.environ.get("ANTHROPIC_API_KEY"):
        from browser_use import Agent, Browser

        agent = Agent(
            task=f"Open {START_URL} and tell me the page's main heading.",
            llm="anthropic:claude-sonnet-5-5",
            browser=Browser(cdp_url=CDP_URL),
            tools=tools,
            extend_system_message=UNSTUCK_SYSTEM_MESSAGE,
        )
        await agent.run()
    # endregion snippet
    else:
        # What the model's check_page call does, run once by hand on a tab already at START_URL.
        from playwright.async_api import async_playwright

        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(CDP_URL)
            page = browser.contexts[0].pages[0] if browser.contexts and browser.contexts[0].pages else await browser.new_page()
            await page.goto(START_URL)
            answer = await next(f for f in tools.functions if f.name == "check_page").function(url=START_URL)
            print(answer, flush=True)
            print(f"Takeover {'resolved' if answer.startswith('A person solved') else 'none'}", flush=True)
    await tools.aclose()
    await unstuck.close()


if __name__ == "__main__":
    asyncio.run(main())
