from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator
from qiskit.visualization import plot_histogram

def create_bell_state():
    # Create a Quantum Circuit acting on a quantum register of two qubits
    circ = QuantumCircuit(2)
    # Add a H gate on qubit 0, putting this qubit in superposition.
    circ.h(0)
    # Add a CX (CNOT) gate on control qubit 0 and target qubit 1, putting 
    # the qubits in an entangled state.
    circ.cx(0, 1)
    # Measure both qubits
    circ.measure_all()
    
    # Use Aer's statevector simulator
    simulator = AerSimulator()
    job = simulator.run(circ, shots=1024)
    result = job.result()
    counts = result.get_counts(circ)
    return counts

if __name__ == "__main__":
    try:
        print("Running Qiskit Bell State...")
        counts = create_bell_state()
        print(f"Results: {counts}")
    except Exception as e:
        print(f"Qiskit Error: {e}")
