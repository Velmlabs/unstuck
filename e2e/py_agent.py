"""Python agent for the relay e2e: drives the fake CAPTCHA page through a relay and prints JSON lines."""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

from unstuck import Unstuck


async def main(site: str, relay: str, key: str, engine: str) -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 720})
        await page.goto(site)
        async with Unstuck(engine_path=engine, relay=relay, agent_key=key, on_link=lambda l: print(json.dumps({"url": l.url}), flush=True)) as u:
            result = await u.takeover(page, reason="Solve the test CAPTCHA", timeout_s=60)
        print(json.dumps({"status": result.status, "clicks": await page.evaluate("window.clicks")}), flush=True)
        await browser.close()


asyncio.run(main(*sys.argv[1:5]))
