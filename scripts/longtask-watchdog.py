#!/usr/bin/env python3
"""
BrowserAgent Long-Task Watchdog
================================
Runs as a separate GitHub Actions workflow. Monitors a target long-task
workflow run. Responsibilities:

1. Poll the target workflow's latest run status
2. If the run completed successfully with status="continuation", restart it
3. If the run failed/errored, retry it (up to MAX_RETRIES)
4. If the task state says "completed", stop watching
5. If approaching its own time limit, self-heal by dispatching another watchdog

Environment variables (injected by the workflow):
  GITHUB_TOKEN         - Token for GitHub API
  REPO_FULL            - owner/repo
  TASK_ID              - The long-task ID to watch
  TARGET_WORKFLOW      - Workflow filename of the long-task (e.g. longtask-xxx.yml)
  WATCHDOG_WORKFLOW    - This watchdog's workflow filename
  LONGTASK_KEY         - Passphrase for reading encrypted state
  MAX_RETRIES          - Max times to retry a failed run (default: 3)
  POLL_INTERVAL        - Seconds between status checks (default: 30)
  MAX_RUNTIME_MINUTES  - Max minutes for this watchdog run (default: 340)
"""
import json, os, sys, time, hashlib, base64
import urllib.request, urllib.error, traceback

# Force unbuffered stdout so GitHub Actions shows logs in real-time
os.environ['PYTHONUNBUFFERED'] = '1'
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(line_buffering=True)

# ── Config ──────────────────────────────────────────────────────────
TASK_ID            = os.environ.get("TASK_ID", "")
GITHUB_TOKEN       = os.environ.get("GITHUB_TOKEN", "")
REPO_FULL          = os.environ.get("REPO_FULL", "")
TARGET_WORKFLOW    = os.environ.get("TARGET_WORKFLOW", "")
WATCHDOG_WORKFLOW  = os.environ.get("WATCHDOG_WORKFLOW", "")
LONGTASK_KEY       = os.environ.get("LONGTASK_KEY", "")
GEMINI_API_KEY     = os.environ.get("GEMINI_API_KEY", "")
MODEL              = os.environ.get("MODEL", "gemini-2.5-flash-preview-05-20")
MAX_RETRIES        = int(os.environ.get("MAX_RETRIES", "3"))
POLL_INTERVAL      = int(os.environ.get("POLL_INTERVAL", "30"))
MAX_RUNTIME        = int(os.environ.get("MAX_RUNTIME_MINUTES", "340")) * 60
START_TIME         = time.time()
STATE_DIR          = "longtask_state"
STATE_FILE         = f"{STATE_DIR}/{TASK_ID}.enc"
API_BASE           = "https://api.github.com"
EVAL_COUNT         = 0  # track how many evaluations we've done
MAX_EVALUATIONS    = 3
READ_DELIVERABLE_LIMIT = 5
PROMPT_DELIVERABLE_LIMIT = 20


def utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def append_evaluation(state, verdict, issues=None, suggestions=""):
    state.setdefault("evaluations", []).append({
        "evalNumber": EVAL_COUNT,
        "verdict": verdict,
        "issues": issues or [],
        "suggestions": suggestions,
        "timestamp": utc_now(),
    })

# ── GitHub API helpers ──────────────────────────────────────────────

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
            print(f"[gh] {method} {url} attempt {attempt+1}/{retries}: {e}")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise

# ── Crypto helpers (for reading state) ──────────────────────────────

def _derive_key(passphrase, salt):
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, 310000, dklen=32)

def decrypt_state(passphrase, b64data):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    raw  = base64.b64decode(b64data)
    salt, iv, ct = raw[:16], raw[16:28], raw[28:]
    key  = _derive_key(passphrase, salt)
    return AESGCM(key).decrypt(iv, ct, None).decode()

def encrypt_state(passphrase, plaintext):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt = os.urandom(16)
    iv   = os.urandom(12)
    key  = _derive_key(passphrase, salt)
    ct   = AESGCM(key).encrypt(iv, plaintext.encode(), None)
    return base64.b64encode(salt + iv + ct).decode()

# ── State helpers ───────────────────────────────────────────────────

def load_task_state():
    url = f"{API_BASE}/repos/{REPO_FULL}/contents/{STATE_FILE}"
    try:
        data = gh_request("GET", url)
        content = base64.b64decode(data["content"]).decode()
        return json.loads(decrypt_state(LONGTASK_KEY, content))
    except Exception as e:
        print(f"[state] Could not load state: {e}")
        return None

def save_task_state(state, max_attempts=5):
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
            "message": f"[watchdog] State update: {TASK_ID}",
            "content": base64.b64encode(encrypted.encode()).decode(),
        }
        if sha:
            payload["sha"] = sha

        try:
            gh_request("PUT", url, payload)
            return
        except Exception as e:
            if '409' in str(e) and attempt < max_attempts - 1:
                print(f"[state] SHA conflict (attempt {attempt+1}), re-fetching and retrying...")
                time.sleep(1 + attempt)
                continue
            raise

# ── Workflow helpers ────────────────────────────────────────────────

def get_latest_run(workflow_file):
    """Get the most recent run of a workflow."""
    url = (f"{API_BASE}/repos/{REPO_FULL}/actions/workflows/{workflow_file}"
           f"/runs?per_page=1&event=workflow_dispatch")
    try:
        data = gh_request("GET", url)
        runs = data.get("workflow_runs", [])
        return runs[0] if runs else None
    except Exception as e:
        print(f"[watchdog] Could not get latest run: {e}")
        return None

def get_run_status(run_id):
    """Get current status of a specific run."""
    url = f"{API_BASE}/repos/{REPO_FULL}/actions/runs/{run_id}"
    try:
        return gh_request("GET", url)
    except Exception as e:
        print(f"[watchdog] Could not get run {run_id}: {e}")
        return None

def dispatch_workflow(workflow_file, inputs=None):
    """Trigger a workflow_dispatch."""
    url = f"{API_BASE}/repos/{REPO_FULL}/actions/workflows/{workflow_file}/dispatches"
    gh_request("POST", url, {
        "ref": "main",
        "inputs": inputs or {}
    })
    print(f"[watchdog] Dispatched {workflow_file} with inputs={inputs}")

def dispatch_target(iteration):
    """Dispatch the target long-task workflow."""
    dispatch_workflow(TARGET_WORKFLOW, {"iteration": str(iteration)})

def dispatch_watchdog_continuation():
    """Dispatch another watchdog to continue monitoring."""
    dispatch_workflow(WATCHDOG_WORKFLOW, {
        "task_id": TASK_ID,
        "target_workflow": TARGET_WORKFLOW,
    })

def time_remaining():
    return max(0, MAX_RUNTIME - (time.time() - START_TIME))

def should_continue():
    return time_remaining() > 120

# ── AI Model Call (for evaluation) ──────────────────────────────────

def call_model(prompt, system_instruction=None, retries=3):
    """Call Gemini API for evaluation purposes."""
    if not GEMINI_API_KEY:
        print("[eval] No GEMINI_API_KEY — skipping AI evaluation")
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={GEMINI_API_KEY}"

    contents = [{"parts": [{"text": prompt}]}]
    body = {"contents": contents}
    if system_instruction:
        body["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    body["generationConfig"] = {"temperature": 0.3, "maxOutputTokens": 4096}

    for attempt in range(retries):
        try:
            data = json.dumps(body).encode()
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.loads(resp.read().decode())
                text = (result.get("candidates", [{}])[0]
                        .get("content", {})
                        .get("parts", [{}])[0]
                        .get("text", ""))
                return text
        except Exception as e:
            print(f"[eval] Model call attempt {attempt+1}/{retries} failed: {e}")
            if attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
    return None

def read_deliverables(state):
    """Read deliverable file contents from repo for evaluation."""
    deliverables = state.get("deliverables", [])
    if not deliverables:
        return ""
    results = []
    for path in deliverables[-READ_DELIVERABLE_LIMIT:]:
        url = f"{API_BASE}/repos/{REPO_FULL}/contents/{path}"
        try:
            data = gh_request("GET", url)
            content = base64.b64decode(data["content"]).decode()
            # Truncate large files
            if len(content) > 2000:
                content = content[:2000] + "\n... (truncated)"
            results.append(f"=== {path} ===\n{content}")
        except Exception as e:
            results.append(f"=== {path} === (could not read: {e})")
    return "\n\n".join(results)

def evaluate_runner_output(state):
    """Use AI to evaluate Runner's completed output.
    Returns: {"verdict": "pass"|"needs_improvement", "issues": [...], "suggestions": "...", "revised_prompt": "..."}
    """
    global EVAL_COUNT
    EVAL_COUNT = max(EVAL_COUNT, len(state.get("evaluations", [])))
    EVAL_COUNT += 1

    if EVAL_COUNT > MAX_EVALUATIONS:
        print(f"[eval] Already evaluated {MAX_EVALUATIONS} times — accepting result to avoid infinite loop.")
        return {"verdict": "pass", "issues": [], "suggestions": ""}

    task_prompt = state.get("taskPrompt", "")
    steps_summary = ""
    for s in state.get("steps", [])[-10:]:
        steps_summary += f"\nStep {s.get('step', '?')}: {s.get('summary', 'N/A')}"
        if s.get("reflection"):
            steps_summary += f"\n  Reflection: {s['reflection']}"

    deliverables_text = read_deliverables(state)
    final_result = state.get("finalResult", "")

    eval_prompt = (
        f"You are evaluating whether an AI agent completed a task correctly.\n\n"
        f"## Original Task\n{task_prompt}\n\n"
        f"## Steps Taken ({len(state.get('steps', []))} total)\n{steps_summary}\n\n"
        f"## Deliverables Produced\n{deliverables_text or '(none)'}\n\n"
        f"## Final Result\n{final_result or '(none)'}\n\n"
        f"## Your Evaluation\n"
        f"Evaluate the output quality:\n"
        f"1. Is the task fully completed as requested?\n"
        f"2. Are there any gaps, errors, or missing components?\n"
        f"3. Is the quality of deliverables acceptable?\n"
        f"4. What specific improvements are needed, if any?\n\n"
        f"Respond with a JSON block:\n"
        f"```json\n"
        f'{{"verdict": "pass" or "needs_improvement", '
        f'"issues": ["issue1", "issue2"], '
        f'"suggestions": "specific improvement instructions", '
        f'"revised_prompt": "if needs_improvement, the revised/supplemented task prompt for the runner to re-execute"}}\n'
        f"```\n\n"
        f"IMPORTANT: Only mark as 'needs_improvement' if there are SIGNIFICANT gaps. "
        f"Minor formatting issues should be 'pass'. "
        f"The 'revised_prompt' should include the ORIGINAL task plus specific instructions to fix the issues."
    )

    print(f"[eval] Evaluating Runner output (evaluation #{EVAL_COUNT})...")
    response = call_model(eval_prompt)
    if not response:
        print("[eval] Could not get evaluation — defaulting to pass")
        return {"verdict": "pass", "issues": [], "suggestions": ""}

    # Parse evaluation JSON
    import re
    m = re.search(r'```json\s*\n(.*?)```', response, re.DOTALL)
    if m:
        try:
            result = json.loads(m.group(1).strip())
            print(f"[eval] Verdict: {result.get('verdict', '?')}, Issues: {result.get('issues', [])}")
            return result
        except json.JSONDecodeError:
            pass

    # Try naked JSON
    m = re.search(r'\{[^{}]*"verdict"\s*:.*?\}', response, re.DOTALL)
    if m:
        try:
            result = json.loads(m.group(0))
            print(f"[eval] Verdict: {result.get('verdict', '?')}")
            return result
        except json.JSONDecodeError:
            pass

    print(f"[eval] Could not parse evaluation response — defaulting to pass")
    return {"verdict": "pass", "issues": [], "suggestions": ""}

def build_revised_task_prompt(state, revised_prompt, suggestions, issues):
    """Build a robust next-round prompt that always includes prior artifact locations."""
    base_prompt = (revised_prompt or state.get("taskPrompt") or "").strip()
    deliverables = state.get("deliverables", [])

    if deliverables:
        deliverable_lines = "\n".join(f"- {p}" for p in deliverables[-PROMPT_DELIVERABLE_LIMIT:])
    else:
        deliverable_lines = f"- longtask_output/{TASK_ID}/ (no explicit files recorded yet)"

    issues_lines = "\n".join(f"- {i}" for i in (issues or [])) or "- (none listed)"
    suggestions_text = (suggestions or "").strip() or "(none provided)"

    guidance_block = (
        "\n\n--- WATCHDOG REVISION GUIDANCE ---\n"
        "This is a re-run after watchdog evaluation. You MUST address all items below.\n\n"
        "Issues to fix:\n"
        f"{issues_lines}\n\n"
        "Improvement suggestions:\n"
        f"{suggestions_text}\n\n"
        "Previous iteration artifacts (read/modify these paths directly):\n"
        f"{deliverable_lines}\n"
    )
    return base_prompt + guidance_block

# ── Main watchdog loop ──────────────────────────────────────────────

def main():
    print(f"=== Watchdog for Task: {TASK_ID} ===")
    print(f"Target workflow: {TARGET_WORKFLOW}")
    print(f"Watchdog workflow: {WATCHDOG_WORKFLOW}")
    print(f"Max retries: {MAX_RETRIES}, Poll interval: {POLL_INTERVAL}s")
    print(f"Time remaining: {time_remaining():.0f}s")
    print()

    if not TASK_ID or not TARGET_WORKFLOW:
        print("[fatal] TASK_ID and TARGET_WORKFLOW must be set", file=sys.stderr)
        sys.exit(1)

    retry_count = 0
    last_seen_run_id = None
    processed_run_ids = set()  # track runs we've already handled
    waiting_for_new_run = False
    wait_start = None
    poll_count = 0

    def redispatch_runner(iteration, run_id=None):
        dispatch_target(iteration)
        if run_id is not None:
            processed_run_ids.add(run_id)
        return True, time.time()

    while should_continue():
        poll_count += 1
        elapsed = time.time() - START_TIME
        print(f"\n[poll #{poll_count}] elapsed={elapsed:.0f}s, remaining={time_remaining():.0f}s, retries={retry_count}/{MAX_RETRIES}")
        sys.stdout.flush()

        # 1. Check task state — if completed, we're done
        state = load_task_state()
        if state:
            status = state.get("status", "")
            print(f"[state] Task status: {status}, progress: {state.get('progress', 0)}%, "
                  f"step: {state.get('currentStep', 0)}, iteration: {state.get('iteration', '?')}")

            # Note: do NOT return early on "completed" here.
            # Let it fall through to the run-completion handler (step 3)
            # where evaluation logic actually runs.

            if status == "error" and retry_count >= MAX_RETRIES:
                print(f"\n❌ Task errored and max retries ({MAX_RETRIES}) exhausted.")
                return
        else:
            print("[state] Could not load task state (may not exist yet)")

        # 2. Check the latest run of the target workflow
        run = get_latest_run(TARGET_WORKFLOW)

        if not run:
            print("[watchdog] No runs found for target workflow.")
            if not waiting_for_new_run:
                # Maybe the first run hasn't started yet — wait a bit
                print("[watchdog] Waiting for first run to appear...")
                time.sleep(POLL_INTERVAL)
                continue
            elif waiting_for_new_run and wait_start and (time.time() - wait_start) > 120:
                # We dispatched a run but it hasn't appeared yet after 2 min
                print("[watchdog] Dispatched run hasn't appeared. Re-dispatching...")
                iteration = (state.get("iteration", 1) if state else 1)
                dispatch_target(iteration)
                wait_start = time.time()
            time.sleep(POLL_INTERVAL)
            continue

        run_id = run["id"]
        run_status = run["status"]  # queued, in_progress, completed
        run_conclusion = run.get("conclusion")  # success, failure, cancelled, ...
        run_created = run.get("created_at", "")

        # Track if this is a new run
        if last_seen_run_id != run_id:
            last_seen_run_id = run_id
            waiting_for_new_run = False
            print(f"[watchdog] Now tracking run #{run_id} (status={run_status}, created={run_created})")

        # 3. Handle different run states
        if run_status in ("queued", "in_progress"):
            print(f"[watchdog] Run #{run_id} is {run_status}. Waiting {POLL_INTERVAL}s...")
            sys.stdout.flush()
            time.sleep(POLL_INTERVAL)
            continue

        if run_status == "completed":
            # Skip if we've already processed this run (avoid re-evaluation loops)
            if run_id in processed_run_ids:
                if waiting_for_new_run:
                    print(f"[watchdog] Waiting for new run (old run #{run_id} already processed). Waiting {POLL_INTERVAL}s...")
                else:
                    print(f"[watchdog] Run #{run_id} already processed. Waiting {POLL_INTERVAL}s...")
                sys.stdout.flush()
                time.sleep(POLL_INTERVAL)
                continue

            print(f"[watchdog] Run #{run_id} completed with conclusion: {run_conclusion}")

            # Re-read state after completion
            print("[watchdog] Waiting 5s for state to settle, then re-reading...")
            time.sleep(5)
            state = load_task_state()

            if state:
                task_status = state.get("status", "")
                print(f"[state] After run completion, task status: {task_status}")

                if task_status == "completed":
                    # ── Evaluate Runner's output ──
                    print("\n[watchdog] Runner reports task completed. Evaluating output quality...")
                    evaluation = evaluate_runner_output(state)

                    if evaluation.get("verdict") == "needs_improvement" and EVAL_COUNT <= MAX_EVALUATIONS:
                        issues = evaluation.get("issues", [])
                        revised_prompt = evaluation.get("revised_prompt", "")
                        suggestions = evaluation.get("suggestions", "")

                        print(f"[eval] Output needs improvement:")
                        for issue in issues:
                            print(f"  - {issue}")
                        print(f"[eval] Suggestions: {suggestions}")

                        merged_prompt = build_revised_task_prompt(state, revised_prompt, suggestions, issues)
                        deliverable_paths = state.get("deliverables", [])[-PROMPT_DELIVERABLE_LIMIT:]

                        # Modify state: update prompt with evaluation feedback, reset for re-execution
                        state["status"] = "running"
                        state["taskPrompt"] = merged_prompt
                        state["latestWatchdogAdvice"] = {
                            "evalNumber": EVAL_COUNT,
                            "issues": issues,
                            "suggestions": suggestions,
                            "deliverablePaths": deliverable_paths,
                            "updatedAt": utc_now(),
                        }
                        state["progress"] = max(0, state.get("progress", 0) - 20)
                        state["finalResult"] = None
                        state["error"] = None
                        append_evaluation(state, "needs_improvement", issues, suggestions)

                        try:
                            save_task_state(state)
                        except Exception as e:
                            print(f"[warn] Failed to save revised state: {e}")

                        # Re-dispatch runner with revised guidance
                        iteration = state.get("iteration", 1) + 1
                        print(f"[eval] Re-dispatching Runner (iteration {iteration}) with revised task...")
                        waiting_for_new_run, wait_start = redispatch_runner(iteration, run_id)
                        time.sleep(POLL_INTERVAL)
                        continue

                    # Evaluation passed or no AI available
                    print("\n✅ Task completed and evaluation passed!")
                    processed_run_ids.add(run_id)
                    # Record evaluation in state
                    append_evaluation(state, "pass")
                    try:
                        save_task_state(state)
                    except Exception:
                        pass
                    return

                if task_status == "continuation":
                    # Task needs more time — dispatch next iteration
                    next_iter = state.get("iteration", 1) + 1
                    print(f"[watchdog] Task needs continuation. Dispatching iteration {next_iter}...")
                    waiting_for_new_run, wait_start = redispatch_runner(next_iter, run_id)
                    time.sleep(POLL_INTERVAL)
                    continue

                if task_status == "error":
                    retry_count += 1
                    if retry_count <= MAX_RETRIES:
                        print(f"[watchdog] Task errored. Retry {retry_count}/{MAX_RETRIES}...")
                        # Clear error status before retry
                        state["status"] = "running"
                        state["error"] = None
                        try:
                            save_task_state(state)
                        except Exception as e:
                            print(f"[warn] Could not clear error state: {e}")
                        iteration = state.get("iteration", 1)
                        waiting_for_new_run, wait_start = redispatch_runner(iteration, run_id)
                        time.sleep(POLL_INTERVAL)
                        continue
                    else:
                        print(f"\n❌ Max retries exhausted ({MAX_RETRIES}).")
                        return

                # Status is 'pending' or 'running' but the run completed —
                # the runner may have crashed before updating state.
                if task_status in ("pending", "running"):
                    if run_conclusion in ("failure", "cancelled", "timed_out"):
                        retry_count += 1
                        print(f"[watchdog] Task stuck at '{task_status}' and run {run_conclusion}. Retry {retry_count}/{MAX_RETRIES}...")
                        if retry_count <= MAX_RETRIES:
                            iteration = state.get("iteration", 1)
                            waiting_for_new_run, wait_start = redispatch_runner(iteration, run_id)
                            time.sleep(POLL_INTERVAL)
                            continue
                        else:
                            state["status"] = "error"
                            state["error"] = f"Runner crashed ({run_conclusion}) after {MAX_RETRIES} retries"
                            try:
                                save_task_state(state)
                            except Exception:
                                pass
                            print(f"\n❌ Max retries exhausted.")
                            return
                    elif run_conclusion == "success":
                        # Runner succeeded but state not updated — wait and recheck
                        print("[watchdog] Run succeeded but state still pending/running. Rechecking in 15s...")
                        time.sleep(15)
                        continue

            # Run completed but no state at all — check conclusion
            if run_conclusion in ("failure", "cancelled", "timed_out"):
                retry_count += 1
                if retry_count <= MAX_RETRIES:
                    print(f"[watchdog] Run failed ({run_conclusion}), no state found. Retry {retry_count}/{MAX_RETRIES}...")
                    iteration = (state.get("iteration", 1) if state else 1)
                    waiting_for_new_run, wait_start = redispatch_runner(iteration, run_id)
                    time.sleep(POLL_INTERVAL)
                    continue
                else:
                    print(f"\n❌ Max retries exhausted after {run_conclusion}.")
                    if state:
                        state["status"] = "error"
                        state["error"] = f"Workflow {run_conclusion} after {MAX_RETRIES} retries"
                        try:
                            save_task_state(state)
                        except Exception:
                            pass
                    return

            if run_conclusion == "success":
                # Success but task not completed/continuation — might be a race.
                print("[watchdog] Run succeeded but state unclear. Rechecking in 15s...")
                time.sleep(15)
                state = load_task_state()
                if state and state.get("status") == "completed":
                    # Don't return early — let next poll iteration handle evaluation
                    print("[watchdog] State now shows completed. Will evaluate on next poll...")
                elif state and state.get("status") == "continuation":
                    next_iter = state.get("iteration", 1) + 1
                    waiting_for_new_run, wait_start = redispatch_runner(next_iter, run_id)
                    continue
                else:
                    status_str = state.get('status', 'unknown') if state else 'no state'
                    print(f"[watchdog] State still '{status_str}'. Will keep polling...")

        sys.stdout.flush()
        time.sleep(POLL_INTERVAL)

    # Approaching watchdog time limit — self-heal
    print(f"\n⏰ Watchdog time limit approaching ({time_remaining():.0f}s left).")
    print("[watchdog] Dispatching continuation watchdog...")
    try:
        dispatch_watchdog_continuation()
    except Exception as e:
        print(f"[error] Failed to dispatch continuation watchdog: {e}")
    print("[watchdog] Exiting. New watchdog will take over.")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[fatal] Watchdog unhandled exception: {e}", file=sys.stderr)
        traceback.print_exc()
        # Try to self-heal — dispatch another watchdog
        try:
            dispatch_watchdog_continuation()
            print("[watchdog] Self-healed: dispatched continuation watchdog.")
        except Exception:
            print("[watchdog] Self-heal failed.", file=sys.stderr)
        sys.exit(1)
