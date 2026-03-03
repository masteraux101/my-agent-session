from qiskit import QuantumCircuit
from qiskit.quantum_info import Statevector
from qiskit_aer import AerSimulator

def generate_bell_state():
    # Create a Quantum Circuit with 2 qubits
    qc = QuantumCircuit(2)
    
    # Apply Hadamard gate to the first qubit
    qc.h(0)
    # Apply CNOT gate with control qubit 0 and target qubit 1
    qc.cx(0, 1)
    
    # Measure (Implicit for statevector, explicit for simulator)
    qc.measure_all()
    
    print("--- Qiskit Bell State Circuit ---")
    print(qc.draw(output='text'))
    
    # Execute using Aer Simulator
    backend = AerSimulator()
    job = backend.run(qc, shots=1024)
    result = job.result()
    counts = result.get_counts()
    
    print("\nExecution Results (Counts):")
    print(counts)

if __name__ == "__main__":
    try:
        generate_bell_state()
    except Exception as e:
        print(f"ERROR: {e}")
