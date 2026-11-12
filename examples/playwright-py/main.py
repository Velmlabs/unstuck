"""Minimal Unstuck example in Python: an agent opens a page, asks a human to take over, then continues.

Run (from this folder):
    UNSTUCK_ENGINE_PATH=../../engine/dist/unstuck-engine uv run --project ../../sdk-py python main.py [url]
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

        def on_link(link):
            print(f"\n{link.reason}. Open this on any device:\n{link.url}\n", flush=True)

        async with Unstuck(on_link=on_link) as unstuck:
            # The agent is paused while this awaits; the human drives the real page.
            result = await unstuck.takeover(page, reason="Please solve the CAPTCHA", timeout_s=300)
        print(f"Takeover {result.status} after {result.duration_s}s", flush=True)
        if result.status == "resolved":
            print("Agent continues on", page.url, flush=True)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "https://www.google.com/recaptcha/api2/demo"))
