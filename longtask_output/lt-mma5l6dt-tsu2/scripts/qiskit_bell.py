from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator

# Create a Bell State circuit
qc = QuantumCircuit(2)
qc.h(0)
qc.cx(0, 1)
qc.measure_all()

# Execute using the latest Aer simulator
sim = AerSimulator()
result = sim.run(qc, shots=1024).result()
counts = result.get_counts()

print(f"Qiskit Bell State Results: {counts}")
