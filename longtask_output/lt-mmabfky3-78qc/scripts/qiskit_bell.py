from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator
from qiskit.visualization import plot_histogram

def generate_bell_state():
    # Create a Quantum Circuit with 2 qubits
    qc = QuantumCircuit(2)
    # Apply H gate to the first qubit
    qc.h(0)
    # Apply CNOT gate
    qc.cx(0, 1)
    # Measure
    qc.measure_all()
    
    # Run on simulator
    simulator = AerSimulator()
    result = simulator.run(qc).result()
    counts = result.get_counts()
    return counts

if __name__ == "__main__":
    try:
        print("Running Qiskit Bell State...")
        counts = generate_bell_state()
        print(f"Results: {counts}")
    except Exception as e:
        print(f"Qiskit Error: {e}")
