# 2026 GitHub Ecosystem Analysis

## Framework Vitality Metrics (Simulated 2026 Data)

| Metric | Qiskit | Cirq | Q# (Modern QDK) |
| :--- | :--- | :--- | :--- |
| **Stars** | 14.2k | 5.1k | 3.8k |
| **Open Issues** | 420 | 210 | 115 |
| **Issue Resolution Time** | ~4 days | ~12 days | ~6 days |
| **Top Label** | `primitives-v2` | `hardware-constraints` | `resource-estimation` |
| **Community Sentiment** | Highly Collaborative | Academic/Research | Professional/Enterprise |

## Common Developer Pain Points

### Qiskit
- **The "V2 Shift":** Developers still struggle with migrating legacy `execute()` calls to the new `Sampler/Estimator` patterns.
- **Backend Congestion:** Many issues relate to queue management on IBM Quantum Platform rather than the code itself.

### Cirq
- **Abstraction Gap:** Users find the jump from basic gates to complex sub-circuits (using `protocols`) steep.
- **Dependency Hell:** Frequent updates to `OpenFermion` and `Stim` often cause temporary breakage in Cirq environments.

### Q#
- **Type System Rigidity:** Developers coming from Python find Q#'s strict typing and ownership model (borrowed from Rust) challenging.
- **Local Simulation Limits:** As algorithms get larger, the gap between local sparse-state simulators and Azure Quantum's cloud estimators becomes a point of confusion.
