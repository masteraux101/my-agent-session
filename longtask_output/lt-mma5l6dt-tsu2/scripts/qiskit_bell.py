import qiskit
from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator
from qiskit.visualization import plot_histogram

def create_bell_state():
    # In Qiskit 1.x/2026 style, we use Primitives
    qc = QuantumCircuit(2)
    qc.h(0)
    qc.cx(0, 1)
    qc.measure_all()
    
    print("--- Qiskit Bell State Circuit ---")
    print(qc.draw(output='text'))
    
    # Execution using AerSimulator (Local)
    backend = AerSimulator()
    job = backend.run(qc, shots=1024)
    result = job.result()
    counts = result.get_counts()
    
    print(f"Results: {counts}")
    return counts

if __name__ == "__main__":
    create_bell_state()
