import os
import requests
import json
from datetime import datetime

def get_market_summary():
    """使用 Gemini API 生成美股财经总结"""
    api_key = os.getenv("GEMINI_API_KEY")
    model_name = "gemini-3-flash-preview"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
    
    prompt = {
        "contents": [{
            "parts": [{
                "text": "你是一个资深美股分析师。请总结过去24小时内推特和金融媒体上最受关注的美股财经大事。要求：1. 简要精炼；2. 列出核心事件（如大盘走势、重要财报、美联储动向或热门科技股）；3. 语言专业且中文。请直接输出总结内容。"
            }]
        }]
    }
    
    response = requests.post(url, json=prompt)
    if response.status_code == 200:
        return response.json()['candidates'][0]['content']['parts'][0]['text']
    else:
        return f"获取总结失败: {response.text}"

def send_email(content):
    """通过 Resend API 发送邮件"""
    resend_api_key = os.getenv("RESEND_API_KEY")
    notify_email = os.getenv("NOTIFY_EMAIL")
    
    url = "https://api.resend.com/emails"
    headers = {
        "Authorization": f"Bearer {resend_api_key}",
        "Content-Type": "application/json"
    }
    
    date_str = datetime.now().strftime("%Y-%m-%d")
    payload = {
        "from": "MarketBot <onboarding@resend.dev>",
        "to": [notify_email],
        "subject": f"📅 美股财经大事日报 ({date_str})",
        "html": f"<h2>美股财经每日精炼总结</h2><div style='line-height:1.6;'>{content.replace('\n', '<br>')}</div>"
    }
    
    resp = requests.post(url, headers=headers, json=payload)
    return resp.status_code

if __name__ == "__main__":
    summary = get_market_summary()
    status = send_email(summary)
    print(f"任务执行完成，邮件发送状态码: {status}")