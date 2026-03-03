"""
Bell State Generation - Qiskit 1.x Implementation (2026 Standard)
Uses the Primitives V2 API.
"""
from qiskit import QuantumCircuit
from qiskit.primitives import StatevectorSampler

def create_bell_state():
    # Create a circuit with 2 qubits and 2 classical bits
    qc = QuantumCircuit(2)
    
    # Apply Hadamard to qubit 0
    qc.h(0)
    # Apply CNOT with control 0 and target 1
    qc.cx(0, 1)
    
    # Measure both qubits
    qc.measure_all()
    
    print("--- Qiskit Circuit ---")
    print(qc.draw(output='text'))
    
    # Execute using Sampler (Modern 2026 approach)
    sampler = StatevectorSampler()
    job = sampler.run([qc])
    result = job.result()[0]
    
    # Get counts
    counts = result.data.meas.get_counts()
    print(f"\nResults: {counts}")

if __name__ == "__main__":
    create_bell_state()
