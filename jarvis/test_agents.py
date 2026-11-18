import json
import os
import unittest
import urllib.error
from unittest.mock import patch

from jarvis.agents import compile_agents
from jarvis.tools import AgentError, chat, latest_news

CATALOG = {"pages": {"sales": "Sales"}, "metrics": {"dials": "Dials"}}
MODULE = {"page": "sales", "type": "metric", "title": "Dials", "metric": "dials"}


class GraphTests(unittest.TestCase):
    def run_role(self, graph, role, context):
        return graph.invoke({"role": role, "prompt": "Review this request", "context": context},
                            {"recursion_limit": 6})["result"]

    def test_build_then_independent_qc(self):
        for approved in (True, False):
            with self.subTest(approved=approved):
                calls = []

                def model(instructions, context, as_json=False):
                    calls.append((instructions, context))
                    self.assertTrue(as_json)
                    if len(calls) == 1:
                        return {"summary": "Add a dialing KPI", "modules": [MODULE]}
                    return {"approved": approved, "findings": "Review complete."}

                result = self.run_role(compile_agents(model), "build", {"catalog": CATALOG})
                self.assertEqual(result["trace"], ["build", "qc"])
                self.assertIn("independent QC", calls[1][0])
                self.assertEqual(calls[1][1]["modules"], [MODULE])
                self.assertEqual(result["approved"], approved)
                self.assertEqual("modules" in result, approved)
                if approved:
                    self.assertEqual(result["modules"][0]["metric"], "dials")
                    self.assertEqual(len(result["modules"][0]["id"]), 36)

    def test_build_schema_rejects_extra_fields(self):
        graph = compile_agents(lambda *_args, **_kwargs: {
            "summary": "Bad proposal", "modules": [{**MODULE, "code": "exec()"}],
        })
        with self.assertRaises(AgentError):
            self.run_role(graph, "build", {"catalog": CATALOG})

    def test_systems_market_and_standalone_qc(self):
        calls = []

        def model(instructions, context, as_json=False):
            calls.append(context)
            return {"approved": True, "findings": "Reviewed"} if as_json else "Evidence reviewed"

        story = {"title": "Housing update", "url": "https://www.census.gov/example",
                 "date": "2026-10-01", "source": "Census"}
        graph = compile_agents(model, lambda: ([story], ["An unavailable feed"]))
        report = {"current": {"dials": 20}, "previous": {"kpis": {"dials": 18}}}
        self.assertEqual(self.run_role(graph, "systems", report)["trace"], ["systems"])
        self.assertEqual(calls[-1]["report"], report)
        market = self.run_role(graph, "market", {})
        self.assertEqual(market["trace"], ["market"])
        self.assertEqual(market["sources"], [story])
        self.assertEqual(calls[-1]["sources"][0]["number"], 1)
        qc = self.run_role(graph, "qc", {"catalog": CATALOG, "modules": [MODULE]})
        self.assertEqual(qc["trace"], ["qc"])
        self.assertNotIn("modules", qc)

    def test_empty_market_feed_skips_model(self):
        def unused(*_args, **_kwargs):
            self.fail("Empty feed should not use model tokens")
        result = self.run_role(compile_agents(unused, lambda: ([], ["Feed"])), "market", {})
        self.assertEqual(result["sources"], [])
        self.assertEqual(result["unavailable"], ["Feed"])


class ConnectorTests(unittest.TestCase):
    def test_feed_deduplication_and_unsafe_link_rejection(self):
        feed = b"""<rss><channel>
            <item><title>Policy</title><link>https://www.federalreserve.gov/news</link></item>
            <item><title>Injected</title><link>https://other.example/news</link></item>
            </channel></rss>"""
        items, unavailable = latest_news(lambda *_args, **_kwargs: feed)
        self.assertEqual([item["title"] for item in items], ["Policy"])
        self.assertEqual(len(unavailable), 1)

    def test_ollama_json_and_groq_quota(self):
        with patch.dict(os.environ, {"LCP_JARVIS_PROVIDER": "ollama", "LCP_JARVIS_OLLAMA_MODEL": "qwen2.5:1.5b"}):
            with patch("jarvis.tools.read_url", return_value=json.dumps({"message": {"content": '{"approved":true}'}}).encode()) as read:
                self.assertEqual(chat("instructions", {}, as_json=True), {"approved": True})
                self.assertEqual(read.call_args.args[0], "http://127.0.0.1:11434/api/chat")
                self.assertEqual(read.call_args.kwargs["payload"]["format"], "json")
        with patch.dict(os.environ, {"LCP_JARVIS_PROVIDER": "groq", "LCP_JARVIS_GROQ_KEY": "test-only"}):
            with patch("jarvis.tools.read_url", side_effect=urllib.error.HTTPError("", 429, "", {}, None)) as read:
                with self.assertRaises(AgentError) as error:
                    chat("instructions", {})
                self.assertEqual(error.exception.status, 429)
                self.assertEqual(read.call_args.kwargs["payload"]["model"], "openai/gpt-oss-20b")
