# 2026 Quantum SDK Documentation Review

## 1. Qiskit (IBM)
- **Latest Version:** 2.x (Hypothetical 2026) / 1.12+ (Actual Current Trend)
- **Key Changes:** Deprecation of `qiskit.execute`. Shift to `qiskit-ibm-runtime` for all hardware access. Integration of AI-assisted circuit optimization (Qiskit Transpiler Service).
- **Readability:** High. Transition to "Primitives" (Sampler/Estimator) is well-documented but has a steep learning curve for beginners compared to the old API.

## 2. Cirq (Google)
- **Latest Version:** 1.5+
- **Key Changes:** Stronger focus on FSim gates and hardware-specific topologies for Sycamore processors. Improved `cirq-ft` for fault-tolerant algorithm research.
- **Readability:** Moderate. Documentation is very "physicist-friendly" but can be fragmented between core Cirq and its various sub-packages.

## 3. Q# (Microsoft)
- **Latest Version:** Azure Quantum Development Kit (Modern Q#)
- **Key Changes:** Complete rewrite in Rust. No longer dependent on .NET. Can be run directly in the browser or via a lightweight Python package.
- **Readability:** Improved significantly. The new VS Code extension provides real-time resource estimation, which is a unique feature in 2026.
