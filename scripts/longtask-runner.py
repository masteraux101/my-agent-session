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

# Force unbuffered stdout so GitHub Actions shows logs in real-time
os.environ['PYTHONUNBUFFERED'] = '1'
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(line_buffering=True)

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


def utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

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

def save_state_to_repo(state, max_attempts=5):
    encrypted = encrypt_state(LONGTASK_KEY, json.dumps(state))
    url = f"{API_BASE}/repos/{REPO_FULL}/contents/{STATE_FILE}"

    for attempt in range(max_attempts):
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

        try:
            gh_request("PUT", url, payload)
            print(f"[state] Saved: step={state.get('currentStep')}, progress={state.get('progress')}%")
            return
        except Exception as e:
            if '409' in str(e) and attempt < max_attempts - 1:
                print(f"[state] SHA conflict (attempt {attempt+1}), re-fetching and retrying...")
                time.sleep(1 + attempt)
                continue
            raise

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
        "deliverables": [],
        "finalResult": None,
        "error": None,
    }

# ── Deliverable extraction & writing ────────────────────────────────

DELIVERABLE_DIR = f"longtask_output/{TASK_ID}"

def extract_deliverables(response):
    """Extract file deliverables from model response.
    Looks for specially tagged code blocks:
      ```file:path/to/file.ext
      content
      ```
    Returns list of {"path": ..., "content": ...}
    """
    results = []
    pattern = r'```file:([^\n]+)\n(.*?)```'
    for m in re.finditer(pattern, response, re.DOTALL):
        filepath = m.group(1).strip()
        content = m.group(2)
        results.append({"path": filepath, "content": content})
    return results

def write_deliverable_to_repo(filepath, content):
    """Write a deliverable file to the repo via Contents API."""
    full_path = f"{DELIVERABLE_DIR}/{filepath}"
    url = f"{API_BASE}/repos/{REPO_FULL}/contents/{full_path}"

    sha = None
    try:
        existing = gh_request("GET", url)
        sha = existing.get("sha")
    except Exception:
        pass

    payload = {
        "message": f"[longtask] Deliverable: {filepath} (task={TASK_ID})",
        "content": base64.b64encode(content.encode()).decode(),
    }
    if sha:
        payload["sha"] = sha

    for attempt in range(3):
        try:
            gh_request("PUT", url, payload)
            print(f"[deliverable] Written: {full_path}")
            return full_path
        except Exception as e:
            if '409' in str(e) and attempt < 2:
                # SHA conflict — re-fetch
                try:
                    existing = gh_request("GET", url)
                    payload["sha"] = existing.get("sha")
                except Exception:
                    pass
                time.sleep(1)
                continue
            print(f"[deliverable] Failed to write {full_path}: {e}")
            raise


def print_watchdog_advice(advice):
    if not advice:
        return

    print("\n[watchdog-advice] Received revision guidance before execution:")
    print(f"[watchdog-advice] Eval #{advice.get('evalNumber', '?')}")

    issues = advice.get("issues") or []
    if issues:
        print("[watchdog-advice] Issues to fix:")
        for issue in issues:
            print(f"  - {issue}")

    suggestions = advice.get("suggestions")
    if suggestions:
        print(f"[watchdog-advice] Suggestions: {suggestions}")

    deliverable_paths = advice.get("deliverablePaths") or []
    if deliverable_paths:
        print("[watchdog-advice] Previous deliverables to reuse/update:")
        for path in deliverable_paths:
            print(f"  - {path}")
    else:
        print(f"[watchdog-advice] Deliverable root: {DELIVERABLE_DIR}/")
    print()


def build_history_context(state):
    if not state["steps"]:
        return ""

    recent = state["steps"][-5:]
    lines = ["\n=== Previous Steps ==="]
    for s in recent:
        lines.append(f"\nStep {s.get('step', '?')}: {s.get('summary', 'N/A')}")
        if s.get("reflection"):
            lines.append(f"  Reflection: {s['reflection']}")
        if s.get("strategy_adjustment"):
            lines.append(f"  Strategy adjustment: {s['strategy_adjustment']}")
        if s.get("deliverables_written"):
            lines.append(f"  Files produced: {', '.join(s['deliverables_written'])}")

    if state.get("deliverables"):
        lines.append(f"\n=== Deliverables so far: {len(state['deliverables'])} files ===")
        for d in state["deliverables"][-10:]:
            lines.append(f"  - {d}")
    return "\n".join(lines)


def build_step_info(state, response, parsed, deliverables_written):
    step_info = {
        "step": state["currentStep"],
        "summary": response[:300],
        "reflection": "",
        "strategy_adjustment": "",
        "deliverables_written": deliverables_written,
        "done": False,
    }

    if not parsed:
        return step_info

    step_info.update({
        "step": parsed.get("step", state["currentStep"]),
        "totalSteps": parsed.get("totalSteps"),
        "progress": parsed.get("progress", 0),
        "summary": parsed.get("summary", response[:300]),
        "reflection": parsed.get("reflection", ""),
        "strategy_adjustment": parsed.get("strategy_adjustment", ""),
        "deliverables_written": deliverables_written,
        "done": parsed.get("done", False),
    })
    state["totalSteps"] = parsed.get("totalSteps", state["totalSteps"])
    state["progress"] = parsed.get("progress", state["progress"])
    return step_info

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
    state["lastUpdateAt"] = utc_now()

    # Prefer prompt from state (set by browser), fall back to env var
    task_prompt = state.get("taskPrompt") or TASK_PROMPT
    if not task_prompt:
        print("[fatal] No task prompt found in state or TASK_PROMPT env var", file=sys.stderr)
        sys.exit(1)
    print(f"Task prompt: {task_prompt[:200]}...")

    latest_advice = state.get("latestWatchdogAdvice") or {}
    print_watchdog_advice(latest_advice)

    # Save initial state immediately
    try:
        save_state_to_repo(state)
    except Exception as e:
        print(f"[warn] Could not save initial state: {e}")

    # System instruction — context-aware, strategy-driven
    system_inst = (
        "You are an autonomous AI agent executing a complex task iteratively.\n"
        f"Task ID: {TASK_ID}\n"
        f"Current iteration: {ITERATION}\n"
        f"Current step: {state['currentStep']}\n\n"
        "Your job is NOT a simple step-by-step loop. You must:\n"
        "1. UNDERSTAND the full task context and the results from previous steps.\n"
        "2. DYNAMICALLY PLAN what to do next based on what you've learned so far.\n"
        "3. ADJUST your strategy if previous results reveal unexpected information.\n"
        "4. PRODUCE deliverables — write actual code, data, or reports as output.\n\n"
        "## Output Format\n"
        "Each response should contain:\n"
        "- Your analysis and reasoning about the current situation\n"
        "- The actual work product for this step\n"
        "- Any file deliverables using the special block format (see below)\n"
        "- A JSON progress block at the end\n\n"
        "## File Deliverables\n"
        "To create/update files in the repo, use this exact format:\n"
        "```file:relative/path/filename.ext\n"
        "file content here\n"
        "```\n\n"
        "Examples:\n"
        "```file:report.md\n"
        "# Research Report\n...\n"
        "```\n"
        "```file:data/results.json\n"
        '{\"key\": \"value\"}\n'
        "```\n\n"
        "## Progress JSON Block\n"
        "End every response with:\n"
        "```json\n"
        '{"step": <number>, "totalSteps": <estimated_total>, "progress": <0-100>, '
        '"summary": "what you accomplished", "reflection": "what you learned and what to do next", '
        '"strategy_adjustment": "any changes to your approach based on findings", "done": false}\n'
        "```\n\n"
        'When the task is FULLY complete, set "done": true, include the final summary, '
        "and write the final deliverable files.\n\n"
        "IMPORTANT:\n"
        "- Each step should make MEANINGFUL progress, not just outline plans.\n"
        "- Actively reflect on previous results — if something didn't work, change approach.\n"
        "- Produce concrete output (files, data, analysis), not just descriptions.\n"
        "- If the task requires research/analysis, synthesize findings into a deliverable document."
    )

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
            f"{build_history_context(state)}\n\n"
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

        # Extract and write file deliverables
        deliverables = extract_deliverables(response)
        deliverables_written = []
        for d in deliverables:
            try:
                written_path = write_deliverable_to_repo(d["path"], d["content"])
                deliverables_written.append(written_path)
                if written_path not in state.get("deliverables", []):
                    state.setdefault("deliverables", []).append(written_path)
            except Exception as e:
                print(f"[warn] Failed to write deliverable {d['path']}: {e}")

        if deliverables_written:
            print(f"[deliverables] Wrote {len(deliverables_written)} files: {deliverables_written}")

        # Parse progress
        parsed = parse_progress(response)
        step_info = build_step_info(state, response, parsed, deliverables_written)

        state["steps"].append(step_info)
        state["lastUpdateAt"] = utc_now()

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
            state["lastUpdateAt"] = utc_now()
            save_state_to_repo(state)
        except Exception:
            pass
        sys.exit(1)
