"""Unstuck Browser + Playwright for Python: wrap the page once, and any CAPTCHA or "verify you are human" check a
navigation or click lands on brings a person in. The agent's own call returns once they're past it.

    pip install -r requirements.txt
    python -m playwright install chromium
    python main.py [url]

Add UNSTUCK_API_KEY=uk_live_... to your environment to send the link through Unstuck Cloud,
so it opens on any phone, from anywhere.
"""

import asyncio
import sys

from playwright.async_api import async_playwright

from unstuck import Unstuck, UnstuckRescueError


async def main(url: str) -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # region snippet
        def on_link(link):
            print(f"\n{link.reason}. Open this link:\n{link.url}\n", flush=True)

        async with Unstuck(on_link=on_link) as unstuck:
            page = unstuck.wrap(await browser.new_page(), remember=True)
            try:
                # A check on this page brings a person in; goto returns once they're past it.
                await page.goto(url)
                status = page.unstuck.last_rescue.status if page.unstuck.last_rescue else "not needed"
                print(f'Takeover {status}: now on "{await page.title()}"', flush=True)
                # ...carry on with the agent's work here.
            except UnstuckRescueError as e:
                print(f"Takeover {e.status}: {e}", flush=True)
        # endregion snippet

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "https://www.google.com/recaptcha/api2/demo"))
