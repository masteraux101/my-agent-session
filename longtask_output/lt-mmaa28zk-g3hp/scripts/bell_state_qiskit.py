import qiskit
from qiskit import QuantumCircuit
from qiskit.primitives import Sampler

def create_bell_state():
    """
    Generates a Bell State |Φ+> = (|00> + |11>) / sqrt(2)
    using Qiskit 2.0+ syntax.
    """
    # Create a Quantum Circuit with 2 qubits and 2 classical bits
    qc = QuantumCircuit(2)

    # Add a Hadamard gate on qubit 0
    qc.h(0)
    # Add a CX (CNOT) gate on control qubit 0 and target qubit 1
    qc.cx(0, 1)
    
    # Measure both qubits
    qc.measure_all()

    print("--- Qiskit Bell State Circuit ---")
    print(qc.draw(output='text'))

    # Execute using the latest Sampler primitive
    sampler = Sampler()
    job = sampler.run(qc)
    result = job.result()

    print(f"Quasi-probability distribution: {result.quasi_dists}")
    return result

if __name__ == "__main__":
    create_bell_state()
