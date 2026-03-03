from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator

def run_bell_state():
    # Create a Quantum Circuit with 2 qubits
    qc = QuantumCircuit(2)
    # Apply H gate to qubit 0
    qc.h(0)
    # Apply CNOT gate (control: 0, target: 1)
    qc.cx(0, 1)
    # Measure all qubits
    qc.measure_all()

    # Use Aer's simulator
    simulator = AerSimulator()
    job = simulator.run(qc, shots=1024)
    result = job.result()

    # Get counts
    counts = result.get_counts(qc)
    print(f"Qiskit Bell State Counts: {counts}")

if __name__ == "__main__":
    try:
        run_bell_state()
    except Exception as e:
        print(f"Qiskit Execution Error: {e}")
