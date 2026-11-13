"""Unstuck + Selenium: Selenium drives Chrome; when it gets stuck, Unstuck takes over the same tab over CDP.

    pip install -r requirements.txt
    python main.py [url]

Add UNSTUCK_API_KEY=uk_live_... to your environment to send the link through Unstuck Cloud.
"""

import asyncio
import sys

from playwright.async_api import async_playwright
from selenium import webdriver

from unstuck import Unstuck

DEBUG_PORT = 9223


async def ask_a_human(driver: webdriver.Chrome, reason: str) -> str:
    # region snippet
    # Selenium's Chrome was started with --remote-debugging-port, so Playwright can attach to the same tab.
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(f"http://127.0.0.1:{DEBUG_PORT}")
        page = next(pg for ctx in browser.contexts for pg in ctx.pages if pg.url == driver.current_url)

        def on_link(link):
            print(f"\n{link.reason}. Open this on any device:\n{link.url}\n", flush=True)

        async with Unstuck(on_link=on_link) as unstuck:
            result = await unstuck.takeover(page, reason=reason, timeout_s=300)
        print(f"Takeover {result.status} after {result.duration_s}s", flush=True)
        return result.status
    # endregion snippet


def main(url: str) -> None:
    options = webdriver.ChromeOptions()
    options.add_argument(f"--remote-debugging-port={DEBUG_PORT}")
    driver = webdriver.Chrome(options=options)
    try:
        driver.get(url)
        # ...your Selenium steps, until a CAPTCHA or a login stops them:
        if asyncio.run(ask_a_human(driver, "Please solve the CAPTCHA")) == "resolved":
            print("Selenium carries on at", driver.current_url, flush=True)
    finally:
        driver.quit()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "https://www.google.com/recaptcha/api2/demo")
