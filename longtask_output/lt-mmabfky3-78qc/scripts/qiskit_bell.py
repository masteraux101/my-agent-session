import qiskit
from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator

def run_qiskit_bell():
    print("--- Qiskit Bell State ---")
    try:
        # Create circuit
        qc = QuantumCircuit(2)
        qc.h(0)
        qc.cx(0, 1)
        qc.measure_all()
        
        # Simulate
        simulator = AerSimulator()
        job = simulator.run(qc, shots=1000)
        result = job.result()
        counts = result.get_counts()
        print(f"Results: {counts}")
        return True
    except Exception as e:
        print(f"Qiskit Error: {e}")
        return False

if __name__ == "__main__":
    run_qiskit_bell()
