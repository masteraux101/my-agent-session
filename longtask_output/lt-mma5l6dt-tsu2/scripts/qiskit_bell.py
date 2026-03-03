from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator
from qiskit.visualization import plot_histogram

def create_bell_state():
    # Create a Quantum Circuit with 2 qubits and 2 classical bits
    qc = QuantumCircuit(2, 2)
    
    # Add a H gate on qubit 0
    qc.h(0)
    # Add a CX (CNOT) gate on control qubit 0 and target qubit 1
    qc.cx(0, 1)
    
    # Map the quantum measurement to the classical bits
    qc.measure([0, 1], [0, 1])
    
    # Use AerSimulator
    simulator = AerSimulator()
    job = simulator.run(qc, shots=1024)
    result = job.result()
    
    # Get counts
    counts = result.get_counts(qc)
    return counts

if __name__ == "__main__":
    print("Running Qiskit Bell State...")
    try:
        counts = create_bell_state()
        print(f"Results: {counts}")
    except Exception as e:
        print(f"Error running Qiskit: {e}")
