import pathlib

REPO = pathlib.Path(__file__).resolve().parents[2]
ENGINE = REPO / "engine" / "dist" / "unstuck-engine"
CASES = REPO / "protocol" / "cases" / "rpc.json"
FIXTURE_HTML = REPO / "e2e" / "fixtures" / "fake-captcha.html"
