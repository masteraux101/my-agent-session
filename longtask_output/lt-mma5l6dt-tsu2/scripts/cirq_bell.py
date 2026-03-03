import cirq

# Create qubits and circuit
q0, q1 = cirq.LineQubit.range(2)
circuit = cirq.Circuit(
    cirq.H(q0),
    cirq.CNOT(q0, q1),
    cirq.measure(q0, q1, key='result')
)

# Simulate
simulator = cirq.Simulator()
result = simulator.run(circuit, repetitions=1024)
counts = result.histogram(key='result')

print(f"Cirq Bell State Results: {counts}")
