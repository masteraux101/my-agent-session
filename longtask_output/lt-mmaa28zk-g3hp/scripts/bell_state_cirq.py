import cirq

def create_bell_state():
    """
    Generates a Bell State |Φ+> using Cirq.
    """
    # Define two qubits
    q0, q1 = cirq.LineQubit.range(2)

    # Create a circuit
    circuit = cirq.Circuit(
        cirq.H(q0),             # Hadamard gate on q0
        cirq.CNOT(q0, q1),      # CNOT gate with q0 as control
        cirq.measure(q0, q1, key='result') # Measure both
    )

    print("--- Cirq Bell State Circuit ---")
    print(circuit)

    # Simulate the circuit
    simulator = cirq.Simulator()
    result = simulator.run(circuit, repetitions=1000)

    print("\nMeasurement Results:")
    print(result.histogram(key='result'))
    return result

if __name__ == "__main__":
    create_bell_state()
