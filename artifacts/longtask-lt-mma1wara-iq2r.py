#!/usr/bin/env python3
"""
BrowserAgent Long-Running Task: lt-mma1wara-iq2r
Auto-generated — do not edit manually.
"""
import json, os, sys, time, hashlib, base64, struct, urllib.request, urllib.error

# ── Config ──
TASK_ID       = os.environ.get("TASK_ID", "lt-mma1wara-iq2r")
ITERATION     = int(os.environ.get("ITERATION", "1"))
MAX_RUNTIME   = int(os.environ.get("MAX_RUNTIME_MINUTES", "340")) * 60
MODEL         = os.environ.get("MODEL", "gemini-3-flash-preview")
API_KEY       = os.environ["GEMINI_API_KEY"]
LONGTASK_KEY  = os.environ["LONGTASK_KEY"]
GITHUB_TOKEN  = os.environ.get("GITHUB_TOKEN", "")
REPO_FULL     = os.environ.get("REPO_FULL", "")
WORKFLOW_FILE = os.environ.get("WORKFLOW_FILE", "longtask-lt-mma1wara-iq2r.yml")
STATE_DIR     = "longtask_state"
STATE_FILE    = f"{STATE_DIR}/{TASK_ID}.enc"
START_TIME    = time.time()

TASK_PROMPT = """全网搜索： 查找 Qiskit, Cirq 和最新的 Q# 的 2026 年最新文档。\n\n代码实测： 为这三个框架各写一个‘贝尔态生成’的测试脚本。尝试在我本地运行（如果缺库，请自主尝试安装）。\n\n对比分析： 记录每个框架的运行报错率、文档易读性以及 GitHub 上的 Issue 活跃度。\n\n生成交付物： 将所有测试脚本、报错 Log 和你的分析心得整合成一个github仓库"""

# ── Crypto helpers (AES-256-GCM, same as BrowserAgent crypto.js) ──

def _derive_key(passphrase: str, salt: bytes) -> bytes:
    """PBKDF2-HMAC-SHA256 with 310000 iterations, 32-byte key."""
    import hashlib
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, 310000, dklen=32)

def encrypt_state(passphrase: str, plaintext: str) -> str:
    """Encrypt to base64 string: salt(16) + iv(12) + ciphertext+tag."""
    salt = os.urandom(16)
    iv   = os.urandom(12)
    key  = _derive_key(passphrase, salt)
    
    # Use AES-256-GCM via ctypes / subprocess openssl for portability
    # But simpler: use the cryptography package
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        aesgcm = AESGCM(key)
        ct = aesgcm.encrypt(iv, plaintext.encode(), None)
        raw = salt + iv + ct
        return base64.b64encode(raw).decode()
    except ImportError:
        # Fallback: use openssl CLI
        import subprocess, tempfile
        with tempfile.NamedTemporaryFile(delete=False, suffix='.bin') as f:
            f.write(plaintext.encode())
            tmpfile = f.name
        result = subprocess.run(
            ["openssl", "enc", "-aes-256-gcm", "-e", "-K", key.hex(), "-iv", iv.hex(),
             "-in", tmpfile, "-out", tmpfile + ".enc", "-nosalt"],
            capture_output=True
        )
        os.unlink(tmpfile)
        if result.returncode != 0:
            raise RuntimeError(f"openssl encrypt failed: {result.stderr.decode()}")
        with open(tmpfile + ".enc", "rb") as f:
            ct = f.read()
        os.unlink(tmpfile + ".enc")
        raw = salt + iv + ct
        return base64.b64encode(raw).decode()

def decrypt_state(passphrase: str, b64data: str) -> str:
    """Decrypt base64 string produced by encrypt_state or BrowserAgent Crypto."""
    raw = base64.b64decode(b64data)
    salt = raw[:16]
    iv   = raw[16:28]
    ct   = raw[28:]
    key  = _derive_key(passphrase, salt)
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(iv, ct, None)
        return plaintext.decode()
    except ImportError:
        raise RuntimeError("cryptography package required for decryption")

# ── GitHub API helpers ──
API_BASE = "https://api.github.com"

def gh_headers():
    return {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
    }

def gh_request(method, url, data=None):
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method, headers=gh_headers())
    try:
        with urllib.request.urlopen(req) as resp:
            if resp.status == 204:
                return None
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode() if e.fp else ""
        raise RuntimeError(f"GitHub API {method} {url} -> {e.code}: {err_body}")

def load_previous_state():
    """Try to load previous state from the repo."""
    url = f"{API_BASE}/repos/{REPO_FULL}/contents/{STATE_FILE}"
    try:
        data = gh_request("GET", url)
        content = base64.b64decode(data["content"]).decode()
        return json.loads(decrypt_state(LONGTASK_KEY, content))
    except Exception as e:
        print(f"[state] No previous state found or decrypt failed: {e}")
        return None

def save_state_to_repo(state):
    """Save encrypted state to the repo via Contents API."""
    encrypted = encrypt_state(LONGTASK_KEY, json.dumps(state))
    
    # Check if file exists (to get SHA for update)
    url = f"{API_BASE}/repos/{REPO_FULL}/contents/{STATE_FILE}"
    sha = None
    try:
        existing = gh_request("GET", url)
        sha = existing.get("sha")
    except:
        pass
    
    payload = {
        "message": f"[longtask] State update: {TASK_ID} iter={ITERATION} step={state.get('currentStep', '?')}",
        "content": base64.b64encode(encrypted.encode()).encode().decode(),
    }
    if sha:
        payload["sha"] = sha
    
    gh_request("PUT", url, payload)
    print(f"[state] Saved state: step={state.get('currentStep')}, progress={state.get('progress')}%")

def dispatch_continuation(next_iteration):
    """Trigger the next iteration of this workflow."""
    url = f"{API_BASE}/repos/{REPO_FULL}/actions/workflows/{WORKFLOW_FILE}/dispatches"
    gh_request("POST", url, {
        "ref": "main",
        "inputs": {"iteration": str(next_iteration)}
    })
    print(f"[continuation] Dispatched iteration {next_iteration}")

def time_remaining():
    """Seconds remaining before max runtime."""
    return max(0, MAX_RUNTIME - (time.time() - START_TIME))

def should_continue():
    """True if we have enough time for another AI call (~2 min safety margin)."""
    return time_remaining() > 120

# ── AI Model Call ──
def call_model(prompt, system_instruction=None):
    """Call Gemini API and return text response."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"
    
    contents = [{"parts": [{"text": prompt}]}]
    body = {"contents": contents}
    
    if system_instruction:
        body["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    body["generationConfig"] = {"temperature": 0.7, "maxOutputTokens": 8192}
    
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode())
            text = result.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
            return text
    except Exception as e:
        print(f"[model] API call failed: {e}", file=sys.stderr)
        return None

# ── Main Execution Loop ──
def main():
    print(f"=== Long-Running Task: {TASK_ID} ===")
    print(f"Iteration: {ITERATION}, Max Runtime: {MAX_RUNTIME}s, Model: {MODEL}")
    print(f"Time remaining: {time_remaining():.0f}s")
    print()
    
    # Load previous state
    state = load_previous_state() or {
        "taskId": TASK_ID,
        "status": "running",
        "currentStep": 0,
        "totalSteps": None,
        "progress": 0,
        "iteration": ITERATION,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lastUpdateAt": None,
        "steps": [],
        "finalResult": None,
        "error": None,
    }
    
    state["iteration"] = ITERATION
    state["status"] = "running"
    state["lastUpdateAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    
    # Build system instruction
    system_inst = f"""You are executing a long-running task in iterative steps.
Task ID: {TASK_ID}
Current iteration: {ITERATION}
Current step: {state['currentStep']}

Your job: Work on the task step by step. Each response should:
1. Analyze what has been done so far (from previous steps)
2. Perform the NEXT logical step of the task
3. End with a JSON block indicating your progress:

```json
{{"step": <current_step_number>, "totalSteps": <estimated_total>, "progress": <0-100>, "summary": "what you did", "reflection": "what to do next", "done": false}}
```

When the task is FULLY complete, set "done": true and provide the final result.

IMPORTANT: Be thorough but efficient. Each step should make meaningful progress."""
    
    # Build the prompt with history
    history_text = ""
    if state["steps"]:
        history_text = "\n\n=== Previous Steps ===\n"
        for s in state["steps"][-5:]:  # Keep last 5 steps for context
            history_text += f"\nStep {s.get('step', '?')}: {s.get('summary', 'N/A')}\n"
            if s.get("reflection"):
                history_text += f"  Reflection: {s['reflection']}\n"
    
    prompt = f"""Task: {TASK_PROMPT}
{history_text}

Now perform the next step (step {state['currentStep'] + 1}). Remember to end with the JSON progress block."""
    
    step_count = 0
    max_steps_per_iteration = 50  # safety limit per workflow run
    
    while should_continue() and step_count < max_steps_per_iteration:
        step_count += 1
        state["currentStep"] += 1
        
        print(f"\n--- Step {state['currentStep']} (time left: {time_remaining():.0f}s) ---")
        
        response = call_model(prompt, system_inst)
        if not response:
            state["error"] = "Model API call failed"
            state["status"] = "error"
            save_state_to_repo(state)
            print("[error] Model call failed, stopping.")
            sys.exit(1)
        
        print(f"[model] Response length: {len(response)} chars")
        
        # Parse the JSON progress block
        import re
        json_match = re.search(r'```json\n(.*?)```', response, re.DOTALL)
        if not json_match:
            json_match = re.search(r'\{[^{}]*"step"[^{}]*"done"[^{}]*\}', response)
        
        step_info = {
            "step": state["currentStep"],
            "summary": response[:200],
            "reflection": "",
            "done": False,
        }
        
        if json_match:
            try:
                raw_json = json_match.group(1) if json_match.lastindex else json_match.group(0)
                parsed = json.loads(raw_json)
                step_info.update({
                    "step": parsed.get("step", state["currentStep"]),
                    "totalSteps": parsed.get("totalSteps"),
                    "progress": parsed.get("progress", 0),
                    "summary": parsed.get("summary", response[:200]),
                    "reflection": parsed.get("reflection", ""),
                    "done": parsed.get("done", False),
                })
                state["totalSteps"] = parsed.get("totalSteps", state["totalSteps"])
                state["progress"] = parsed.get("progress", state["progress"])
            except json.JSONDecodeError as e:
                print(f"[warn] Could not parse progress JSON: {e}")
        
        state["steps"].append(step_info)
        state["lastUpdateAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        
        # Save state periodically (every 3 steps or on completion)
        if step_count % 3 == 0 or step_info["done"]:
            save_state_to_repo(state)
        
        if step_info["done"]:
            state["status"] = "completed"
            state["progress"] = 100
            state["finalResult"] = step_info.get("summary", "Task completed.")
            save_state_to_repo(state)
            print(f"\n✅ Task completed at step {state['currentStep']}!")
            return
        
        # Update prompt for next step
        prompt = f"""Task: {TASK_PROMPT}

=== Recent Steps ===
{chr(10).join(f"Step {s['step']}: {s['summary']}" for s in state['steps'][-5:])}

Now perform step {state['currentStep'] + 1}. Remember to end with the JSON progress block."""
    
    # Time limit or step limit reached — need continuation
    if not should_continue():
        print(f"\n⏰ Time limit approaching ({time_remaining():.0f}s left). Saving state and requesting continuation...")
        state["status"] = "continuation"
        save_state_to_repo(state)
        dispatch_continuation(ITERATION + 1)
    else:
        print(f"\n📊 Step limit reached for this iteration. Saving state...")
        state["status"] = "continuation"
        save_state_to_repo(state)
        dispatch_continuation(ITERATION + 1)

if __name__ == "__main__":
    main()
