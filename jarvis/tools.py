import json
import os
import ssl
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

import certifi


class AgentError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(
    NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=certifi.where()))
)
CENSUS = "U.S. Census Bureau housing indicators"
FEEDS = {
    "Federal Reserve monetary policy": "https://www.federalreserve.gov/feeds/press_monetary.xml",
    "Federal Reserve banking and consumer policy": "https://www.federalreserve.gov/feeds/press_bcreg.xml",
    CENSUS: "https://www.census.gov/economic-indicators/indicator.xml",
}


def read_url(url, *, timeout, headers=None, payload=None, limit=262144):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, headers=headers or {})
    with opener.open(request, timeout=timeout) as response:
        content = response.read(limit + 1)
        if len(content) > limit:
            raise ValueError("Response exceeds size limit")
        return content


def latest_news(read=read_url):
    items, unavailable = [], []
    for source, url in FEEDS.items():
        try:
            data = read(url, timeout=2.5, headers={
                "User-Agent": "LocalCareProps-JARVIS/1.0",
                "Accept": "application/rss+xml, application/xml, text/xml",
            })
            if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
                raise ValueError("XML declarations are unsupported")
            feed = ET.fromstring(data)
            entries = []
            for item in feed.findall("./channel/item"):
                title = (item.findtext("title") or "").strip()[:240]
                link = (item.findtext("link") or "").strip()
                date = (item.findtext("pubDate") or "").strip()[:50]
                parsed = urlparse(link)
                if source == CENSUS and not any(word in title.lower() for word in ("residential", "housing", "home")):
                    continue
                if title and parsed.scheme == "https" and parsed.netloc == urlparse(url).netloc:
                    entries.append({"title": title, "url": link, "date": date, "source": source})
                if len(entries) == 4:
                    break
            if not entries:
                raise ValueError("Feed returned no valid entries")
            items.extend(entries)
        except (OSError, ValueError, ET.ParseError):
            unavailable.append(source)
    unique = {item["url"]: item for item in items}
    return list(unique.values()), unavailable


def chat(instructions, context, as_json=False):
    provider = os.getenv("LCP_JARVIS_PROVIDER", "ollama")
    headers = {"Content-Type": "application/json"}
    messages = [
        {"role": "system", "content": instructions},
        {"role": "user", "content": json.dumps(context, ensure_ascii=False)},
    ]
    if provider == "ollama":
        model = os.getenv("LCP_JARVIS_OLLAMA_MODEL", "qwen2.5:1.5b")
        if model.endswith("-cloud") or model.endswith(":cloud"):
            raise AgentError("Choose a locally installed Ollama model.", 503)
        url = "http://127.0.0.1:11434/api/chat"
        payload = {"model": model, "messages": messages, "stream": False,
                   "options": {"temperature": 0, "num_predict": 1152}}
        if as_json:
            payload["format"] = "json"
        timeout = 35
    elif provider == "groq":
        key = os.getenv("LCP_JARVIS_GROQ_KEY")
        if not key:
            raise AgentError("Set LCP_JARVIS_GROQ_KEY from a Groq Free account.", 503)
        url = "https://api.groq.com/openai/v1/chat/completions"
        model = "openai/gpt-oss-20b"
        headers["Authorization"] = f"Bearer {key}"
        payload = {"model": model, "messages": messages, "temperature": 0,
                   "max_completion_tokens": 1152, "reasoning_effort": "low"}
        if as_json:
            payload["response_format"] = {"type": "json_object"}
        timeout = 9
    else:
        raise AgentError("Choose ollama or groq for LCP_JARVIS_PROVIDER.", 503)
    try:
        response = json.loads(read_url(url, timeout=timeout, headers=headers, payload=payload))
        message = response["message"] if provider == "ollama" else response["choices"][0]["message"]
        content = message["content"]
        if not isinstance(content, str) or not content.strip():
            raise ValueError("Empty output")
        return json.loads(content) if as_json else content.strip()[:5500]
    except urllib.error.HTTPError as error:
        error.close()
        if error.code == 429:
            raise AgentError("Model quota reached. Wait for the limit to reset or use local Ollama.", 429) from error
        if provider == "ollama" and error.code == 404:
            raise AgentError("The configured Ollama model is missing. Pull it locally and retry.", 503) from error
        raise AgentError(f"Model returned HTTP {error.code}.") from error
    except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
        raise AgentError(f"{provider} is unavailable or returned invalid output.") from error
