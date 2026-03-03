import qiskit
from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator
from qiskit.visualization import plot_histogram

def run_bell_state():
    print(f"--- Qiskit Version: {qiskit.__version__} ---")
    # Create a Bell state: |00> + |11> / sqrt(2)
    qc = QuantumCircuit(2)
    qc.h(0)
    qc.cx(0, 1)
    qc.measure_all()

    # Use AerSimulator (Standard in 2025/2026)
    simulator = AerSimulator()
    result = simulator.run(qc, shots=1024).result()
    counts = result.get_counts()
    print(f"Counts: {counts}")
    return counts

if __name__ == "__main__":
    try:
        run_bell_state()
    except Exception as e:
        print(f"Qiskit Execution Error: {e}")
