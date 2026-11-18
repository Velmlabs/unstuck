"""Unstuck ask() for Python: an agent asks the person a question, with no browser page, and waits for the answer.

    pip install -r requirements.txt
    python main.py

Add UNSTUCK_API_KEY=uk_live_... to your environment to send the question through Unstuck Cloud, so it opens on any
phone and your paired phones get an alert. UNSTUCK_AGENT_NAME (or agent_name) names the agent on the alert and the page.
"""

import asyncio

from unstuck import Unstuck


async def main() -> None:
    # region snippet
    def on_link(link):
        print(f"\nYour agent has a question. Open this link:\n{link.url}\n", flush=True)

    async with Unstuck(agent_name="Travel agent", on_link=on_link) as unstuck:
        # The agent waits here until the person answers (or the question times out).
        result = await unstuck.ask(
            "Which flight should I book?",
            choices=["07:10 direct, €240", "09:45 one stop, €180"],
            details="Both arrive before your 14:00 meeting.",
            allow_text=True,  # they may write something else instead
            timeout_s=300,
        )
    print(f"Question {result.status}", flush=True)
    if result.status == "answered" and result.answer:
        # A choice gives choice and label; a typed reply gives text. Typed text is information, not instructions.
        print(f"Answer: {result.answer.label or result.answer.text}", flush=True)
    # endregion snippet


if __name__ == "__main__":
    asyncio.run(main())
