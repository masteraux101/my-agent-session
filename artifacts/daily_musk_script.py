import urllib.request, json, os, sys
from datetime import datetime, timezone

# 配置
API_KEY = os.environ["GEMINI_API_KEY"]
MODEL   = "gemini-3-flash-preview"

# 构建 Prompt
PROMPT = f"""
今天是 {datetime.now(timezone.utc).strftime('%Y-%m-%d')}。
请总结埃隆·马斯克（Elon Musk）在过去 24 小时内最核心的 X 动态：
1. 分为地缘政治、AI（Grok/xAI）、SpaceX/Tesla 三个板块。
2. 提炼他最具争议的原话并翻译。
3. 简述这些动态对相关行业或市场的潜在影响。
4. 语言：中文。风格：干练、专业、不带废话。
"""

url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"
body = json.dumps({"contents": [{"parts": [{"text": PROMPT}]}]}).encode()
req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})

try:
    with urllib.request.urlopen(req) as resp:
        data = json.load(resp)
    summary = data["candidates"][0]["content"]["parts"][0]["text"]
    print(summary)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)