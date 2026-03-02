#!/usr/bin/env python3
"""AI Prompt Scheduler: musk-daily-digest"""
import urllib.request, json, os, sys
from datetime import datetime, timezone

API_KEY = os.environ["GEMINI_API_KEY"]
MODEL   = "gemini-3-flash-preview"

PROMPT_TEMPLATE = """
你是位资深科技与市场分析师。今天是 {date}。
请整理并总结埃隆·马斯克（Elon Musk）在过去 24 小时内于 X（原 Twitter）上的主要动态。

要求：
1. 核心主题：涵盖地缘政治、SpaceX/Tesla 进展、AI/Grok 动态或 X 平台政策。
2. 言论精选：摘录并翻译他最具代表性或争议性的原话。
3. 影响分析：简要评估这些言论对相关公司股价或行业趋势的潜在影响。
4. 格式：使用清晰的 Markdown 标题和列表。
5. 语言：中文，风格专业且干练。
"""

PROMPT = PROMPT_TEMPLATE.replace("{date}", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
url  = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"
body = json.dumps({"contents": [{"parts": [{"text": PROMPT}]}]}).encode()
req  = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})

try:
    with urllib.request.urlopen(req) as resp:
        data = json.load(resp)
    result = data["candidates"][0]["content"]["parts"][0]["text"]
    print(result)
except urllib.error.HTTPError as e:
    print(f"API error {e.code}: {e.read().decode()}", file=sys.stderr)
    sys.exit(1)