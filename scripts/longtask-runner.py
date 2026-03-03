#!/usr/bin/env python3
"""
BrowserAgent Long-Running Task Runner
======================================
Runs on GitHub Actions. Iteratively calls an AI model to work on a task,
saving encrypted intermediate state to the repo. If approaching the time
limit, it exits cleanly so the watchdog can restart it.

Environment variables (injected by the workflow):
  GEMINI_API_KEY       - Gemini API key
  LONGTASK_KEY         - Passphrase for encrypting state
  TASK_ID              - Unique task identifier
  TASK_PROMPT          - The user's task description
  ITERATION            - Current continuation iteration (default: 1)
  MAX_RUNTIME_MINUTES  - Max minutes this run can take (default: 340)
  MODEL                - Gemini model ID
  GITHUB_TOKEN         - Token for GitHub API (needs contents:write)
  REPO_FULL            - owner/repo
  WORKFLOW_FILE        - Workflow filename for self-continuation
"""
import json, os, sys, time, hashlib, base64, re
import urllib.request, urllib.error, traceback

# ── Config ──────────────────────────────────────────────────────────
TASK_ID       = os.environ.get("TASK_ID", "unknown")
TASK_PROMPT   = os.environ.get("TASK_PROMPT", "")
ITERATION     = int(os.environ.get("ITERATION", "1"))
MAX_RUNTIME   = int(os.environ.get("MAX_RUNTIME_MINUTES", "340")) * 60
MODEL         = os.environ.get("MODEL", "gemini-2.5-flash-preview-05-20")
API_KEY       = os.environ.get("GEMINI_API_KEY", "")
LONGTASK_KEY  = os.environ.get("LONGTASK_KEY", "")
GITHUB_TOKEN  = os.environ.get("GITHUB_TOKEN", "")
REPO_FULL     = os.environ.get("REPO_FULL", "")
WORKFLOW_FILE = os.environ.get("WORKFLOW_FILE", "")
STATE_DIR     = "longtask_state"
STATE_FILE    = f"{STATE_DIR}/{TASK_ID}.enc"
START_TIME    = time.time()

# ── Crypto (AES-256-GCM, compatible with BrowserAgent crypto.js) ──

def _derive_key(passphrase, salt):
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, 310000, dklen=32)

def encrypt_state(passphrase, plaintext):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt = os.urandom(16)
    iv   = os.urandom(12)
    key  = _derive_key(passphrase, salt)
    ct   = AESGCM(key).encrypt(iv, plaintext.encode(), None)
    return base64.b64encode(salt + iv + ct).decode()

def decrypt_state(passphrase, b64data):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    raw  = base64.b64decode(b64data)
    salt, iv, ct = raw[:16], raw[16:28], raw[28:]
    key  = _derive_key(passphrase, salt)
    return AESGCM(key).decrypt(iv, ct, None).decode()

# ── GitHub API helpers ──────────────────────────────────────────────
API_BASE = "https://api.github.com"

def gh_headers():
    return {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
    }

def gh_request(method, url, data=None, retries=3):
    body = json.dumps(data).encode() if data else None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, method=method, headers=gh_headers())
            with urllib.request.urlopen(req, timeout=30) as resp:
                if resp.status == 204:
                    return None
                return json.loads(resp.read().decode())
        except Exception as e:
            print(f"[gh] {method} {url} attempt {attempt+1}/{retries} failed: {e}")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise

def load_previous_state():
    url = f"{API_BASE}/repos/{REPO_FULL}/contents/{STATE_FILE}"
    try:
        data = gh_request("GET", url)
        content = base64.b64decode(data["content"]).decode()
        return json.loads(decrypt_state(LONGTASK_KEY, content))
    except Exception as e:
        print(f"[state] No previous state or decrypt failed: {e}")
        return None

def save_state_to_repo(state):
    encrypted = encrypt_state(LONGTASK_KEY, json.dumps(state))

    url = f"{API_BASE}/repos/{REPO_FULL}/contents/{STATE_FILE}"
    sha = None
    try:
        existing = gh_request("GET", url)
        sha = existing.get("sha")
    except Exception:
        pass

    payload = {
        "message": f"[longtask] State: {TASK_ID} iter={ITERATION} step={state.get('currentStep', '?')}",
        "content": base64.b64encode(encrypted.encode()).decode(),
    }
    if sha:
        payload["sha"] = sha

    gh_request("PUT", url, payload)
    print(f"[state] Saved: step={state.get('currentStep')}, progress={state.get('progress')}%")

# ── AI Model Call with retry ────────────────────────────────────────

def call_model(prompt, system_instruction=None, retries=3):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"

    contents = [{"parts": [{"text": prompt}]}]
    body = {"contents": contents}
    if system_instruction:
        body["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    body["generationConfig"] = {"temperature": 0.7, "maxOutputTokens": 8192}

    for attempt in range(retries):
        try:
            data = json.dumps(body).encode()
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                result = json.loads(resp.read().decode())
                text = (result.get("candidates", [{}])[0]
                        .get("content", {})
                        .get("parts", [{}])[0]
                        .get("text", ""))
                if text:
                    return text
                print(f"[model] Empty response on attempt {attempt+1}")
        except Exception as e:
            print(f"[model] Attempt {attempt+1}/{retries} failed: {e}")
        if attempt < retries - 1:
            time.sleep(5 * (attempt + 1))
    return None

# ── Time helpers ────────────────────────────────────────────────────

def time_remaining():
    return max(0, MAX_RUNTIME - (time.time() - START_TIME))

def should_continue():
    return time_remaining() > 120

# ── Parse progress JSON from model response ────────────────────────

def parse_progress(response):
    # Try ```json\n...\n```
    m = re.search(r'```json\s*\n(.*?)```', response, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except json.JSONDecodeError:
            pass
    # Try naked JSON with "step" and "done" keys
    m = re.search(r'\{[^{}]*"step"\s*:.*?"done"\s*:.*?\}', response, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    return None

# ── Make an empty state ─────────────────────────────────────────────

def make_initial_state():
    return {
        "taskId": TASK_ID,
        "taskPrompt": TASK_PROMPT,
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

# ── Main ────────────────────────────────────────────────────────────

def main():
    print(f"=== Long-Running Task: {TASK_ID} ===")
    print(f"Iteration: {ITERATION}, Max Runtime: {MAX_RUNTIME}s, Model: {MODEL}")
    print(f"Time remaining: {time_remaining():.0f}s")
    print()

    if not API_KEY:
        print("[fatal] GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(1)
    if not LONGTASK_KEY:
        print("[fatal] LONGTASK_KEY not set", file=sys.stderr)
        sys.exit(1)

    # Load or create state
    state = load_previous_state() or make_initial_state()
    state["iteration"] = ITERATION
    state["status"] = "running"
    state["lastUpdateAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Prefer prompt from state (set by browser), fall back to env var
    task_prompt = state.get("taskPrompt") or TASK_PROMPT
    if not task_prompt:
        print("[fatal] No task prompt found in state or TASK_PROMPT env var", file=sys.stderr)
        sys.exit(1)
    print(f"Task prompt: {task_prompt[:200]}...")

    # Save initial state immediately
    try:
        save_state_to_repo(state)
    except Exception as e:
        print(f"[warn] Could not save initial state: {e}")

    # System instruction
    system_inst = (
        "You are executing a long-running task in iterative steps.\n"
        f"Task ID: {TASK_ID}\n"
        f"Current iteration: {ITERATION}\n"
        f"Current step: {state['currentStep']}\n\n"
        "Your job: Work on the task step by step. Each response should:\n"
        "1. Analyze what has been done so far (from previous steps)\n"
        "2. Perform the NEXT logical step of the task\n"
        "3. End with a JSON block indicating your progress:\n\n"
        "```json\n"
        '{"step": <number>, "totalSteps": <estimated_total>, "progress": <0-100>, '
        '"summary": "what you did", "reflection": "what to do next", "done": false}\n'
        "```\n\n"
        'When the task is FULLY complete, set "done": true and include the final result in "summary".\n\n'
        "IMPORTANT: Be thorough but efficient. Each step should make meaningful progress."
    )

    # Build history context
    def build_history():
        if not state["steps"]:
            return ""
        recent = state["steps"][-5:]
        lines = ["\n=== Previous Steps ==="]
        for s in recent:
            lines.append(f"\nStep {s.get('step', '?')}: {s.get('summary', 'N/A')}")
            if s.get("reflection"):
                lines.append(f"  Reflection: {s['reflection']}")
        return "\n".join(lines)

    step_count = 0
    max_steps_per_iteration = 50
    consecutive_failures = 0
    max_consecutive_failures = 5

    while should_continue() and step_count < max_steps_per_iteration:
        step_count += 1
        state["currentStep"] += 1

        print(f"\n--- Step {state['currentStep']} (time left: {time_remaining():.0f}s) ---")

        prompt = (
            f"Task: {task_prompt}\n"
            f"{build_history()}\n\n"
            f"Now perform step {state['currentStep']}. "
            "Remember to end with the JSON progress block."
        )

        try:
            response = call_model(prompt, system_inst)
        except Exception as e:
            print(f"[error] Model call exception: {e}")
            response = None

        if not response:
            consecutive_failures += 1
            state["currentStep"] -= 1  # don't count failed step
            step_count -= 1
            print(f"[warn] Model returned no response. Failures: {consecutive_failures}/{max_consecutive_failures}")
            if consecutive_failures >= max_consecutive_failures:
                state["error"] = f"Model failed {max_consecutive_failures} times consecutively"
                state["status"] = "error"
                save_state_to_repo(state)
                print("[error] Too many consecutive failures. Stopping.")
                sys.exit(1)
            time.sleep(10 * consecutive_failures)
            continue

        consecutive_failures = 0
        print(f"[model] Response: {len(response)} chars")

        # Parse progress
        parsed = parse_progress(response)
        step_info = {
            "step": state["currentStep"],
            "summary": response[:300],
            "reflection": "",
            "done": False,
        }

        if parsed:
            step_info.update({
                "step": parsed.get("step", state["currentStep"]),
                "totalSteps": parsed.get("totalSteps"),
                "progress": parsed.get("progress", 0),
                "summary": parsed.get("summary", response[:300]),
                "reflection": parsed.get("reflection", ""),
                "done": parsed.get("done", False),
            })
            state["totalSteps"] = parsed.get("totalSteps", state["totalSteps"])
            state["progress"] = parsed.get("progress", state["progress"])

        state["steps"].append(step_info)
        state["lastUpdateAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        # Save periodically or on completion
        if step_count % 3 == 0 or step_info["done"]:
            try:
                save_state_to_repo(state)
            except Exception as e:
                print(f"[warn] Save state failed: {e}")

        if step_info["done"]:
            state["status"] = "completed"
            state["progress"] = 100
            state["finalResult"] = step_info.get("summary", "Task completed.")
            try:
                save_state_to_repo(state)
            except Exception as e:
                print(f"[warn] Final save failed: {e}")
            print(f"\n✅ Task completed at step {state['currentStep']}!")
            return

    # Ran out of time or steps — save and exit cleanly for watchdog/continuation
    reason = "time limit" if not should_continue() else "step limit"
    print(f"\n⏰ {reason} reached. Saving state for continuation...")
    state["status"] = "continuation"
    try:
        save_state_to_repo(state)
    except Exception as e:
        print(f"[warn] Save state on exit failed: {e}")

    print("[done] Exiting cleanly. Watchdog will handle continuation.")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[fatal] Unhandled exception: {e}", file=sys.stderr)
        traceback.print_exc()
        # Try to save error state
        try:
            state = load_previous_state() or make_initial_state()
            state["status"] = "error"
            state["error"] = str(e)
            state["lastUpdateAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            save_state_to_repo(state)
        except Exception:
            pass
        sys.exit(1)
