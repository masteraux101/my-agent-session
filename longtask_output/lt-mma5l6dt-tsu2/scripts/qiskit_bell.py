"""
Qiskit 1.x Bell State Generation
Following 2026 Primitives Standard
"""
from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator
from qiskit.primitives import Sampler
from qiskit.visualization import plot_histogram

def create_bell_state():
    # Create a circuit with 2 qubits and 2 classical bits
    qc = QuantumCircuit(2)
    qc.h(0)           # Hadamard gate on qubit 0
    qc.cx(0, 1)       # CNOT gate with control 0 and target 1
    qc.measure_all()  # Measure all qubits
    
    print("--- Qiskit Bell State Circuit ---")
    print(qc)
    
    # Use the Modern Sampler Primitive
    sampler = Sampler()
    job = sampler.run(qc)
    result = job.result()
    
    print(f"Quasi-probability distribution: {result.quasi_dists[0]}")
    return result

if __name__ == "__main__":
    create_bell_state()
