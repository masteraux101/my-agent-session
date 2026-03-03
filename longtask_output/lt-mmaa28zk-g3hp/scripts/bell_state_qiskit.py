"""
Bell State Generation in Qiskit (2026 Standard)
Generates the state: (|00> + |11>) / sqrt(2)
"""
from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator

def run_bell_state():
    # Initialize a 2-qubit circuit
    qc = QuantumCircuit(2)
    
    # Apply Hadamard to qubit 0
    qc.h(0)
    # Apply CNOT with control 0 and target 1
    qc.cx(0, 1)
    
    # Measure both qubits
    qc.measure_all()
    
    # Execute using Aer Simulator
    simulator = AerSimulator()
    job = simulator.run(qc, shots=1024)
    result = job.result()
    counts = result.get_counts()
    
    print("Qiskit Bell State Execution Results:")
    print(counts)

if __name__ == "__main__":
    run_bell_state()
