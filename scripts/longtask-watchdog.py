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

# ── Config ──────────────────────────────────────────────────────────
TASK_ID            = os.environ.get("TASK_ID", "")
GITHUB_TOKEN       = os.environ.get("GITHUB_TOKEN", "")
REPO_FULL          = os.environ.get("REPO_FULL", "")
TARGET_WORKFLOW    = os.environ.get("TARGET_WORKFLOW", "")
WATCHDOG_WORKFLOW  = os.environ.get("WATCHDOG_WORKFLOW", "")
LONGTASK_KEY       = os.environ.get("LONGTASK_KEY", "")
MAX_RETRIES        = int(os.environ.get("MAX_RETRIES", "3"))
POLL_INTERVAL      = int(os.environ.get("POLL_INTERVAL", "30"))
MAX_RUNTIME        = int(os.environ.get("MAX_RUNTIME_MINUTES", "340")) * 60
START_TIME         = time.time()
STATE_DIR          = "longtask_state"
STATE_FILE         = f"{STATE_DIR}/{TASK_ID}.enc"
API_BASE           = "https://api.github.com"

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

def save_task_state(state):
    encrypted = encrypt_state(LONGTASK_KEY, json.dumps(state))
    url = f"{API_BASE}/repos/{REPO_FULL}/contents/{STATE_FILE}"
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
    gh_request("PUT", url, payload)

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
    waiting_for_new_run = False
    wait_start = None

    while should_continue():
        # 1. Check task state — if completed, we're done
        state = load_task_state()
        if state:
            status = state.get("status", "")
            print(f"[state] Task status: {status}, progress: {state.get('progress', 0)}%, "
                  f"step: {state.get('currentStep', 0)}")

            if status == "completed":
                print("\n✅ Task is completed! Watchdog exiting.")
                return

            if status == "error" and retry_count >= MAX_RETRIES:
                print(f"\n❌ Task errored and max retries ({MAX_RETRIES}) exhausted.")
                return

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

        # Track if this is a new run
        if last_seen_run_id != run_id:
            last_seen_run_id = run_id
            waiting_for_new_run = False
            retry_count_for_this_run = 0
            print(f"[watchdog] Tracking run #{run_id} ({run_status})")

        # 3. Handle different run states
        if run_status in ("queued", "in_progress"):
            print(f"[watchdog] Run #{run_id} is {run_status}. Waiting...")
            time.sleep(POLL_INTERVAL)
            continue

        if run_status == "completed":
            print(f"[watchdog] Run #{run_id} completed with conclusion: {run_conclusion}")

            # Re-read state after completion
            time.sleep(5)  # Give git push a moment
            state = load_task_state()

            if state:
                task_status = state.get("status", "")

                if task_status == "completed":
                    print("\n✅ Task completed successfully!")
                    return

                if task_status == "continuation":
                    # Task needs more time — dispatch next iteration
                    next_iter = state.get("iteration", 1) + 1
                    print(f"[watchdog] Task needs continuation. Dispatching iteration {next_iter}...")
                    dispatch_target(next_iter)
                    waiting_for_new_run = True
                    wait_start = time.time()
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
                        dispatch_target(iteration)
                        waiting_for_new_run = True
                        wait_start = time.time()
                        time.sleep(POLL_INTERVAL)
                        continue
                    else:
                        print(f"\n❌ Max retries exhausted ({MAX_RETRIES}).")
                        return

            # Run completed but no clear state — check conclusion
            if run_conclusion in ("failure", "cancelled", "timed_out"):
                retry_count += 1
                if retry_count <= MAX_RETRIES:
                    print(f"[watchdog] Run failed ({run_conclusion}). Retry {retry_count}/{MAX_RETRIES}...")
                    iteration = (state.get("iteration", 1) if state else 1)
                    dispatch_target(iteration)
                    waiting_for_new_run = True
                    wait_start = time.time()
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
                # Re-check state after a delay
                print("[watchdog] Run succeeded but state unclear. Rechecking in 30s...")
                time.sleep(30)
                state = load_task_state()
                if state and state.get("status") == "completed":
                    print("\n✅ Task completed!")
                    return
                elif state and state.get("status") == "continuation":
                    next_iter = state.get("iteration", 1) + 1
                    dispatch_target(next_iter)
                    waiting_for_new_run = True
                    wait_start = time.time()
                    continue
                else:
                    print("[watchdog] State still unclear. Waiting for next poll...")

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
