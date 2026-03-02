import urllib.request, json, os, sys
from datetime import datetime, timezone

# 配置
API_KEY = os.environ["GEMINI_API_KEY"]
MODEL   = "gemini-3-flash-preview"

# 构建提示词
PROMPT = f"""
今天是 {datetime.now(timezone.utc).strftime('%Y-%m-%d')}。
请作为资深科技博主，深度总结埃隆·马斯克（Elon Musk）过去 24 小时在 X 上的核心动态：
1. 涵盖地缘政治、SpaceX/Tesla/xAI 的最新进展。
2. 摘录并翻译最具争议或代表性的原话。
3. 分析这些言论对市场的潜在影响。
4. 格式：专业 Markdown 报告，中文编写，干练直击重点。
"""

url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"
body = json.dumps({"contents": [{"parts": [{"text": PROMPT}]}]}).encode()
req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})

try:
    with urllib.request.urlopen(req) as resp:
        data = json.load(resp)
    result = data["candidates"][0]["content"]["parts"][0]["text"]
    print(result)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)