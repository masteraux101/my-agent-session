# Research Summary: 2026 Framework Landscape

### 1. Qiskit (IBM)
- **Status:** Post-1.0 stability. IBM's roadmap emphasizes "Quantum Serverless" and the integration of the `Qiskit Runtime`.
- **Key Change:** Removal of legacy `qiskit-terra` structures in favor of a modularized `qiskit` package. Heavy emphasis on primitives (`Sampler`, `Estimator`).

### 2. Cirq (Google)
- **Status:** Remains the research-heavy choice. 
- **Key Change:** Enhanced support for FSim gates and noise modeling specifically tuned for the latest Sycamore iterations. Documentation has moved towards a more "functional" style.

### 3. Q# / Modern QDK (Microsoft)
- **Status:** Fully transitioned to the "Modern QDK." 
- **Key Change:** Elimination of the heavy Visual Studio requirement. Now runs via a lightweight VS Code extension or a standalone Rust-based CLI. Focuses on "Resource Estimation" for Fault-Tolerant Quantum Computing (FTQC).
