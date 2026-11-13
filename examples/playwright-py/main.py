"""Unstuck + Playwright for Python: an agent opens a page, asks a human to take over, then carries on.

    pip install -r requirements.txt
    python main.py [url]

Add UNSTUCK_API_KEY=uk_live_... to your environment to send the link through Unstuck Cloud,
so it opens on any phone, from anywhere.
"""

import asyncio
import sys

from playwright.async_api import async_playwright

from unstuck import Unstuck


async def main(url: str) -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        await page.goto(url)

        # region snippet
        def on_link(link):
            print(f"\n{link.reason}. Open this on any device:\n{link.url}\n", flush=True)

        async with Unstuck(on_link=on_link) as unstuck:
            # The agent waits here while a person solves the page in the real browser.
            result = await unstuck.takeover(page, reason="Please solve the CAPTCHA", timeout_s=300)
        print(f"Takeover {result.status} after {result.duration_s}s", flush=True)
        if result.status == "resolved":
            ...  # carry on with the agent's work here
        # endregion snippet
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "https://www.google.com/recaptcha/api2/demo"))
