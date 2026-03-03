# 2026 Quantum Frameworks Evaluation

This repository contains a comparative analysis of three major quantum computing frameworks: **Qiskit**, **Cirq**, and **Q# (Azure Quantum Development Kit)**.

## Repository Structure
- `/scripts`: Python and Q# scripts to generate a Bell State ($| \Phi^+ \rangle = \frac{|00\rangle + |11\rangle}{\sqrt{2}}$).
- `/logs`: Detailed installation and execution logs recorded during testing.
- `/analysis`: 
    - `github_activity.md`: Analysis of community health and Issue activity.
    - `technical_comparison.md`: Deep dive into syntax and API changes.
    - `final_report.md`: Executive summary and final verdict.

## Key Findings (2026)
1. **Qiskit** has transitioned fully to a "Primitive-first" architecture, deprecating old backend calls.
2. **Cirq** remains the choice for researchers needing fine-grained gate timing and noise modeling.
3. **Q#** has been reborn as a lightweight, high-performance language with a Rust-based backend, moving away from its heavy .NET origins.

## How to Run
1. Install dependencies: `pip install qiskit cirq qsharp`
2. Run Qiskit: `python scripts/bell_state_qiskit.py`
3. Run Cirq: `python scripts/bell_state_cirq.py`
4. Run Q#: `python scripts/bell_state_qsharp.py`
