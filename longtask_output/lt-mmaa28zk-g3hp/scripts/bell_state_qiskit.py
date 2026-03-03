"""
Bell State Generation - Qiskit (2026 Standard)
Using Qiskit Primitives for execution.
"""
from qiskit import QuantumCircuit
from qiskit.primitives import Sampler

def create_bell_state():
    # Create a Quantum Circuit with 2 qubits
    qc = QuantumCircuit(2)
    
    # Apply H gate to qubit 0
    qc.h(0)
    # Apply CNOT gate with control 0 and target 1
    qc.cx(0, 1)
    
    # Add measurement
    qc.measure_all()
    
    print("--- Qiskit Bell State Circuit ---")
    print(qc.draw(output='text'))
    
    # Execute using Sampler (2026 standard primitive)
    sampler = Sampler()
    job = sampler.run(qc)
    result = job.result()
    
    print(f"Quasi-distribution: {result.quasi_dists[0]}")
    return result

if __name__ == "__main__":
    create_bell_state()
